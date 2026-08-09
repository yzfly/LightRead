use super::{engine_command, load_session, save_session, EngineTurnResult, TextDeltaBatch};
use crate::agent::process::{spawn_managed, ProcessFrame, ProcessIo};
use crate::agent::protocol::{
  ActiveTurnInfo, AgentEventPayload, InteractionChoice, InteractionResponse,
};
use crate::agent::supervisor::AgentSupervisor;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

fn send_json(sender: &mpsc::SyncSender<Vec<u8>>, value: Value) -> Result<(), String> {
  let mut bytes = serde_json::to_vec(&value).map_err(|error| format!("encode Codex request: {error}"))?;
  bytes.push(b'\n');
  sender.send(bytes).map_err(|_| "Codex stdin is closed".into())
}

fn receive_json(io: &ProcessIo, timeout: Duration) -> Result<Option<Value>, String> {
  match io.stdout.recv_timeout(timeout) {
    Ok(ProcessFrame::Line(line)) => serde_json::from_str(&line)
      .map(Some)
      .map_err(|error| format!("invalid Codex JSON frame: {error}")),
    Ok(ProcessFrame::Oversized) => Err("Codex emitted an oversized protocol frame".into()),
    Ok(ProcessFrame::IoError(error)) => Err(format!("Codex stdout failed: {error}")),
    Ok(ProcessFrame::Eof) => {
      let detail = io.stderr_tail();
      Err(if detail.is_empty() { "Codex app-server exited before the turn completed".into() }
        else { format!("Codex app-server exited before the turn completed: {detail}") })
    }
    Err(RecvTimeoutError::Timeout) => Ok(None),
    Err(RecvTimeoutError::Disconnected) => Err("Codex stdout disconnected".into()),
  }
}

fn wait_response(io: &ProcessIo, id: u64) -> Result<Value, String> {
  loop {
    let Some(value) = receive_json(io, Duration::from_secs(10))? else {
      continue;
    };
    if value.get("id").and_then(Value::as_u64) == Some(id) {
      if let Some(error) = value.get("error") {
        return Err(format!("Codex request failed: {error}"));
      }
      return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
  }
}

fn compact_json(value: &Value) -> String {
  let text = value.to_string();
  let compact = text.chars().take(600).collect::<String>();
  if compact.len() < text.len() { format!("{compact}…") } else { text }
}

fn item_summary(item: &Value) -> (String, String, String) {
  let id = item.get("id").and_then(Value::as_str).unwrap_or("tool").to_string();
  let kind = item.get("type").and_then(Value::as_str).unwrap_or("tool").to_string();
  let summary = item.get("command").and_then(Value::as_str)
    .or_else(|| item.get("query").and_then(Value::as_str))
    .or_else(|| item.get("path").and_then(Value::as_str))
    .map(str::to_string)
    .unwrap_or_else(|| compact_json(item));
  (id, kind, summary)
}

fn is_tool_item(item: &Value) -> bool {
  matches!(item.get("type").and_then(Value::as_str), Some(
    "commandExecution" | "fileChange" | "mcpToolCall" | "webSearch" | "collabAgentToolCall" | "dynamicToolCall"
  ))
}

fn answer_item_started(value: &Value) -> Option<String> {
  let item = value.pointer("/params/item")?;
  if item.get("type").and_then(Value::as_str) != Some("agentMessage")
    || item.get("phase").and_then(Value::as_str) != Some("final_answer")
  {
    return None;
  }
  item.get("id").and_then(Value::as_str).map(str::to_string)
}

fn answer_delta<'a>(value: &'a Value, answer_items: &HashSet<String>) -> Option<&'a str> {
  let item_id = value.pointer("/params/itemId").and_then(Value::as_str)?;
  answer_items.contains(item_id).then(|| value.pointer("/params/delta").and_then(Value::as_str)).flatten()
}

fn approval_result(method: &str, params: &Value, response: InteractionResponse) -> Result<Value, String> {
  if let Some(payload) = response.payload {
    return Ok(payload);
  }
  if response.cancelled {
    return match method {
      "mcpServer/elicitation/request" => Ok(json!({ "action": "cancel" })),
      "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => Ok(json!({ "decision": "cancel" })),
      "applyPatchApproval" | "execCommandApproval" => Ok(json!({ "decision": "abort" })),
      _ => Err("Reader cancelled the native Agent request".into()),
    };
  }
  if method == "item/tool/requestUserInput" {
    return Err("Codex user input requires the structured answers shown by LightRead".into());
  }
  if method == "item/permissions/requestApproval" {
    return match response.value.as_deref() {
      Some("accept") => Ok(json!({ "permissions": params.get("permissions").cloned().unwrap_or_else(|| json!({})), "scope": "turn" })),
      Some("acceptForSession") => Ok(json!({ "permissions": params.get("permissions").cloned().unwrap_or_else(|| json!({})), "scope": "session" })),
      _ => Err("Reader declined the requested Codex permission profile".into()),
    };
  }
  if method == "mcpServer/elicitation/request" {
    return match response.value.as_deref() {
      Some("decline") => Ok(json!({ "action": "decline" })),
      Some("cancel") => Ok(json!({ "action": "cancel" })),
      _ => Err("MCP elicitation acceptance requires structured form content".into()),
    };
  }
  if matches!(method, "applyPatchApproval" | "execCommandApproval") {
    let decision = match response.value.as_deref().unwrap_or("decline") {
      "accept" => json!("approved"),
      "acceptForSession" => json!("approved_for_session"),
      "cancel" => json!("abort"),
      _ => json!({ "denied": { "rejection": "Declined by reader" } }),
    };
    return Ok(json!({ "decision": decision }));
  }
  let decision = match response.value.as_deref().unwrap_or("decline") {
    "accept" => "accept",
    "acceptForSession" => "acceptForSession",
    "cancel" => "cancel",
    _ => "decline",
  };
  Ok(json!({ "decision": decision }))
}

fn handle_server_request(
  app: &AppHandle,
  info: &ActiveTurnInfo,
  io: &ProcessIo,
  value: &Value,
  cancel: &mpsc::Receiver<()>,
) -> Result<(), String> {
  let method = value.get("method").and_then(Value::as_str).unwrap_or_default();
  let rpc_id = value.get("id").cloned().ok_or("Codex server request has no id")?;
  let params = value.get("params").cloned().unwrap_or(Value::Null);
  if !matches!(method,
    "item/commandExecution/requestApproval"
      | "item/fileChange/requestApproval"
      | "item/tool/requestUserInput"
      | "mcpServer/elicitation/request"
      | "item/permissions/requestApproval"
      | "applyPatchApproval"
      | "execCommandApproval"
  ) {
    send_json(&io.stdin, json!({
      "id": rpc_id,
      "error": { "code": -32601, "message": "LightRead does not provide this optional Codex client capability" }
    }))?;
    return Ok(());
  }
  let request_id = Uuid::new_v4().to_string();
  let supervisor = app.state::<AgentSupervisor>();
  let receiver = supervisor.register_interaction(&info.paper_id, &info.turn_id, request_id.clone())?;
  let choices = match method {
    "item/tool/requestUserInput" => Vec::new(),
    "mcpServer/elicitation/request" => vec![
      InteractionChoice { value: "accept".into(), label: "Submit".into(), description: String::new() },
      InteractionChoice { value: "decline".into(), label: "Decline".into(), description: String::new() },
      InteractionChoice { value: "cancel".into(), label: "Cancel".into(), description: String::new() },
    ],
    _ => vec![
      InteractionChoice { value: "accept".into(), label: "Allow once".into(), description: String::new() },
      InteractionChoice { value: "acceptForSession".into(), label: "Allow for session".into(), description: String::new() },
      InteractionChoice { value: "decline".into(), label: "Deny".into(), description: String::new() },
      InteractionChoice { value: "cancel".into(), label: "Deny and stop".into(), description: String::new() },
    ],
  };
  supervisor.record_event(
    app,
    info,
    AgentEventPayload::InteractionRequested {
      request_id,
      prompt: params.get("reason").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| compact_json(&params)),
      choices,
      input_allowed: matches!(method, "item/tool/requestUserInput" | "mcpServer/elicitation/request"),
    },
    Some(value.clone()),
  )?;
  loop {
    if cancel.try_recv().is_ok() {
      send_json(&io.stdin, json!({ "id": rpc_id, "error": { "code": -32000, "message": "Turn stopped" } }))?;
      return Err("Codex turn stopped".into());
    }
    match receiver.recv_timeout(Duration::from_millis(100)) {
      Ok(response) => match approval_result(method, &params, response) {
        Ok(result) => send_json(&io.stdin, json!({ "id": rpc_id, "result": result }))?,
        Err(message) => send_json(&io.stdin, json!({ "id": rpc_id, "error": { "code": -32001, "message": message } }))?,
      },
      Err(RecvTimeoutError::Timeout) => continue,
      Err(RecvTimeoutError::Disconnected) => return Err("Codex interaction was cancelled".into()),
    }
    return Ok(());
  }
}

fn emit_notification(
  app: &AppHandle,
  info: &ActiveTurnInfo,
  value: &Value,
  accumulated: &mut String,
  answer_items: &mut HashSet<String>,
  text_deltas: &mut TextDeltaBatch,
) -> Result<bool, String> {
  let method = value.get("method").and_then(Value::as_str).unwrap_or_default();
  let params = value.get("params").cloned().unwrap_or(Value::Null);
  let supervisor = app.state::<AgentSupervisor>();
  match method {
    "item/agentMessage/delta" => {
      if let Some(delta) = answer_delta(value, answer_items) {
        accumulated.push_str(delta);
        text_deltas.push(app, info, delta, value.clone())?;
      }
    }
    "item/started" => {
      if let Some(item_id) = answer_item_started(value) {
        answer_items.insert(item_id);
      }
      if let Some(item) = params.get("item").filter(|item| is_tool_item(item)) {
        text_deltas.flush(app, info)?;
        let (tool_id, name, summary) = item_summary(item);
        supervisor.record_event(app, info, AgentEventPayload::ToolStarted { tool_id, name, summary }, Some(value.clone()))?;
      }
    }
    "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" | "item/mcpToolCall/progress" => {
      text_deltas.flush(app, info)?;
      let tool_id = params.get("itemId").and_then(Value::as_str).unwrap_or("tool").to_string();
      let summary = params.get("delta").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| compact_json(&params));
      supervisor.record_event(app, info, AgentEventPayload::ToolUpdated { tool_id, summary }, Some(value.clone()))?;
    }
    "item/completed" => {
      if let Some(item) = params.get("item").filter(|item| {
        item.get("type").and_then(Value::as_str) == Some("agentMessage")
          && item.get("phase").and_then(Value::as_str) == Some("final_answer")
      }) {
        if let Some(item_id) = item.get("id").and_then(Value::as_str) {
          answer_items.remove(item_id);
        }
        if accumulated.is_empty() {
          if let Some(text) = item.get("text").and_then(Value::as_str).filter(|text| !text.is_empty()) {
            accumulated.push_str(text);
            text_deltas.push(app, info, text, value.clone())?;
          }
        }
      }
      if let Some(item) = params.get("item").filter(|item| is_tool_item(item)) {
        text_deltas.flush(app, info)?;
        let (tool_id, _name, summary) = item_summary(item);
        let failed = matches!(item.get("status").and_then(Value::as_str), Some("failed" | "declined"));
        supervisor.record_event(app, info, AgentEventPayload::ToolCompleted { tool_id, summary, failed }, Some(value.clone()))?;
      }
    }
    "turn/completed" => {
      text_deltas.flush(app, info)?;
      return Ok(true);
    }
    "error" => {
      text_deltas.flush(app, info)?;
      supervisor.record_event(app, info, AgentEventPayload::Error {
        message: compact_json(&params), recoverable: true,
      }, Some(value.clone()))?;
    }
    _ => {}
  }
  Ok(false)
}

pub fn run(
  app: &AppHandle,
  info: &ActiveTurnInfo,
  executable: &Path,
  workspace: &Path,
  session_dir: &Path,
  prompt: &str,
) -> Result<EngineTurnResult, String> {
  let mut command = engine_command(executable);
  command.args(["app-server", "--stdio"]).current_dir(workspace);
  let io = spawn_managed(&mut command)?;
  let supervisor = app.state::<AgentSupervisor>();
  supervisor.attach_process(&info.paper_id, &info.turn_id, io.process.clone())?;
  let (cancel_sender, cancel_receiver) = mpsc::sync_channel(1);
  supervisor.attach_cancel(&info.paper_id, &info.turn_id, cancel_sender)?;

  send_json(&io.stdin, json!({
    "id": 1,
    "method": "initialize",
    "params": {
      "clientInfo": { "name": "lightread", "title": "LightRead", "version": env!("CARGO_PKG_VERSION") },
      "capabilities": { "experimentalApi": false }
    }
  }))?;
  wait_response(&io, 1)?;
  send_json(&io.stdin, json!({ "method": "initialized", "params": {} }))?;

  let session_path = session_dir.join("session.json");
  let prior_session = load_session(&session_path);
  let thread_request = if let Some(thread_id) = prior_session.as_deref() {
    json!({ "id": 2, "method": "thread/resume", "params": { "threadId": thread_id, "cwd": workspace } })
  } else {
    json!({ "id": 2, "method": "thread/start", "params": { "cwd": workspace } })
  };
  send_json(&io.stdin, thread_request)?;
  let thread_result = wait_response(&io, 2)?;
  let thread_id = thread_result.pointer("/thread/id").and_then(Value::as_str)
    .or(prior_session.as_deref())
    .ok_or("Codex did not return a native thread id")?
    .to_string();
  save_session(&session_path, &thread_id)?;
  supervisor.record_event(app, info, AgentEventPayload::SessionReady { native_session_id: thread_id.clone() }, None)?;

  send_json(&io.stdin, json!({
    "id": 3,
    "method": "turn/start",
    "params": { "threadId": thread_id, "input": [{ "type": "text", "text": prompt }] }
  }))?;
  let turn_result = wait_response(&io, 3)?;
  let native_turn_id = turn_result.pointer("/turn/id").and_then(Value::as_str)
    .ok_or("Codex did not return a native turn id")?
    .to_string();
  let mut accumulated = String::new();
  let mut answer_items = HashSet::new();
  let mut text_deltas = TextDeltaBatch::new();
  let mut interrupt_request_id = 100_u64;
  loop {
    if cancel_receiver.try_recv().is_ok() {
      text_deltas.flush(app, info)?;
      interrupt_request_id += 1;
      send_json(&io.stdin, json!({
        "id": interrupt_request_id,
        "method": "turn/interrupt",
        "params": { "threadId": thread_id, "turnId": native_turn_id }
      }))?;
      return Err("Codex turn stopped".into());
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
    if value.get("method").is_some() && value.get("id").is_some() {
      text_deltas.flush(app, info)?;
      handle_server_request(app, info, &io, &value, &cancel_receiver)?;
      continue;
    }
    if emit_notification(app, info, &value, &mut accumulated, &mut answer_items, &mut text_deltas)? {
      return Ok(EngineTurnResult {
        final_text: Some(accumulated),
        native_session_id: thread_id,
        native_turn_id,
      });
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn recognizes_stable_codex_deltas_and_tool_items() {
    let started = json!({ "method": "item/started", "params": { "item": {
      "type": "agentMessage", "id": "answer", "phase": "final_answer"
    } } });
    let delta = json!({ "method": "item/agentMessage/delta", "params": { "itemId": "answer", "delta": "hello" } });
    let commentary = json!({ "method": "item/agentMessage/delta", "params": { "itemId": "commentary", "delta": "working" } });
    let mut answer_items = HashSet::new();
    answer_items.insert(answer_item_started(&started).unwrap());
    assert_eq!(delta.pointer("/params/delta").and_then(Value::as_str), Some("hello"));
    assert_eq!(answer_delta(&delta, &answer_items), Some("hello"));
    assert_eq!(answer_delta(&commentary, &answer_items), None);
    assert!(is_tool_item(&json!({ "type": "commandExecution" })));
    assert!(!is_tool_item(&json!({ "type": "agentMessage" })));
  }

  #[test]
  fn limits_approval_values_to_native_choices() {
    let response = approval_result("item/commandExecution/requestApproval", &Value::Null, InteractionResponse {
      value: Some("invented".into()), ..InteractionResponse::default()
    }).unwrap();
    assert_eq!(response, json!({ "decision": "decline" }));
  }

  #[test]
  fn returns_the_exact_requested_permission_profile_with_the_selected_scope() {
    let params = json!({ "permissions": { "network": { "enabled": true } } });
    let response = approval_result("item/permissions/requestApproval", &params, InteractionResponse {
      value: Some("acceptForSession".into()), ..Default::default()
    }).unwrap();
    assert_eq!(response, json!({
      "permissions": { "network": { "enabled": true } },
      "scope": "session"
    }));
  }
}
