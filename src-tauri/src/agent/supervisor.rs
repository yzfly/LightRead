use super::process::ManagedProcess;
use super::protocol::{
  ActiveTurnInfo, AgentEvent, AgentEventPayload, ConversationKind, EngineKind, InteractionResponse,
};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;

struct ActiveTurn {
  info: ActiveTurnInfo,
  process: Option<Arc<Mutex<ManagedProcess>>>,
  cancel: Option<mpsc::SyncSender<()>>,
}

struct PendingInteraction {
  paper_id: String,
  turn_id: String,
  sender: mpsc::SyncSender<InteractionResponse>,
}

#[derive(Default)]
struct SupervisorData {
  active: HashMap<String, ActiveTurn>,
  deleting: HashSet<String>,
  preparing: HashSet<String>,
  next_sequence: HashMap<String, u64>,
  interactions: HashMap<String, PendingInteraction>,
}

#[derive(Default)]
pub struct AgentSupervisor(Mutex<SupervisorData>);

pub(crate) fn validate_id(value: &str, label: &str) -> Result<(), String> {
  if value.is_empty()
    || value.len() > 160
    || !value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
  {
    return Err(format!("invalid {label}"));
  }
  Ok(())
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn conversation_key(
  paper_id: &str,
  engine: EngineKind,
  conversation: ConversationKind,
  conversation_id: &str,
) -> String {
  format!("{paper_id}:{}:{}:{conversation_id}", engine.as_str(), conversation.as_str())
}

fn events_path(
  app_data_dir: &Path,
  paper_id: &str,
  engine: EngineKind,
  conversation: ConversationKind,
) -> PathBuf {
  app_data_dir
    .join("paper-agents")
    .join(paper_id)
    .join("conversations")
    .join(engine.as_str())
    .join(conversation.as_str())
    .join("events.jsonl")
}

fn ensure_private_parent(path: &Path) -> Result<(), String> {
  let parent = path.parent().ok_or("event path has no parent")?;
  fs::create_dir_all(parent).map_err(|error| format!("create event directory: {error}"))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
      .map_err(|error| format!("protect event directory: {error}"))?;
  }
  Ok(())
}

fn last_sequence(path: &Path) -> u64 {
  let Ok(file) = File::open(path) else {
    return 0;
  };
  BufReader::new(file)
    .lines()
    .map_while(Result::ok)
    .filter_map(|line| serde_json::from_str::<AgentEvent>(&line).ok())
    .map(|event| event.sequence)
    .max()
    .unwrap_or(0)
}

impl AgentSupervisor {
  pub fn begin_turn(&self, info: ActiveTurnInfo) -> Result<(), String> {
    validate_id(&info.paper_id, "paper id")?;
    validate_id(&info.conversation_id, "conversation id")?;
    validate_id(&info.turn_id, "turn id")?;
    let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
    if data.deleting.contains(&info.paper_id) {
      return Err("this paper's Agent data is being deleted".into());
    }
    if data.preparing.contains(&info.paper_id) {
      return Err("this paper's Agent context is being prepared".into());
    }
    if data.active.contains_key(&info.paper_id) {
      return Err("another Agent turn is already active for this paper".into());
    }
    data.active.insert(info.paper_id.clone(), ActiveTurn { info, process: None, cancel: None });
    Ok(())
  }

  pub fn reserve_cleanup(&self, paper_id: &str) -> Result<(), String> {
    let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
    if data.active.contains_key(paper_id) {
      return Err("stop the active Agent turn before deleting its paper data".into());
    }
    if data.preparing.contains(paper_id) {
      return Err("wait for the paper Agent context update before deleting its data".into());
    }
    if !data.deleting.insert(paper_id.into()) {
      return Err("this paper's Agent data is already being deleted".into());
    }
    Ok(())
  }

  pub fn finish_cleanup(&self, paper_id: &str) {
    if let Ok(mut data) = self.0.lock() {
      data.deleting.remove(paper_id);
    }
  }

  pub fn reserve_snapshot(&self, paper_id: &str) -> Result<(), String> {
    validate_id(paper_id, "paper id")?;
    let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
    if data.deleting.contains(paper_id) {
      return Err("this paper's Agent data is being deleted".into());
    }
    if data.active.contains_key(paper_id) {
      return Err("wait for the active Agent turn before refreshing its paper context".into());
    }
    if !data.preparing.insert(paper_id.into()) {
      return Err("this paper's Agent context is already being prepared".into());
    }
    Ok(())
  }

  pub fn finish_snapshot(&self, paper_id: &str) {
    if let Ok(mut data) = self.0.lock() {
      data.preparing.remove(paper_id);
    }
  }

  pub fn attach_process(
    &self,
    paper_id: &str,
    turn_id: &str,
    process: Arc<Mutex<ManagedProcess>>,
  ) -> Result<(), String> {
    let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
    let active = data.active.get_mut(paper_id).ok_or("paper has no active Agent turn")?;
    if active.info.turn_id != turn_id {
      return Err("turn does not match the active paper turn".into());
    }
    active.process = Some(process);
    Ok(())
  }

  pub fn attach_cancel(
    &self,
    paper_id: &str,
    turn_id: &str,
    cancel: mpsc::SyncSender<()>,
  ) -> Result<(), String> {
    let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
    let active = data.active.get_mut(paper_id).ok_or("paper has no active Agent turn")?;
    if active.info.turn_id != turn_id {
      return Err("turn does not match the active paper turn".into());
    }
    active.cancel = Some(cancel);
    Ok(())
  }

  pub fn finish_turn(&self, paper_id: &str, turn_id: &str) -> Result<(), String> {
    let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
    let matches = data.active.get(paper_id).is_some_and(|turn| turn.info.turn_id == turn_id);
    if !matches {
      return Err("turn does not match the active paper turn".into());
    }
    data.active.remove(paper_id);
    data.interactions.retain(|_, interaction| {
      interaction.paper_id != paper_id || interaction.turn_id != turn_id
    });
    Ok(())
  }

  pub fn active_turn(&self, paper_id: &str) -> Option<ActiveTurnInfo> {
    self.0.lock().ok()?.active.get(paper_id).map(|turn| turn.info.clone())
  }

  pub fn stop_turn(&self, paper_id: &str, turn_id: &str) -> Result<ActiveTurnInfo, String> {
    let (info, process, cancel) = {
      let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
      let active = data.active.get_mut(paper_id).ok_or("paper has no active Agent turn")?;
      if active.info.turn_id != turn_id {
        return Err("turn does not match the active paper turn".into());
      }
      active.info.stopping = true;
      (active.info.clone(), active.process.clone(), active.cancel.clone())
    };
    if let Some(cancel) = cancel {
      let _ = cancel.try_send(());
      std::thread::sleep(std::time::Duration::from_millis(250));
    }
    if let Some(process) = process {
      process.lock().map_err(|_| "Agent process state is poisoned")?.terminate_tree()?;
    }
    let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
    data.active.remove(paper_id);
    data.interactions.retain(|_, interaction| {
      interaction.paper_id != paper_id || interaction.turn_id != turn_id
    });
    Ok(info)
  }

  pub fn register_interaction(
    &self,
    paper_id: &str,
    turn_id: &str,
    request_id: String,
  ) -> Result<mpsc::Receiver<InteractionResponse>, String> {
    validate_id(&request_id, "interaction request id")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
    let active = data.active.get(paper_id).ok_or("paper has no active Agent turn")?;
    if active.info.turn_id != turn_id {
      return Err("interaction does not match the active paper turn".into());
    }
    if data.interactions.contains_key(&request_id) {
      return Err("interaction request id is already pending".into());
    }
    data.interactions.insert(request_id, PendingInteraction {
      paper_id: paper_id.into(),
      turn_id: turn_id.into(),
      sender,
    });
    Ok(receiver)
  }

  pub fn answer_interaction(
    &self,
    paper_id: &str,
    turn_id: &str,
    request_id: &str,
    response: InteractionResponse,
  ) -> Result<(), String> {
    let interaction = {
      let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
      let pending = data.interactions.get(request_id).ok_or("interaction is no longer pending")?;
      if pending.paper_id != paper_id || pending.turn_id != turn_id {
        return Err("interaction response does not match the pending turn".into());
      }
      data.interactions.remove(request_id).expect("pending interaction disappeared while locked")
    };
    interaction.sender.try_send(response).map_err(|_| "interaction response could not be delivered".into())
  }

  pub fn stop_all(&self) {
    let turns = {
      let mut data = self.0.lock().unwrap_or_else(|error| error.into_inner());
      data.active.drain().map(|(_, turn)| turn).collect::<Vec<_>>()
    };
    for turn in &turns {
      if let Some(cancel) = &turn.cancel {
        let _ = cancel.try_send(());
      }
    }
    if turns.iter().any(|turn| turn.cancel.is_some()) {
      std::thread::sleep(std::time::Duration::from_millis(250));
    }
    for turn in turns {
      if let Some(process) = turn.process {
        let _ = process.lock().unwrap_or_else(|error| error.into_inner()).terminate_tree();
      }
    }
  }

  pub fn record_event(
    &self,
    app: &AppHandle,
    info: &ActiveTurnInfo,
    payload: AgentEventPayload,
    opaque: Option<Value>,
  ) -> Result<AgentEvent, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|error| format!("resolve application data: {error}"))?;
    self.record_event_at(app_data_dir.as_path(), info, payload, opaque, |event| {
      app.emit("paper-agent:event", event).map_err(|error| format!("emit Agent event: {error}"))
    })
  }

  fn record_event_at<F>(
    &self,
    app_data_dir: &Path,
    info: &ActiveTurnInfo,
    payload: AgentEventPayload,
    opaque: Option<Value>,
    emit: F,
  ) -> Result<AgentEvent, String>
  where
    F: FnOnce(&AgentEvent) -> Result<(), String>,
  {
    let path = events_path(app_data_dir, &info.paper_id, info.engine, info.conversation);
    ensure_private_parent(&path)?;
    let key = conversation_key(&info.paper_id, info.engine, info.conversation, &info.conversation_id);
    let sequence = {
      let mut data = self.0.lock().map_err(|_| "Agent supervisor state is poisoned")?;
      let entry = data.next_sequence.entry(key).or_insert_with(|| last_sequence(&path) + 1);
      let sequence = *entry;
      *entry = entry.saturating_add(1);
      sequence
    };
    let event = AgentEvent {
      paper_id: info.paper_id.clone(),
      engine: info.engine,
      conversation: info.conversation,
      conversation_id: info.conversation_id.clone(),
      turn_id: info.turn_id.clone(),
      sequence,
      context_revision: info.context_revision.clone(),
      timestamp_ms: now_ms(),
      payload,
      opaque,
    };
    let encoded = serde_json::to_vec(&event).map_err(|error| format!("encode Agent event: {error}"))?;
    if encoded.len() > MAX_EVENT_BYTES {
      return Err("Agent event exceeds the persistence limit".into());
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path)
      .map_err(|error| format!("open Agent event log: {error}"))?;
    file.write_all(&encoded).and_then(|_| file.write_all(b"\n")).and_then(|_| file.flush())
      .map_err(|error| format!("persist Agent event: {error}"))?;
    emit(&event)?;
    Ok(event)
  }
}

fn replay_events_at(
  app_data_dir: &Path,
  paper_id: &str,
  engine: EngineKind,
  conversation: ConversationKind,
  after_sequence: u64,
) -> Result<Vec<AgentEvent>, String> {
  validate_id(paper_id, "paper id")?;
  let path = events_path(app_data_dir, paper_id, engine, conversation);
  let Ok(file) = File::open(path) else {
    return Ok(Vec::new());
  };
  let mut events = Vec::new();
  for line in BufReader::new(file).lines() {
    let line = line.map_err(|error| format!("read Agent event log: {error}"))?;
    if line.len() > MAX_EVENT_BYTES {
      continue;
    }
    let Ok(event) = serde_json::from_str::<AgentEvent>(&line) else {
      continue;
    };
    if event.sequence > after_sequence {
      events.push(event);
    }
  }
  events.sort_by_key(|event| event.sequence);
  events.dedup_by_key(|event| event.sequence);
  Ok(events)
}

fn unfinished_tail(events: &[AgentEvent]) -> Option<&AgentEvent> {
  let last = events.iter().max_by_key(|event| event.sequence)?;
  (!matches!(last.payload, AgentEventPayload::TurnCompleted | AgentEventPayload::TurnInterrupted { .. }))
    .then_some(last)
}

#[tauri::command]
pub fn agent_active_turn(
  state: State<'_, AgentSupervisor>,
  paper_id: String,
) -> Option<ActiveTurnInfo> {
  state.active_turn(&paper_id)
}

#[tauri::command]
pub fn agent_replay_events(
  app: AppHandle,
  state: State<'_, AgentSupervisor>,
  paper_id: String,
  engine: EngineKind,
  conversation: ConversationKind,
  after_sequence: u64,
) -> Result<Vec<AgentEvent>, String> {
  let app_data_dir = app.path().app_data_dir().map_err(|error| format!("resolve application data: {error}"))?;
  let existing = replay_events_at(&app_data_dir, &paper_id, engine, conversation, 0)?;
  if let Some(last) = unfinished_tail(&existing) {
    let still_running = state.active_turn(&paper_id)
      .is_some_and(|active| active.turn_id == last.turn_id);
    if !still_running {
      let info = ActiveTurnInfo {
        paper_id: last.paper_id.clone(),
        engine: last.engine,
        conversation: last.conversation,
        conversation_id: last.conversation_id.clone(),
        turn_id: last.turn_id.clone(),
        context_revision: last.context_revision.clone(),
        stopping: false,
      };
      state.record_event(
        &app,
        &info,
        AgentEventPayload::TurnInterrupted { reason: "Interrupted after application restart".into() },
        None,
      )?;
    }
  }
  replay_events_at(&app_data_dir, &paper_id, engine, conversation, after_sequence)
}

#[tauri::command]
pub fn agent_stop_turn(
  app: AppHandle,
  state: State<'_, AgentSupervisor>,
  paper_id: String,
  turn_id: String,
) -> Result<(), String> {
  let info = state.stop_turn(&paper_id, &turn_id)?;
  if let Ok(app_data) = app.path().app_data_dir() {
    let _ = super::worksheet::fail_turn_at(&app_data, &info, "stopped by reader");
  }
  state.record_event(
    &app,
    &info,
    AgentEventPayload::TurnInterrupted { reason: "stopped by reader".into() },
    None,
  )?;
  Ok(())
}

#[tauri::command]
pub fn agent_respond_interaction(
  state: State<'_, AgentSupervisor>,
  paper_id: String,
  turn_id: String,
  request_id: String,
  response: InteractionResponse,
) -> Result<(), String> {
  state.answer_interaction(&paper_id, &turn_id, &request_id, response)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn temp_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("lightread-supervisor-{label}-{nonce}"));
    fs::create_dir_all(&path).unwrap();
    path
  }

  fn info(paper_id: &str, turn_id: &str) -> ActiveTurnInfo {
    ActiveTurnInfo {
      paper_id: paper_id.into(),
      engine: EngineKind::Pi,
      conversation: ConversationKind::Chat,
      conversation_id: "main".into(),
      turn_id: turn_id.into(),
      context_revision: "revision-1".into(),
      stopping: false,
    }
  }

  #[test]
  fn enforces_one_turn_per_paper_and_rejects_mismatched_finish() {
    let supervisor = AgentSupervisor::default();
    supervisor.begin_turn(info("paper-1", "turn-1")).unwrap();
    assert!(supervisor.begin_turn(info("paper-1", "turn-2")).is_err());
    assert!(supervisor.finish_turn("paper-1", "turn-2").is_err());
    supervisor.finish_turn("paper-1", "turn-1").unwrap();
    assert!(supervisor.active_turn("paper-1").is_none());
  }

  #[test]
  fn a_mismatched_interaction_answer_does_not_consume_the_real_request() {
    let supervisor = AgentSupervisor::default();
    supervisor.begin_turn(info("paper-1", "turn-1")).unwrap();
    let receiver = supervisor.register_interaction("paper-1", "turn-1", "request-1".into()).unwrap();
    assert!(supervisor.answer_interaction(
      "another-paper", "turn-1", "request-1", InteractionResponse::default(),
    ).is_err());
    supervisor.answer_interaction(
      "paper-1", "turn-1", "request-1", InteractionResponse { value: Some("accept".into()), ..Default::default() },
    ).unwrap();
    assert_eq!(receiver.recv().unwrap().value.as_deref(), Some("accept"));
  }

  #[test]
  fn cleanup_reservation_prevents_a_new_turn_until_released() {
    let supervisor = AgentSupervisor::default();
    supervisor.reserve_cleanup("paper-1").unwrap();
    assert!(supervisor.begin_turn(info("paper-1", "turn-1")).is_err());
    supervisor.finish_cleanup("paper-1");
    supervisor.begin_turn(info("paper-1", "turn-1")).unwrap();
  }

  #[test]
  fn snapshot_reservation_excludes_turns_and_cleanup_until_released() {
    let supervisor = AgentSupervisor::default();
    supervisor.reserve_snapshot("paper-1").unwrap();
    assert!(supervisor.begin_turn(info("paper-1", "turn-1")).is_err());
    assert!(supervisor.reserve_cleanup("paper-1").is_err());
    supervisor.finish_snapshot("paper-1");
    supervisor.begin_turn(info("paper-1", "turn-1")).unwrap();
    assert!(supervisor.reserve_snapshot("paper-1").is_err());
  }

  #[test]
  fn persists_before_delivery_and_replays_missing_sequences() {
    let root = temp_root("events");
    let supervisor = AgentSupervisor::default();
    let info = info("paper-2", "turn-1");
    let first = supervisor.record_event_at(
      &root,
      &info,
      AgentEventPayload::TextDelta { text: "hello".into() },
      None,
      |event| {
        let path = events_path(&root, "paper-2", EngineKind::Pi, ConversationKind::Chat);
        assert!(fs::read_to_string(path).unwrap().contains(&format!("\"sequence\":{}", event.sequence)));
        Ok(())
      },
    ).unwrap();
    assert_eq!(unfinished_tail(&[first.clone()]).map(|event| event.turn_id.as_str()), Some("turn-1"));
    let second = supervisor.record_event_at(
      &root,
      &info,
      AgentEventPayload::TurnCompleted,
      None,
      |_| Ok(()),
    ).unwrap();
    assert_eq!(first.sequence, 1);
    assert_eq!(second.sequence, 2);
    assert!(unfinished_tail(&[first.clone(), second.clone()]).is_none());
    let replay = replay_events_at(&root, "paper-2", EngineKind::Pi, ConversationKind::Chat, 1).unwrap();
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].sequence, 2);
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn ignores_malformed_and_duplicate_log_lines_on_replay() {
    let root = temp_root("malformed");
    let supervisor = AgentSupervisor::default();
    let info = info("paper-3", "turn-1");
    let event = supervisor.record_event_at(&root, &info, AgentEventPayload::TurnCompleted, None, |_| Ok(())).unwrap();
    let path = events_path(&root, "paper-3", EngineKind::Pi, ConversationKind::Chat);
    let encoded = serde_json::to_string(&event).unwrap();
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(file, "not-json").unwrap();
    writeln!(file, "{encoded}").unwrap();
    let replay = replay_events_at(&root, "paper-3", EngineKind::Pi, ConversationKind::Chat, 0).unwrap();
    assert_eq!(replay.len(), 1);
    fs::remove_dir_all(root).unwrap();
  }
}
