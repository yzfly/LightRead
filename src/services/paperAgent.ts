import { isTauri } from '../storage/types.ts'

interface PaperAgentTestBridge {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>
  listen(listener: (event: PaperAgentEvent) => void): () => void
}

declare global {
  interface Window {
    __LIGHTREAD_PAPER_AGENT_TEST_BRIDGE__?: PaperAgentTestBridge
  }
}

export interface AgentSnapshotBeginResult {
  token: string
  needsText: boolean
  sourceSha256: string
  currentPaperPath: string
  workspacePath: string
}

export interface AgentSnapshotResult {
  revision: string
  sourceSha256: string
  fileHashes: Record<string, string>
  currentPaperPath: string
  workspacePath: string
}

export type PaperAgentEngine = 'codex' | 'claude' | 'pi'
export type PaperAgentConversation = 'chat' | 'worksheet'

export interface PaperAgentEvent {
  paperId: string
  engine: PaperAgentEngine
  conversation: PaperAgentConversation
  conversationId: string
  turnId: string
  sequence: number
  contextRevision: string
  timestampMs: number
  payload: { type: string; [key: string]: unknown }
  opaque?: unknown
}

export interface PaperAgentActiveTurn {
  paperId: string
  engine: PaperAgentEngine
  conversation: PaperAgentConversation
  conversationId: string
  turnId: string
  contextRevision: string
  stopping: boolean
}

export interface PaperAgentEngineStatus {
  engine: PaperAgentEngine
  found: boolean
  compatible: boolean
  authenticated: boolean
  path: string
  version: string
  reason: string
  approvalPosture: string
}

export interface AgentWorksheetTurnBinding {
  questionId: string
  phase: 'initial' | 'reanswer'
  humanRevision: number
  humanEditRevision: number
}

const TEXT_CHUNK_SIZE = 512 * 1024

function testBridge(): PaperAgentTestBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.__LIGHTREAD_PAPER_AGENT_TEST_BRIDGE__
}

/** Native in production; an explicit in-page bridge exists only for browser contract tests. */
export function paperAgentRuntimeAvailable(): boolean {
  if (testBridge()) return true
  const mobileHost = typeof navigator !== 'undefined'
    && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
  return isTauri() && !mobileHost
}

async function invokeAgent<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const bridge = testBridge()
  if (bridge) return bridge.invoke<T>(command, args)
  if (!isTauri()) throw new Error('Paper Agents are available only in the desktop app')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export async function beginAgentSnapshot(
  paperId: string,
  sourcePdfPath: string,
  extractorVersion: number,
): Promise<AgentSnapshotBeginResult> {
  return invokeAgent('agent_snapshot_begin', { paperId, sourcePdfPath, extractorVersion })
}

export async function appendAgentPaperText(token: string, paperText: string): Promise<void> {
  for (let offset = 0; offset < paperText.length; offset += TEXT_CHUNK_SIZE) {
    await invokeAgent('agent_snapshot_append_text', {
      token,
      chunk: paperText.slice(offset, offset + TEXT_CHUNK_SIZE),
    })
  }
}

export async function finalizeAgentSnapshot(
  token: string,
  notesMarkdown: string,
  contextMarkdown: string,
  snapshotRevision: string,
): Promise<AgentSnapshotResult> {
  return invokeAgent('agent_snapshot_finalize', { token, notesMarkdown, contextMarkdown, snapshotRevision })
}

export async function abortAgentSnapshot(token: string): Promise<void> {
  await invokeAgent('agent_snapshot_abort', { token })
}

export async function prepareAgentSnapshot(options: {
  paperId: string
  sourcePdfPath: string
  extractorVersion: number
  paperText: string
  notesMarkdown: string
  contextMarkdown: string
  snapshotRevision: string
}): Promise<AgentSnapshotResult> {
  const begun = await beginAgentSnapshot(options.paperId, options.sourcePdfPath, options.extractorVersion)
  try {
    if (begun.needsText) await appendAgentPaperText(begun.token, options.paperText)
    return await finalizeAgentSnapshot(
      begun.token,
      options.notesMarkdown,
      options.contextMarkdown,
      options.snapshotRevision,
    )
  } catch (error) {
    await abortAgentSnapshot(begun.token).catch(() => {})
    throw error
  }
}

export async function cleanupAgentPaper(paperId: string): Promise<void> {
  await invokeAgent('agent_cleanup_paper', { paperId })
}

export async function agentWorkspacePath(paperId: string): Promise<string> {
  return invokeAgent('agent_workspace_path', { paperId })
}

export async function activeAgentTurn(paperId: string): Promise<PaperAgentActiveTurn | null> {
  return invokeAgent('agent_active_turn', { paperId })
}

export async function replayAgentEvents(
  paperId: string,
  engine: PaperAgentEngine,
  conversation: PaperAgentConversation,
  afterSequence = 0,
): Promise<PaperAgentEvent[]> {
  return invokeAgent('agent_replay_events', { paperId, engine, conversation, afterSequence })
}

export async function stopAgentTurn(paperId: string, turnId: string): Promise<void> {
  await invokeAgent('agent_stop_turn', { paperId, turnId })
}

export async function respondToAgentInteraction(
  paperId: string,
  turnId: string,
  requestId: string,
  response: { value?: string; confirmed?: boolean; cancelled?: boolean; payload?: unknown },
): Promise<void> {
  await invokeAgent('agent_respond_interaction', { paperId, turnId, requestId, response })
}

export async function paperAgentEngineStatus(
  engine: PaperAgentEngine,
  executablePath?: string,
): Promise<PaperAgentEngineStatus> {
  return invokeAgent('agent_engine_status', { engine, executablePath: executablePath || null })
}

export async function startAgentTurn(request: {
  paperId: string
  engine: PaperAgentEngine
  conversation: PaperAgentConversation
  conversationId: string
  contextRevision: string
  message: string
  executablePath?: string
  worksheet?: AgentWorksheetTurnBinding
}): Promise<PaperAgentActiveTurn> {
  return invokeAgent('agent_start_turn', {
    request: { ...request, executablePath: request.executablePath || null },
  })
}

export async function loadAgentTenQuestionWorksheet<T>(paperId: string): Promise<T> {
  return invokeAgent('agent_worksheet_load', { paperId })
}

export async function saveAgentTenQuestionDraft<T>(
  paperId: string,
  questionId: string,
  text: string,
  expectedEditRevision: number,
): Promise<T> {
  return invokeAgent('agent_worksheet_save_draft', { paperId, questionId, text, expectedEditRevision })
}

export async function commitAgentTenQuestionHumanAnswer<T>(
  paperId: string,
  questionId: string,
  expectedEditRevision: number,
): Promise<T> {
  return invokeAgent('agent_worksheet_commit_human', { paperId, questionId, expectedEditRevision })
}

export async function resetAgentSession(
  paperId: string,
  engine: PaperAgentEngine,
  conversation: PaperAgentConversation,
): Promise<void> {
  await invokeAgent('agent_reset_session', { paperId, engine, conversation })
}

export async function onPaperAgentEvent(listener: (event: PaperAgentEvent) => void): Promise<() => void> {
  const bridge = testBridge()
  if (bridge) return bridge.listen(listener)
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<PaperAgentEvent>('paper-agent:event', event => listener(event.payload))
}
