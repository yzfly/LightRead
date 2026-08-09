use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
  Codex,
  Claude,
  Pi,
}

impl EngineKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Codex => "codex",
      Self::Claude => "claude",
      Self::Pi => "pi",
    }
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
  Chat,
  Worksheet,
}

impl ConversationKind {
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Chat => "chat",
      Self::Worksheet => "worksheet",
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionChoice {
  pub value: String,
  pub label: String,
  #[serde(default)]
  pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AgentEventPayload {
  SessionReady { native_session_id: String },
  UserMessage { text: String },
  TextDelta { text: String },
  MessageCompleted { text: String },
  ToolStarted { tool_id: String, name: String, summary: String },
  ToolUpdated { tool_id: String, summary: String },
  ToolCompleted { tool_id: String, summary: String, failed: bool },
  InteractionRequested {
    request_id: String,
    prompt: String,
    choices: Vec<InteractionChoice>,
    input_allowed: bool,
  },
  TurnCompleted,
  TurnInterrupted { reason: String },
  Error { message: String, recoverable: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
  pub paper_id: String,
  pub engine: EngineKind,
  pub conversation: ConversationKind,
  pub conversation_id: String,
  pub turn_id: String,
  pub sequence: u64,
  pub context_revision: String,
  pub timestamp_ms: u64,
  pub payload: AgentEventPayload,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub opaque: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveTurnInfo {
  pub paper_id: String,
  pub engine: EngineKind,
  pub conversation: ConversationKind,
  pub conversation_id: String,
  pub turn_id: String,
  pub context_revision: String,
  pub stopping: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InteractionResponse {
  #[serde(default)]
  pub value: Option<String>,
  #[serde(default)]
  pub confirmed: Option<bool>,
  #[serde(default)]
  pub cancelled: bool,
  #[serde(default)]
  pub payload: Option<Value>,
}
