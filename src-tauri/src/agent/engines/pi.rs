use super::{engine_command, load_session, save_session, EngineTurnResult, TextDeltaBatch};
use crate::agent::process::{spawn_managed, ProcessFrame, ProcessIo};
use crate::agent::protocol::{
  ActiveTurnInfo, AgentEventPayload, InteractionChoice,
};
use crate::agent::supervisor::AgentSupervisor;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

fn send_json(sender: &mpsc::SyncSender<Vec<u8>>, value: Value) -> Result<(), String> {
  let mut bytes = serde_json::to_vec(&value).map_err(|error| format!("encode Pi RPC command: {error}"))?;
  bytes.push(b'\n');
  sender.send(bytes).map_err(|_| "Pi stdin is closed".into())
}

fn receive_json(io: &ProcessIo, timeout: Duration) -> Result<Option<Value>, String> {
  match io.stdout.recv_timeout(timeout) {
    Ok(ProcessFrame::Line(line)) => serde_json::from_str(&line)
      .map(Some)
      .map_err(|error| format!("invalid Pi RPC JSON frame: {error}")),
    Ok(ProcessFrame::Oversized) => Err("Pi emitted an oversized protocol frame".into()),
    Ok(ProcessFrame::IoError(error)) => Err(format!("Pi stdout failed: {error}")),
    Ok(ProcessFrame::Eof) => {
      let detail = io.stderr_tail();
      Err(if detail.is_empty() { "Pi exited before the turn completed".into() }
        else { format!("Pi exited before the turn completed: {detail}") })
    }
    Err(RecvTimeoutError::Timeout) => Ok(None),
    Err(RecvTimeoutError::Disconnected) => Err("Pi stdout disconnected".into()),
  }
}

fn compact(value: &Value) -> String {
  let text = value.to_string();
  let compact = text.chars().take(600).collect::<String>();
  if compact.len() < text.len() { format!("{compact}…") } else { text }
}

fn message_text(message: &Value) -> String {
  message.get("content").and_then(Value::as_array).into_iter().flatten()
    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
    .filter_map(|block| block.get("text").and_then(Value::as_str))
    .collect::<Vec<_>>().join("")
}

fn interaction_choices(value: &Value) -> Vec<InteractionChoice> {
  value.get("options").and_then(Value::as_array).into_iter().flatten()
    .filter_map(Value::as_str)
    .map(|option| InteractionChoice { value: option.into(), label: option.into(), description: String::new() })
    .collect()
}

fn handle_extension_interaction(
  app: &AppHandle,
  info: &ActiveTurnInfo,
  io: &ProcessIo,
  value: &Value,
  cancel: &mpsc::Receiver<()>,
) -> Result<(), String> {
  let method = value.get("method").and_then(Value::as_str).unwrap_or_default();
  if !matches!(method, "select" | "confirm" | "input" | "editor") {
    return Ok(());
  }
  let native_id = value.get("id").and_then(Value::as_str).ok_or("Pi extension request has no id")?;
  let request_id = Uuid::new_v4().to_string();
  let supervisor = app.state::<AgentSupervisor>();
  let receiver = supervisor.register_interaction(&info.paper_id, &info.turn_id, request_id.clone())?;
  let choices = if method == "confirm" {
    vec![
      InteractionChoice { value: "true".into(), label: "Confirm".into(), description: String::new() },
      InteractionChoice { value: "false".into(), label: "Decline".into(), description: String::new() },
    ]
  } else {
    interaction_choices(value)
  };
  supervisor.record_event(app, info, AgentEventPayload::InteractionRequested {
    request_id,
    prompt: value.get("message").and_then(Value::as_str)
      .or_else(|| value.get("title").and_then(Value::as_str))
      .unwrap_or(method).to_string(),
    choices,
    input_allowed: matches!(method, "input" | "editor"),
  }, Some(value.clone()))?;
  loop {
    if cancel.try_recv().is_ok() {
      send_json(&io.stdin, json!({ "type": "extension_ui_response", "id": native_id, "cancelled": true }))?;
      let _ = send_json(&io.stdin, json!({ "type": "abort" }));
      return Err("Pi turn stopped".into());
    }
    match receiver.recv_timeout(Duration::from_millis(100)) {
      Ok(response) => {
        let outgoing = if response.cancelled {
          json!({ "type": "extension_ui_response", "id": native_id, "cancelled": true })
        } else if method == "confirm" {
          json!({ "type": "extension_ui_response", "id": native_id, "confirmed": response.confirmed.unwrap_or(false) })
        } else {
          json!({ "type": "extension_ui_response", "id": native_id, "value": response.value.unwrap_or_default() })
        };
        send_json(&io.stdin, outgoing)?;
        return Ok(());
      }
      Err(RecvTimeoutError::Timeout) => continue,
      Err(RecvTimeoutError::Disconnected) => return Err("Pi extension interaction was cancelled".into()),
    }
  }
}

pub fn run(
  app: &AppHandle,
  info: &ActiveTurnInfo,
  executable: &Path,
  workspace: &Path,
  session_dir: &Path,
  prompt: &str,
) -> Result<EngineTurnResult, String> {
  let session_path = session_dir.join("session.json");
  let session_id = load_session(&session_path).unwrap_or_else(|| Uuid::new_v4().to_string());
  let native_sessions = session_dir.join("native");
  std::fs::create_dir_all(&native_sessions).map_err(|error| format!("create Pi session directory: {error}"))?;
  let mut command = engine_command(executable);
  command.current_dir(workspace)
    .args(["--mode", "rpc", "--session-id", &session_id, "--session-dir"])
    .arg(&native_sessions);
  let io = spawn_managed(&mut command)?;
  let supervisor = app.state::<AgentSupervisor>();
  supervisor.attach_process(&info.paper_id, &info.turn_id, io.process.clone())?;
  let (cancel_sender, cancel_receiver) = mpsc::sync_channel(1);
  supervisor.attach_cancel(&info.paper_id, &info.turn_id, cancel_sender)?;
  save_session(&session_path, &session_id)?;
  supervisor.record_event(app, info, AgentEventPayload::SessionReady { native_session_id: session_id.clone() }, None)?;
  send_json(&io.stdin, json!({ "id": info.turn_id, "type": "prompt", "message": prompt }))?;

  let mut accumulated = String::new();
  let mut final_text = None;
  let mut text_deltas = TextDeltaBatch::new();
  loop {
    if cancel_receiver.try_recv().is_ok() {
      text_deltas.flush(app, info)?;
      let _ = send_json(&io.stdin, json!({ "type": "abort" }));
      return Err("Pi turn stopped".into());
    }
    let value = match receive_json(&io, Duration::from_millis(100)) {
      Ok(Some(value)) => value,
      Ok(None) => {
        text_deltas.flush(app, info)?;
        continue;
      }
      Err(error) => {
        text_deltas.flush(app, info)?;
        return Err(error);
      }
    };
    match value.get("type").and_then(Value::as_str).unwrap_or_default() {
      "response" => {
        if value.get("success").and_then(Value::as_bool) == Some(false) {
          return Err(value.get("error").map(compact).unwrap_or_else(|| "Pi rejected the command".into()));
        }
      }
      "message_update" => {
        let event = value.get("assistantMessageEvent").unwrap_or(&Value::Null);
        if event.get("type").and_then(Value::as_str) == Some("text_delta") {
          if let Some(delta) = event.get("delta").and_then(Value::as_str) {
            accumulated.push_str(delta);
            text_deltas.push(app, info, delta, value.clone())?;
          }
        }
      }
      "message_end" => {
        text_deltas.flush(app, info)?;
        let text = message_text(value.get("message").unwrap_or(&Value::Null));
        if !text.is_empty() {
          final_text = Some(text);
        }
      }
      "tool_execution_start" => {
        text_deltas.flush(app, info)?;
        supervisor.record_event(app, info, AgentEventPayload::ToolStarted {
          tool_id: value.get("toolCallId").and_then(Value::as_str).unwrap_or("tool").into(),
          name: value.get("toolName").and_then(Value::as_str).unwrap_or("tool").into(),
          summary: value.get("args").map(compact).unwrap_or_default(),
        }, Some(value.clone()))?;
      }
      "tool_execution_update" => {
        text_deltas.flush(app, info)?;
        supervisor.record_event(app, info, AgentEventPayload::ToolUpdated {
          tool_id: value.get("toolCallId").and_then(Value::as_str).unwrap_or("tool").into(),
          summary: value.get("partialResult").map(compact).unwrap_or_default(),
        }, Some(value.clone()))?;
      }
      "tool_execution_end" => {
        text_deltas.flush(app, info)?;
        supervisor.record_event(app, info, AgentEventPayload::ToolCompleted {
          tool_id: value.get("toolCallId").and_then(Value::as_str).unwrap_or("tool").into(),
          summary: value.get("result").map(compact).unwrap_or_default(),
          failed: value.get("isError").and_then(Value::as_bool).unwrap_or(false),
        }, Some(value.clone()))?;
      }
      "extension_ui_request" => {
        text_deltas.flush(app, info)?;
        handle_extension_interaction(app, info, &io, &value, &cancel_receiver)?;
      }
      "extension_error" => {
        text_deltas.flush(app, info)?;
        supervisor.record_event(app, info, AgentEventPayload::Error {
          message: compact(&value), recoverable: true,
        }, Some(value.clone()))?;
      }
      "agent_end" => {
        text_deltas.flush(app, info)?;
        if !accumulated.is_empty() {
          final_text = Some(accumulated);
        }
        return Ok(EngineTurnResult {
          final_text,
          native_session_id: session_id,
          native_turn_id: info.turn_id.clone(),
        });
      }
      _ => {}
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn preserves_unicode_line_separator_inside_pi_json() {
    let value: Value = serde_json::from_str("{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"a\\u2028b\"}}").unwrap();
    assert_eq!(value.pointer("/assistantMessageEvent/delta").and_then(Value::as_str), Some("a\u{2028}b"));
  }

  #[test]
  fn extracts_pi_message_text_blocks() {
    assert_eq!(message_text(&json!({ "content": [
      { "type": "text", "text": "a" },
      { "type": "thinking", "thinking": "hidden" },
      { "type": "text", "text": "b" }
    ] })), "ab");
  }
}
