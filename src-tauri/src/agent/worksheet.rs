use super::protocol::{ActiveTurnInfo, ConversationKind, EngineKind};
use super::supervisor::{validate_id, AgentSupervisor};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const WORKSHEET_VERSION: u32 = 1;
const MAX_HUMAN_ANSWER_BYTES: usize = 512 * 1024;

fn worksheet_lock() -> &'static Mutex<()> {
  static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
  LOCK.get_or_init(|| Mutex::new(()))
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerPhase {
  Initial,
  Reanswer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetAnswer {
  pub text: String,
  pub engine: EngineKind,
  pub turn_id: String,
  #[serde(default)]
  pub native_session_id: String,
  #[serde(default)]
  pub native_turn_id: String,
  pub context_revision: String,
  pub human_revision: u64,
  pub human_edit_revision: u64,
  pub completed_at_ms: u64,
  pub stale: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub stale_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAnswer {
  pub phase: AnswerPhase,
  pub engine: EngineKind,
  pub turn_id: String,
  pub context_revision: String,
  pub human_revision: u64,
  pub human_edit_revision: u64,
  pub started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetQuestion {
  pub id: String,
  #[serde(default)]
  pub ai_initial: Option<WorksheetAnswer>,
  #[serde(default)]
  pub human_draft: String,
  #[serde(default)]
  pub human_edit_revision: u64,
  #[serde(default)]
  pub human_committed: String,
  #[serde(default)]
  pub human_committed_revision: u64,
  #[serde(default)]
  pub ai_reanswer: Option<WorksheetAnswer>,
  #[serde(default)]
  pub pending: Option<PendingAnswer>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TenQuestionWorksheet {
  pub version: u32,
  pub questions: Vec<WorksheetQuestion>,
  pub updated_at_ms: u64,
}

impl Default for TenQuestionWorksheet {
  fn default() -> Self {
    Self {
      version: WORKSHEET_VERSION,
      questions: (1..=10).map(|number| WorksheetQuestion {
        id: format!("q{number}"),
        ai_initial: None,
        human_draft: String::new(),
        human_edit_revision: 0,
        human_committed: String::new(),
        human_committed_revision: 0,
        ai_reanswer: None,
        pending: None,
        last_error: None,
      }).collect(),
      updated_at_ms: now_ms(),
    }
  }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksheetTurnBinding {
  pub question_id: String,
  pub phase: AnswerPhase,
  #[serde(default)]
  pub human_revision: u64,
  #[serde(default)]
  pub human_edit_revision: u64,
}

fn worksheet_path(app_data: &Path, paper_id: &str) -> PathBuf {
  app_data.join("paper-agents").join(paper_id).join("workflows").join("ten-questions.json")
}

fn load_at(path: &Path) -> Result<TenQuestionWorksheet, String> {
  let Ok(raw) = fs::read(path) else {
    return Ok(TenQuestionWorksheet::default());
  };
  let worksheet = serde_json::from_slice::<TenQuestionWorksheet>(&raw)
    .map_err(|error| format!("read paper ten-question worksheet: {error}"))?;
  if worksheet.version != WORKSHEET_VERSION {
    return Err("unsupported paper ten-question worksheet version".into());
  }
  let expected = (1..=10).map(|number| format!("q{number}")).collect::<Vec<_>>();
  if worksheet.questions.iter().map(|question| question.id.clone()).collect::<Vec<_>>() != expected {
    return Err("paper ten-question worksheet has invalid stable question ids".into());
  }
  Ok(worksheet)
}

fn save_at(path: &Path, worksheet: &mut TenQuestionWorksheet) -> Result<(), String> {
  worksheet.updated_at_ms = now_ms();
  let parent = path.parent().ok_or("worksheet path has no parent")?;
  fs::create_dir_all(parent).map_err(|error| format!("create worksheet directory: {error}"))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
      .map_err(|error| format!("protect worksheet directory: {error}"))?;
  }
  let encoded = serde_json::to_vec_pretty(worksheet)
    .map_err(|error| format!("encode paper ten-question worksheet: {error}"))?;
  let temp = path.with_extension("tmp");
  fs::write(&temp, encoded).map_err(|error| format!("write paper ten-question worksheet: {error}"))?;
  fs::rename(&temp, path).map_err(|error| format!("commit paper ten-question worksheet: {error}"))
}

fn question_mut<'a>(worksheet: &'a mut TenQuestionWorksheet, question_id: &str) -> Result<&'a mut WorksheetQuestion, String> {
  validate_id(question_id, "question id")?;
  worksheet.questions.iter_mut().find(|question| question.id == question_id)
    .ok_or_else(|| "unknown paper ten-question id".into())
}

pub fn bind_turn_at(
  app_data: &Path,
  info: &ActiveTurnInfo,
  binding: &WorksheetTurnBinding,
) -> Result<(), String> {
  if info.conversation != ConversationKind::Worksheet {
    return Err("worksheet binding requires a worksheet conversation".into());
  }
  let _guard = worksheet_lock().lock().map_err(|_| "worksheet state is poisoned")?;
  let path = worksheet_path(app_data, &info.paper_id);
  let mut worksheet = load_at(&path)?;
  let question = question_mut(&mut worksheet, &binding.question_id)?;
  if question.pending.is_some() {
    return Err("this question already has an Agent answer in progress".into());
  }
  match binding.phase {
    AnswerPhase::Initial if question.ai_initial.is_some() => {
      return Err("the AI initial answer is immutable and already complete".into());
    }
    AnswerPhase::Reanswer => {
      if binding.human_revision == 0
        || binding.human_revision != question.human_committed_revision
        || binding.human_edit_revision != question.human_edit_revision
      {
        return Err("the committed human answer revision is no longer current".into());
      }
    }
    _ => {}
  }
  question.pending = Some(PendingAnswer {
    phase: binding.phase,
    engine: info.engine,
    turn_id: info.turn_id.clone(),
    context_revision: info.context_revision.clone(),
    human_revision: binding.human_revision,
    human_edit_revision: binding.human_edit_revision,
    started_at_ms: now_ms(),
  });
  question.last_error = None;
  save_at(&path, &mut worksheet)
}

pub fn complete_turn_at(
  app_data: &Path,
  info: &ActiveTurnInfo,
  text: &str,
  native_session_id: &str,
  native_turn_id: &str,
) -> Result<(), String> {
  if info.conversation != ConversationKind::Worksheet {
    return Ok(());
  }
  if text.trim().is_empty() {
    return fail_turn_at(app_data, info, "Agent completed without an answer");
  }
  let _guard = worksheet_lock().lock().map_err(|_| "worksheet state is poisoned")?;
  let path = worksheet_path(app_data, &info.paper_id);
  let mut worksheet = load_at(&path)?;
  let Some(question) = worksheet.questions.iter_mut().find(|question| {
    question.pending.as_ref().is_some_and(|pending| pending.turn_id == info.turn_id)
  }) else {
    return Err("worksheet turn binding was not found".into());
  };
  let pending = question.pending.take().ok_or("worksheet turn binding was not found")?;
  let mut answer = WorksheetAnswer {
    text: text.into(),
    engine: pending.engine,
    turn_id: pending.turn_id,
    native_session_id: native_session_id.into(),
    native_turn_id: native_turn_id.into(),
    context_revision: pending.context_revision,
    human_revision: pending.human_revision,
    human_edit_revision: pending.human_edit_revision,
    completed_at_ms: now_ms(),
    stale: false,
    stale_reason: None,
  };
  match pending.phase {
    AnswerPhase::Initial => {
      if question.ai_initial.is_none() {
        question.ai_initial = Some(answer);
        if question.human_edit_revision == 0 && question.human_draft.is_empty() {
          question.human_draft = text.into();
          question.human_edit_revision = 1;
        }
      }
    }
    AnswerPhase::Reanswer => {
      if pending.human_revision != question.human_committed_revision
        || pending.human_edit_revision != question.human_edit_revision
      {
        answer.stale = true;
        answer.stale_reason = Some("human answer changed while the Agent was answering".into());
      }
      question.ai_reanswer = Some(answer);
    }
  }
  question.last_error = None;
  save_at(&path, &mut worksheet)
}

pub fn fail_turn_at(app_data: &Path, info: &ActiveTurnInfo, reason: &str) -> Result<(), String> {
  if info.conversation != ConversationKind::Worksheet {
    return Ok(());
  }
  let _guard = worksheet_lock().lock().map_err(|_| "worksheet state is poisoned")?;
  let path = worksheet_path(app_data, &info.paper_id);
  let mut worksheet = load_at(&path)?;
  let Some(question) = worksheet.questions.iter_mut().find(|question| {
    question.pending.as_ref().is_some_and(|pending| pending.turn_id == info.turn_id)
  }) else {
    return Ok(());
  };
  question.pending = None;
  question.last_error = Some(reason.chars().take(1000).collect());
  save_at(&path, &mut worksheet)
}

pub fn mark_context_revision_at(app_data: &Path, paper_id: &str, current_revision: &str) -> Result<(), String> {
  let _guard = worksheet_lock().lock().map_err(|_| "worksheet state is poisoned")?;
  let path = worksheet_path(app_data, paper_id);
  if !path.exists() {
    return Ok(());
  }
  let mut worksheet = load_at(&path)?;
  let mut changed = false;
  for question in &mut worksheet.questions {
    for answer in [&mut question.ai_initial, &mut question.ai_reanswer].into_iter().flatten() {
      if answer.context_revision != current_revision && !answer.stale {
        answer.stale = true;
        answer.stale_reason = Some("paper context changed after this AI answer".into());
        changed = true;
      }
    }
  }
  if changed {
    save_at(&path, &mut worksheet)?;
  }
  Ok(())
}

#[tauri::command]
pub fn agent_worksheet_load(
  app: AppHandle,
  supervisor: State<'_, AgentSupervisor>,
  paper_id: String,
) -> Result<TenQuestionWorksheet, String> {
  validate_id(&paper_id, "paper id")?;
  let _guard = worksheet_lock().lock().map_err(|_| "worksheet state is poisoned")?;
  let app_data = app.path().app_data_dir().map_err(|error| format!("resolve application data: {error}"))?;
  let path = worksheet_path(&app_data, &paper_id);
  let mut worksheet = load_at(&path)?;
  let active_turn = supervisor.active_turn(&paper_id).map(|turn| turn.turn_id);
  let mut changed = false;
  for question in &mut worksheet.questions {
    if question.pending.as_ref().is_some_and(|pending| Some(&pending.turn_id) != active_turn.as_ref()) {
      question.pending = None;
      question.last_error = Some("The previous Agent answer was interrupted before completion".into());
      changed = true;
    }
  }
  if changed || !path.exists() {
    save_at(&path, &mut worksheet)?;
  }
  Ok(worksheet)
}

#[tauri::command]
pub fn agent_worksheet_save_draft(
  app: AppHandle,
  paper_id: String,
  question_id: String,
  text: String,
  expected_edit_revision: u64,
) -> Result<TenQuestionWorksheet, String> {
  validate_id(&paper_id, "paper id")?;
  if text.len() > MAX_HUMAN_ANSWER_BYTES {
    return Err("human answer is too large".into());
  }
  let _guard = worksheet_lock().lock().map_err(|_| "worksheet state is poisoned")?;
  let app_data = app.path().app_data_dir().map_err(|error| format!("resolve application data: {error}"))?;
  let path = worksheet_path(&app_data, &paper_id);
  let mut worksheet = load_at(&path)?;
  let question = question_mut(&mut worksheet, &question_id)?;
  if question.human_edit_revision != expected_edit_revision {
    return Err("human answer changed in another view; reload before saving".into());
  }
  if question.human_draft != text {
    question.human_draft = text;
    question.human_edit_revision = question.human_edit_revision.saturating_add(1);
    if let Some(answer) = &mut question.ai_reanswer {
      if answer.human_edit_revision != question.human_edit_revision {
        answer.stale = true;
        answer.stale_reason = Some("human answer changed after this AI re-answer".into());
      }
    }
  }
  save_at(&path, &mut worksheet)?;
  Ok(worksheet)
}

#[tauri::command]
pub fn agent_worksheet_commit_human(
  app: AppHandle,
  paper_id: String,
  question_id: String,
  expected_edit_revision: u64,
) -> Result<TenQuestionWorksheet, String> {
  validate_id(&paper_id, "paper id")?;
  let _guard = worksheet_lock().lock().map_err(|_| "worksheet state is poisoned")?;
  let app_data = app.path().app_data_dir().map_err(|error| format!("resolve application data: {error}"))?;
  let path = worksheet_path(&app_data, &paper_id);
  let mut worksheet = load_at(&path)?;
  let question = question_mut(&mut worksheet, &question_id)?;
  if question.human_edit_revision != expected_edit_revision {
    return Err("human answer changed in another view; reload before submitting".into());
  }
  if question.human_draft.trim().is_empty() {
    return Err("write your answer before asking the Agent to answer again".into());
  }
  question.human_committed = question.human_draft.clone();
  question.human_committed_revision = question.human_committed_revision.saturating_add(1);
  save_at(&path, &mut worksheet)?;
  Ok(worksheet)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("lightread-worksheet-{label}-{nonce}"));
    fs::create_dir_all(&path).unwrap();
    path
  }

  fn info(turn_id: &str, context_revision: &str) -> ActiveTurnInfo {
    ActiveTurnInfo {
      paper_id: "paper-1".into(), engine: EngineKind::Pi,
      conversation: ConversationKind::Worksheet, conversation_id: "ten-questions".into(),
      turn_id: turn_id.into(), context_revision: context_revision.into(), stopping: false,
    }
  }

  #[test]
  fn initial_answer_is_immutable_and_seeds_human_draft_only_once() {
    let root = temp_root("initial");
    let turn_info = info("turn-1", "context-1");
    bind_turn_at(&root, &turn_info, &WorksheetTurnBinding {
      question_id: "q1".into(), phase: AnswerPhase::Initial,
      human_revision: 0, human_edit_revision: 0,
    }).unwrap();
    complete_turn_at(&root, &turn_info, "initial answer", "session-1", "native-turn-1").unwrap();
    let path = worksheet_path(&root, "paper-1");
    let worksheet = load_at(&path).unwrap();
    assert_eq!(worksheet.questions[0].ai_initial.as_ref().unwrap().text, "initial answer");
    assert_eq!(worksheet.questions[0].human_draft, "initial answer");
    assert!(bind_turn_at(&root, &info("turn-2", "context-2"), &WorksheetTurnBinding {
      question_id: "q1".into(), phase: AnswerPhase::Initial,
      human_revision: 0, human_edit_revision: 0,
    }).is_err());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn reanswer_is_bound_to_human_revision_and_becomes_stale_after_edit() {
    let root = temp_root("stale");
    let path = worksheet_path(&root, "paper-1");
    let mut worksheet = TenQuestionWorksheet::default();
    worksheet.questions[0].human_draft = "my answer".into();
    worksheet.questions[0].human_edit_revision = 1;
    worksheet.questions[0].human_committed = "my answer".into();
    worksheet.questions[0].human_committed_revision = 1;
    save_at(&path, &mut worksheet).unwrap();
    let info = info("turn-3", "context-3");
    bind_turn_at(&root, &info, &WorksheetTurnBinding {
      question_id: "q1".into(), phase: AnswerPhase::Reanswer,
      human_revision: 1, human_edit_revision: 1,
    }).unwrap();
    {
      let mut worksheet = load_at(&path).unwrap();
      worksheet.questions[0].human_draft = "edited while running".into();
      worksheet.questions[0].human_edit_revision = 2;
      save_at(&path, &mut worksheet).unwrap();
    }
    complete_turn_at(&root, &info, "re-answer", "session-3", "native-turn-3").unwrap();
    let worksheet = load_at(&path).unwrap();
    let answer = worksheet.questions[0].ai_reanswer.as_ref().unwrap();
    assert!(answer.stale);
    assert_eq!(worksheet.questions[0].human_draft, "edited while running");
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn failed_turn_never_clears_human_fields() {
    let root = temp_root("failed");
    let path = worksheet_path(&root, "paper-1");
    let mut worksheet = TenQuestionWorksheet::default();
    worksheet.questions[1].human_draft = "kept".into();
    worksheet.questions[1].human_edit_revision = 1;
    worksheet.questions[1].human_committed = "kept".into();
    worksheet.questions[1].human_committed_revision = 1;
    save_at(&path, &mut worksheet).unwrap();
    let info = info("turn-4", "context-4");
    bind_turn_at(&root, &info, &WorksheetTurnBinding {
      question_id: "q2".into(), phase: AnswerPhase::Reanswer,
      human_revision: 1, human_edit_revision: 1,
    }).unwrap();
    fail_turn_at(&root, &info, "stopped").unwrap();
    let worksheet = load_at(&path).unwrap();
    assert_eq!(worksheet.questions[1].human_draft, "kept");
    assert_eq!(worksheet.questions[1].human_committed, "kept");
    assert!(worksheet.questions[1].pending.is_none());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn a_new_paper_context_marks_prior_ai_answers_stale_without_touching_human_text() {
    let root = temp_root("context-stale");
    let path = worksheet_path(&root, "paper-1");
    let mut worksheet = TenQuestionWorksheet::default();
    worksheet.questions[0].human_draft = "human stays".into();
    worksheet.questions[0].human_edit_revision = 1;
    worksheet.questions[0].ai_initial = Some(WorksheetAnswer {
      text: "old answer".into(), engine: EngineKind::Pi, turn_id: "turn-old".into(),
      native_session_id: "session-old".into(), native_turn_id: "native-turn-old".into(),
      context_revision: "context-old".into(), human_revision: 0, human_edit_revision: 0,
      completed_at_ms: 1, stale: false, stale_reason: None,
    });
    save_at(&path, &mut worksheet).unwrap();
    mark_context_revision_at(&root, "paper-1", "context-new").unwrap();
    let worksheet = load_at(&path).unwrap();
    assert!(worksheet.questions[0].ai_initial.as_ref().unwrap().stale);
    assert_eq!(worksheet.questions[0].human_draft, "human stays");
    fs::remove_dir_all(root).unwrap();
  }
}
