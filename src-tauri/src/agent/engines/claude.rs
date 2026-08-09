use super::{engine_command, load_session, save_session, EngineTurnResult, TextDeltaBatch};
use crate::agent::process::{spawn_managed, ProcessFrame, ProcessIo};
use crate::agent::protocol::{
  ActiveTurnInfo, AgentEventPayload, InteractionChoice,
};
use crate::agent::supervisor::AgentSupervisor;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

fn send_json(sender: &mpsc::SyncSender<Vec<u8>>, value: Value) -> Result<(), String> {
  let mut bytes = serde_json::to_vec(&value).map_err(|error| format!("encode Claude input: {error}"))?;
  bytes.push(b'\n');
  sender.send(bytes).map_err(|_| "Claude stdin is closed".into())
}

fn receive_json(io: &ProcessIo, timeout: Duration) -> Result<Option<Value>, String> {
  match io.stdout.recv_timeout(timeout) {
    Ok(ProcessFrame::Line(line)) => serde_json::from_str(&line)
      .map(Some)
      .map_err(|error| format!("invalid Claude stream JSON frame: {error}")),
    Ok(ProcessFrame::Oversized) => Err("Claude emitted an oversized protocol frame".into()),
    Ok(ProcessFrame::IoError(error)) => Err(format!("Claude stdout failed: {error}")),
    Ok(ProcessFrame::Eof) => {
      let detail = io.stderr_tail();
      Err(if detail.is_empty() { "Claude exited before returning a result".into() }
        else { format!("Claude exited before returning a result: {detail}") })
    }
    Err(RecvTimeoutError::Timeout) => Ok(None),
    Err(RecvTimeoutError::Disconnected) => Err("Claude stdout disconnected".into()),
  }
}

fn compact(value: &Value) -> String {
  let text = value.to_string();
  let compact = text.chars().take(600).collect::<String>();
  if compact.len() < text.len() { format!("{compact}…") } else { text }
}

fn control_prompt(request: &Value) -> String {
  let title = request.get("title").and_then(Value::as_str).unwrap_or_default();
  let description = request.get("description").and_then(Value::as_str).unwrap_or_default();
  let message = request.get("message").and_then(Value::as_str).unwrap_or_default();
  let tool = request.get("display_name").and_then(Value::as_str)
    .or_else(|| request.get("tool_name").and_then(Value::as_str))
    .unwrap_or_default();
  let reason = request.get("decision_reason").and_then(Value::as_str).unwrap_or_default();
  let url = request.get("url").and_then(Value::as_str).unwrap_or_default();
  let parts = [title, description, message, tool, reason, url]
    .into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>();
  if parts.is_empty() { compact(request) } else { parts.join("\n") }
}

fn control_choices(request: &Value) -> Vec<InteractionChoice> {
  match request.get("subtype").and_then(Value::as_str).unwrap_or_default() {
    "can_use_tool" if request.get("requires_user_interaction").and_then(Value::as_bool) == Some(true) => Vec::new(),
    "can_use_tool" => {
      let mut choices = vec![InteractionChoice {
        value: "allow".into(), label: "Allow once".into(), description: String::new(),
      }];
      if request.get("suppress_always_allow_rule").and_then(Value::as_bool) != Some(true)
        && request.get("permission_suggestions").and_then(Value::as_array).is_some_and(|items| !items.is_empty())
      {
        choices.push(InteractionChoice {
          value: "allowAlways".into(),
          label: "Allow and remember".into(),
          description: "Apply Claude Code's exact permission suggestions".into(),
        });
      }
      choices.push(InteractionChoice {
        value: "deny".into(), label: "Deny".into(), description: String::new(),
      });
      choices
    }
    "elicitation" => vec![
      InteractionChoice { value: "accept".into(), label: "Submit".into(), description: String::new() },
      InteractionChoice { value: "decline".into(), label: "Decline".into(), description: String::new() },
    ],
    _ => Vec::new(),
  }
}

fn native_control_response(request: &Value, response: crate::agent::protocol::InteractionResponse) -> Value {
  if let Some(payload) = response.payload {
    return payload;
  }
  match request.get("subtype").and_then(Value::as_str).unwrap_or_default() {
    "can_use_tool" => {
      let tool_use_id = request.get("tool_use_id").cloned().unwrap_or(Value::Null);
      if !response.cancelled && matches!(response.value.as_deref(), Some("allow") | Some("allowAlways")) {
        let mut result = json!({
          "behavior": "allow",
          "toolUseID": tool_use_id,
          "decisionClassification": if response.value.as_deref() == Some("allowAlways") {
            "user_permanent"
          } else {
            "user_temporary"
          }
        });
        if response.value.as_deref() == Some("allowAlways") {
          if let Some(suggestions) = request.get("permission_suggestions") {
            result["updatedPermissions"] = suggestions.clone();
          }
        }
        result
      } else {
        json!({
          "behavior": "deny",
          "message": "Denied by the reader",
          "toolUseID": tool_use_id,
          "decisionClassification": "user_reject"
        })
      }
    }
    "elicitation" => json!({
      "action": if response.cancelled { "cancel" } else if response.value.as_deref() == Some("accept") { "accept" } else { "decline" }
    }),
    "request_user_dialog" => json!({ "behavior": "cancelled" }),
    _ => json!({ "behavior": "cancelled" }),
  }
}

fn initialize_bidirectional(
  io: &ProcessIo,
  cancel: &mpsc::Receiver<()>,
) -> Result<(), String> {
  let request_id = Uuid::new_v4().to_string();
  send_json(&io.stdin, json!({
    "type": "control_request",
    "request_id": request_id,
    "request": { "subtype": "initialize" }
  }))?;
  let deadline = Instant::now() + Duration::from_secs(10);
  loop {
    if cancel.try_recv().is_ok() {
      let _ = send_json(&io.stdin, json!({
        "type": "control_request",
        "request_id": Uuid::new_v4().to_string(),
        "request": { "subtype": "interrupt" }
      }));
      return Err("Claude turn stopped".into());
    }
    if Instant::now() >= deadline {
      return Err("Claude Code did not complete the structured-control capability handshake".into());
    }
    let Some(value) = receive_json(io, Duration::from_millis(100))? else {
      continue;
    };
    if value.get("type").and_then(Value::as_str) != Some("control_response")
      || value.pointer("/response/request_id").and_then(Value::as_str) != Some(&request_id)
    {
      continue;
    }
    if value.pointer("/response/subtype").and_then(Value::as_str) != Some("success") {
      return Err(value.pointer("/response/error").and_then(Value::as_str)
        .unwrap_or("Claude Code rejected the structured-control handshake").into());
    }
    let has_pending = ["pending_permission_requests", "pending_user_dialog_requests"].iter().any(|field| {
      value.pointer(&format!("/response/{field}"))
        .and_then(Value::as_array).is_some_and(|requests| !requests.is_empty())
    });
    if has_pending {
      return Err("Claude resume contains an unfinished native interaction; reset the native session before sending a new message".into());
    }
    return Ok(());
  }
}

fn content_text(message: &Value) -> String {
  message.pointer("/content").and_then(Value::as_array).into_iter().flatten()
    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
    .filter_map(|block| block.get("text").and_then(Value::as_str))
    .collect::<Vec<_>>().join("")
}

fn handle_control_request(
  app: &AppHandle,
  info: &ActiveTurnInfo,
  io: &ProcessIo,
  value: &Value,
  cancel: &mpsc::Receiver<()>,
) -> Result<(), String> {
  let native_request_id = value.get("request_id").and_then(Value::as_str)
    .or_else(|| value.get("requestId").and_then(Value::as_str))
    .ok_or("Claude control request has no request id")?;
  let request_id = Uuid::new_v4().to_string();
  let request = value.get("request").cloned().unwrap_or_else(|| value.clone());
  let subtype = request.get("subtype").and_then(Value::as_str).unwrap_or_default();
  if !matches!(subtype, "can_use_tool" | "elicitation" | "request_user_dialog") {
    send_json(&io.stdin, json!({
      "type": "control_response",
      "response": {
        "subtype": "error",
        "request_id": native_request_id,
        "error": format!("LightRead does not implement Claude control request {subtype}")
      }
    }))?;
    return Ok(());
  }
  let supervisor = app.state::<AgentSupervisor>();
  let receiver = supervisor.register_interaction(&info.paper_id, &info.turn_id, request_id.clone())?;
  supervisor.record_event(app, info, AgentEventPayload::InteractionRequested {
    request_id,
    prompt: control_prompt(&request),
    choices: control_choices(&request),
    input_allowed: subtype == "elicitation"
      || (subtype == "can_use_tool" && request.get("tool_name").and_then(Value::as_str) == Some("AskUserQuestion")),
  }, Some(value.clone()))?;
  loop {
    if cancel.try_recv().is_ok() {
      let _ = send_json(&io.stdin, json!({
        "type": "control_request",
        "request_id": Uuid::new_v4().to_string(),
        "request": { "subtype": "interrupt" }
      }));
      return Err("Claude turn stopped".into());
    }
    match receiver.recv_timeout(Duration::from_millis(100)) {
      Ok(response) => {
        let native_response = native_control_response(&request, response);
        send_json(&io.stdin, json!({
          "type": "control_response",
          "response": {
            "subtype": "success",
            "request_id": native_request_id,
            "response": native_response
          }
        }))?;
        return Ok(());
      }
      Err(RecvTimeoutError::Timeout) => continue,
      Err(RecvTimeoutError::Disconnected) => return Err("Claude interaction was cancelled".into()),
    }
  }
}

fn emit_message_tools(
  app: &AppHandle,
  info: &ActiveTurnInfo,
  value: &Value,
) -> Result<(), String> {
  let supervisor = app.state::<AgentSupervisor>();
  let role = value.pointer("/message/role").and_then(Value::as_str).unwrap_or_default();
  let content = value.pointer("/message/content").and_then(Value::as_array);
  for block in content.into_iter().flatten() {
    match block.get("type").and_then(Value::as_str) {
      Some("tool_use") => {
        let tool_id = block.get("id").and_then(Value::as_str).unwrap_or("tool").to_string();
        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool").to_string();
        let summary = block.get("input").map(compact).unwrap_or_default();
        supervisor.record_event(app, info, AgentEventPayload::ToolStarted { tool_id, name, summary }, Some(value.clone()))?;
      }
      Some("tool_result") if role == "user" => {
        let tool_id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or("tool").to_string();
        let failed = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        supervisor.record_event(app, info, AgentEventPayload::ToolCompleted {
          tool_id, summary: compact(block), failed,
        }, Some(value.clone()))?;
      }
      _ => {}
    }
  }
  Ok(())
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
  let prior_session = load_session(&session_path);
  let session_id = prior_session.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
  let mut command = engine_command(executable);
  command.current_dir(workspace).args([
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
  ]);
  if prior_session.is_some() {
    command.args(["--resume", &session_id]);
  } else {
    command.args(["--session-id", &session_id]);
  }
  let io = spawn_managed(&mut command)?;
  let supervisor = app.state::<AgentSupervisor>();
  supervisor.attach_process(&info.paper_id, &info.turn_id, io.process.clone())?;
  let (cancel_sender, cancel_receiver) = mpsc::sync_channel(1);
  supervisor.attach_cancel(&info.paper_id, &info.turn_id, cancel_sender)?;
  initialize_bidirectional(&io, &cancel_receiver)?;
  send_json(&io.stdin, json!({
    "type": "user",
    "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] }
  }))?;

  let mut accumulated = String::new();
  let mut final_text = None;
  let mut text_deltas = TextDeltaBatch::new();
  loop {
    if cancel_receiver.try_recv().is_ok() {
      text_deltas.flush(app, info)?;
      let _ = send_json(&io.stdin, json!({
        "type": "control_request",
        "request_id": Uuid::new_v4().to_string(),
        "request": { "subtype": "interrupt" }
      }));
      return Err("Claude turn stopped".into());
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
      "system" => {
        if let Some(native_id) = value.get("session_id").and_then(Value::as_str) {
          save_session(&session_path, native_id)?;
          supervisor.record_event(app, info, AgentEventPayload::SessionReady { native_session_id: native_id.into() }, Some(value.clone()))?;
        }
      }
      "stream_event" => {
        let event = value.get("event").unwrap_or(&Value::Null);
        if event.get("type").and_then(Value::as_str) == Some("content_block_delta")
          && event.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta")
        {
          if let Some(delta) = event.pointer("/delta/text").and_then(Value::as_str) {
            accumulated.push_str(delta);
            text_deltas.push(app, info, delta, value.clone())?;
          }
        }
      }
      "assistant" | "user" => {
        text_deltas.flush(app, info)?;
        emit_message_tools(app, info, &value)?;
        if accumulated.is_empty() && value.get("type").and_then(Value::as_str) == Some("assistant") {
          let text = content_text(value.get("message").unwrap_or(&Value::Null));
          if !text.is_empty() {
            final_text = Some(text);
          }
        }
      }
      "control_request" => {
        text_deltas.flush(app, info)?;
        handle_control_request(app, info, &io, &value, &cancel_receiver)?;
      }
      "result" => {
        text_deltas.flush(app, info)?;
        if value.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
          return Err(value.get("result").and_then(Value::as_str).unwrap_or("Claude turn failed").into());
        }
        if let Some(result) = value.get("result").and_then(Value::as_str).filter(|value| !value.is_empty()) {
          final_text = Some(result.into());
        }
        if !accumulated.is_empty() {
          final_text = Some(accumulated);
        }
        if !session_path.exists() {
          save_session(&session_path, &session_id)?;
        }
        let native_turn_id = value.get("uuid").and_then(Value::as_str)
          .or_else(|| value.get("message_id").and_then(Value::as_str))
          .unwrap_or(&info.turn_id).to_string();
        return Ok(EngineTurnResult {
          final_text,
          native_session_id: session_id,
          native_turn_id,
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
  fn extracts_text_from_a_claude_assistant_message() {
    let message = json!({ "content": [
      { "type": "text", "text": "hello" },
      { "type": "tool_use", "id": "t1", "name": "Read", "input": {} },
      { "type": "text", "text": " world" }
    ] });
    assert_eq!(content_text(&message), "hello world");
  }

  #[test]
  fn preserves_claude_permission_suggestions_only_when_the_reader_selects_them() {
    let request = json!({
      "subtype": "can_use_tool",
      "tool_use_id": "tool-1",
      "permission_suggestions": [{
        "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "git status" }],
        "behavior": "allow", "destination": "session"
      }]
    });
    let once = native_control_response(&request, crate::agent::protocol::InteractionResponse {
      value: Some("allow".into()), ..Default::default()
    });
    assert!(once.get("updatedPermissions").is_none());
    let remembered = native_control_response(&request, crate::agent::protocol::InteractionResponse {
      value: Some("allowAlways".into()), ..Default::default()
    });
    assert_eq!(remembered.get("updatedPermissions"), request.get("permission_suggestions"));
    assert_eq!(remembered.get("toolUseID").and_then(Value::as_str), Some("tool-1"));
  }
}
