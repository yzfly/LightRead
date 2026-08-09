<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { AnnotationRec, BookMeta } from '../storage/types.ts'
import { useSettings } from '../stores/settings.ts'
import { bookFilePath } from '../services/babeldoc.ts'
import {
  PAPER_AGENT_EXTRACTOR_VERSION,
  buildPaperContextMarkdown,
  buildPaperNotesMarkdown,
  cachedPaperTextSnapshot,
  type PaperTextSnapshot,
} from '../services/paperAgentContext.ts'
import {
  abortAgentSnapshot,
  activeAgentTurn,
  agentWorkspacePath,
  appendAgentPaperText,
  beginAgentSnapshot,
  finalizeAgentSnapshot,
  commitAgentTenQuestionHumanAnswer,
  loadAgentTenQuestionWorksheet,
  onPaperAgentEvent,
  paperAgentEngineStatus,
  replayAgentEvents,
  resetAgentSession,
  respondToAgentInteraction,
  saveAgentTenQuestionDraft,
  startAgentTurn,
  stopAgentTurn,
  type PaperAgentActiveTurn,
  type PaperAgentEngineStatus,
  type PaperAgentEvent,
} from '../services/paperAgent.ts'
import {
  buildInitialAnswerPrompt,
  buildReanswerPrompt,
  removeLegacyTenQuestionCache,
  tenQuestionText,
  type TenQuestionId,
  type TenQuestionRecord,
  type TenQuestionWorksheet,
} from '../services/paperAgentTenQuestions.ts'
import { t } from '../i18n'

const props = defineProps<{
  paperId: string
  meta: BookMeta
  pageCount: number
  currentPage: number
  selection: { page: number; text: string } | null
  annotations: AnnotationRec[]
  pageText: (pageIndex: number) => string | Promise<string>
}>()

defineEmits<{ close: [] }>()

type SidebarView = 'chat' | 'worksheet'
type UiMessage = { id: string; role: 'user' | 'assistant'; text: string; streaming?: boolean }
type UiTool = { id: string; name: string; summary: string; status: 'running' | 'done' | 'failed' }
type UiInteractionField = {
  id: string
  label: string
  options: Array<{ label: string; description?: string }>
  allowOther: boolean
  multiSelect: boolean
  value: string | string[]
  other: string
}
type UiInteraction = {
  requestId: string
  turnId: string
  prompt: string
  choices: Array<{ value: string; label: string; description?: string }>
  inputAllowed: boolean
  input: string
  nativeMethod: string
  fields: UiInteractionField[]
  opaque?: unknown
  error: string
}

const settings = useSettings()
const router = useRouter()
const selectedEngine = computed(() => settings.paperAgentEngine)
const sidebarView = ref<SidebarView>('chat')
const selectedStatus = ref<PaperAgentEngineStatus | null>(null)
const checkingSelectedStatus = ref(true)
const messages = ref<UiMessage[]>([])
const tools = ref<UiTool[]>([])
const interactions = ref<UiInteraction[]>([])
const worksheet = ref<TenQuestionWorksheet | null>(null)
const worksheetDrafts = ref<Record<string, string>>({})
const expandedQuestion = ref<TenQuestionId>('q1')
const worksheetBusy = ref<string | null>(null)
const worksheetError = ref('')
const activeTurn = ref<PaperAgentActiveTurn | null>(null)
const input = ref('')
const preparing = ref(false)
const preparationLabel = ref('')
const scroll = ref<HTMLElement>()
let textSnapshot: PaperTextSnapshot | null = null
let textSnapshotFingerprint = ''
let preparedWorkspacePath = ''
let snapshotPromise: Promise<{ revision: string; workspacePath: string; contextGeneration: number }> | null = null
let contextGeneration = 0
let unlisten: (() => void) | undefined
let contextTimer: ReturnType<typeof setTimeout> | undefined
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>()
const seenSequences = new Set<string>()

const engineReady = computed(() => Boolean(selectedStatus.value?.compatible && selectedStatus.value?.authenticated))
const canSend = computed(() =>
  !preparing.value
  && !activeTurn.value
  && Boolean(input.value.trim())
  && engineReady.value,
)
const answeredQuestionCount = computed(() => worksheet.value?.questions.filter(question => question.aiReanswer).length ?? 0)

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(value: string): Promise<string> {
  return `sha256:${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))}`
}

async function loadSelectedStatus() {
  const engine = selectedEngine.value
  checkingSelectedStatus.value = true
  try {
    const status = await paperAgentEngineStatus(engine, settings.paperAgentExecutables[engine] || undefined)
    if (selectedEngine.value === engine) selectedStatus.value = status
  } catch {
    if (selectedEngine.value === engine) selectedStatus.value = null
  } finally {
    if (selectedEngine.value === engine) checkingSelectedStatus.value = false
  }
}

function displayAgentError(error: unknown): string {
  const message = String(error)
  if (/executable|probe executable version|did not report a version|authentication|not logged in|no such file or directory/i.test(message)) {
    return t('paper.agentSetupNeeded')
  }
  return message
}

function openAgentSettings() {
  void router.push('/settings')
}

async function ensureTextSnapshot(showProgress: boolean, sourceFingerprint: string): Promise<PaperTextSnapshot> {
  if (textSnapshot && textSnapshotFingerprint === sourceFingerprint) return textSnapshot
  textSnapshot = await cachedPaperTextSnapshot(sourceFingerprint, {
    pageCount: props.pageCount,
    pageText: props.pageText,
    onProgress: showProgress
      ? ({ completedPages, totalPages }) => { preparationLabel.value = t('paper.agentPreparingPages', { current: completedPages, total: totalPages }) }
      : undefined,
  })
  textSnapshotFingerprint = sourceFingerprint
  return textSnapshot
}

async function prepareSnapshot(showProgress = true): Promise<{ revision: string; workspacePath: string }> {
  while (true) {
    if (!snapshotPromise) {
      const preparedGeneration = contextGeneration
      snapshotPromise = (async () => {
        preparing.value = true
        preparationLabel.value = t('paper.agentPreparing')
        const sourcePath = await bookFilePath(props.paperId, props.meta.fileName)
        const begun = await beginAgentSnapshot(props.paperId, sourcePath, PAPER_AGENT_EXTRACTOR_VERSION)
        try {
          const extracted = await ensureTextSnapshot(showProgress, begun.sourceSha256)
          if (begun.needsText) await appendAgentPaperText(begun.token, extracted.content)
          const notesMarkdown = buildPaperNotesMarkdown(props.annotations)
          const textHash = await sha256(extracted.content)
          const notesHash = await sha256(notesMarkdown)
          const snapshotRevision = await sha256(JSON.stringify({
            source: begun.sourceSha256,
            text: textHash,
            notes: notesHash,
            extractorVersion: PAPER_AGENT_EXTRACTOR_VERSION,
            paper: {
              id: props.meta.id,
              title: props.meta.title,
              author: props.meta.author,
              fileName: props.meta.fileName,
              pageCount: props.pageCount,
            },
            extraction: {
              extractedPages: extracted.extractedPages,
              emptyPages: extracted.emptyPages,
              failedPages: extracted.failedPages,
              scannedOrImageOnly: extracted.scannedOrImageOnly,
            },
            page: props.currentPage,
            selectionPage: props.selection?.page ?? null,
            selectionText: props.selection?.text ?? '',
          }))
          const contextMarkdown = buildPaperContextMarkdown({
            book: props.meta,
            pageCount: props.pageCount,
            currentPage: props.currentPage,
            selection: props.selection,
            extraction: extracted,
            snapshotRevision,
            fileHashes: {
              'paper.pdf': begun.sourceSha256,
              'paper.txt': textHash,
              'notes.md': notesHash,
            },
          })
          const finalized = await finalizeAgentSnapshot(begun.token, notesMarkdown, contextMarkdown, snapshotRevision)
          preparedWorkspacePath = finalized.workspacePath
          preparationLabel.value = ''
          return {
            revision: finalized.revision,
            workspacePath: finalized.workspacePath,
            contextGeneration: preparedGeneration,
          }
        } catch (error) {
          await abortAgentSnapshot(begun.token).catch(() => {})
          throw error
        } finally {
          preparing.value = false
        }
      })().finally(() => { snapshotPromise = null })
    }
    const prepared = await snapshotPromise
    if (prepared.contextGeneration === contextGeneration) return prepared
  }
}

function messageFor(turnId: string, role: UiMessage['role']): UiMessage | undefined {
  return messages.value.find(message => message.id === `${turnId}:${role}`)
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function questionFields(questions: unknown[], idFromQuestionText = false): UiInteractionField[] {
  const fields = questions.flatMap(questionValue => {
    const question = recordValue(questionValue)
    const questionText = typeof question?.question === 'string' ? question.question : ''
    const id = idFromQuestionText ? questionText : typeof question?.id === 'string' ? question.id : ''
    if (!question || !id) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap(optionValue => {
          const option = recordValue(optionValue)
          return option && typeof option.label === 'string'
            ? [{ label: option.label, description: typeof option.description === 'string' ? option.description : undefined }]
            : []
        })
      : []
    const header = typeof question.header === 'string' ? question.header : ''
    const prompt = questionText
    const multiSelect = Boolean(question.multiSelect)
    return [{
      id,
      label: [header, prompt].filter(Boolean).join(' — '),
      options,
      allowOther: Boolean(question.isOther) || options.length === 0,
      multiSelect,
      value: multiSelect ? [] : '',
      other: '',
    }]
  })
  return fields
}

function interactionDetails(event: PaperAgentEvent): { nativeMethod: string; fields: UiInteractionField[] } {
  const envelope = recordValue(event.opaque)
  const nativeMethod = typeof envelope?.method === 'string' ? envelope.method : ''
  if (nativeMethod === 'item/tool/requestUserInput') {
    const params = recordValue(envelope?.params)
    return { nativeMethod, fields: questionFields(Array.isArray(params?.questions) ? params.questions : []) }
  }
  const claudeRequest = recordValue(envelope?.request)
  if (envelope?.type === 'control_request' && claudeRequest?.subtype === 'can_use_tool') {
    const input = recordValue(claudeRequest.input)
    const fields = claudeRequest.tool_name === 'AskUserQuestion'
      ? questionFields(Array.isArray(input?.questions) ? input.questions : [], true)
      : []
    return { nativeMethod: 'claude/can_use_tool', fields }
  }
  if (envelope?.type === 'control_request' && claudeRequest?.subtype === 'elicitation') {
    return { nativeMethod: 'claude/elicitation', fields: [] }
  }
  return { nativeMethod, fields: [] }
}

function applyEvent(event: PaperAgentEvent) {
  if (event.paperId !== props.paperId) return
  const terminal = event.payload.type === 'turn_completed'
    || event.payload.type === 'turn_interrupted'
  if (terminal && activeTurn.value?.turnId === event.turnId) {
    activeTurn.value = null
    if (event.conversation === 'worksheet') void loadWorksheet()
  }
  if (event.engine !== selectedEngine.value) return
  const sequenceKey = `${event.conversation}:${event.sequence}`
  if (seenSequences.has(sequenceKey)) return
  seenSequences.add(sequenceKey)
  const payload = event.payload
  const isChat = event.conversation === 'chat'
  if (payload.type === 'user_message' && isChat) {
    messages.value.push({ id: `${event.turnId}:user`, role: 'user', text: String(payload.text ?? '') })
  } else if (payload.type === 'text_delta' && isChat) {
    let message = messageFor(event.turnId, 'assistant')
    if (!message) {
      message = { id: `${event.turnId}:assistant`, role: 'assistant', text: '', streaming: true }
      messages.value.push(message)
    }
    message.text += String(payload.text ?? '')
  } else if (payload.type === 'message_completed' && isChat) {
    let message = messageFor(event.turnId, 'assistant')
    if (!message) {
      message = { id: `${event.turnId}:assistant`, role: 'assistant', text: '' }
      messages.value.push(message)
    }
    message.text = String(payload.text ?? message.text)
    message.streaming = false
  } else if (payload.type === 'tool_started' && isChat) {
    tools.value.push({
      id: String(payload.toolId ?? `${event.turnId}:${tools.value.length}`),
      name: String(payload.name ?? 'tool'),
      summary: String(payload.summary ?? ''),
      status: 'running',
    })
  } else if (isChat && (payload.type === 'tool_updated' || payload.type === 'tool_completed')) {
    const tool = tools.value.find(item => item.id === String(payload.toolId))
    if (tool) {
      tool.summary = String(payload.summary ?? tool.summary)
      if (payload.type === 'tool_completed') tool.status = payload.failed ? 'failed' : 'done'
    }
  } else if (payload.type === 'interaction_requested') {
    const details = interactionDetails(event)
    interactions.value.push({
      requestId: String(payload.requestId),
      turnId: event.turnId,
      prompt: String(payload.prompt ?? ''),
      choices: Array.isArray(payload.choices) ? payload.choices as UiInteraction['choices'] : [],
      inputAllowed: Boolean(payload.inputAllowed),
      input: '',
      ...details,
      opaque: event.opaque,
      error: '',
    })
  } else if (payload.type === 'turn_completed' || payload.type === 'turn_interrupted') {
    interactions.value = interactions.value.filter(interaction => interaction.turnId !== event.turnId)
    if (activeTurn.value?.turnId === event.turnId) activeTurn.value = null
    if (!isChat) void loadWorksheet()
  } else if (payload.type === 'error') {
    interactions.value = interactions.value.filter(interaction => interaction.turnId !== event.turnId)
    if (isChat) messages.value.push({ id: `${event.turnId}:error:${event.sequence}`, role: 'assistant', text: `⚠ ${displayAgentError(payload.message ?? 'AI error')}` })
    else {
      worksheetError.value = displayAgentError(payload.message ?? 'AI error')
      void loadWorksheet()
    }
  }
  nextTick(() => {
    if (scroll.value) scroll.value.scrollTop = scroll.value.scrollHeight
  })
}

async function loadConversation() {
  seenSequences.clear()
  messages.value = []
  tools.value = []
  interactions.value = []
  for (const event of await replayAgentEvents(props.paperId, selectedEngine.value, 'chat')) applyEvent(event)
  for (const event of await replayAgentEvents(props.paperId, selectedEngine.value, 'worksheet')) applyEvent(event)
  activeTurn.value = await activeAgentTurn(props.paperId)
  interactions.value = activeTurn.value
    ? interactions.value.filter(interaction => interaction.turnId === activeTurn.value?.turnId)
    : []
}

async function loadWorksheet() {
  const previousWorksheet = worksheet.value
  const previousDrafts = worksheetDrafts.value
  const loaded = await loadAgentTenQuestionWorksheet<TenQuestionWorksheet>(props.paperId)
  worksheet.value = loaded
  worksheetDrafts.value = Object.fromEntries(loaded.questions.map(question => {
    const previous = previousWorksheet?.questions.find(item => item.id === question.id)
    const localDraft = previousDrafts[question.id]
    const hasUnsavedLocalEdit = previous && localDraft !== undefined && localDraft !== previous.humanDraft
    return [question.id, hasUnsavedLocalEdit ? localDraft : question.humanDraft]
  }))
}

function worksheetQuestion(questionId: TenQuestionId): TenQuestionRecord | undefined {
  return worksheet.value?.questions.find(question => question.id === questionId)
}

async function saveHumanDraft(
  questionId: TenQuestionId,
  showFeedback = false,
  busyAlreadyHeld = false,
): Promise<TenQuestionRecord | undefined> {
  const question = worksheetQuestion(questionId)
  if (!question || (worksheetBusy.value && !busyAlreadyHeld)) return question
  const text = worksheetDrafts.value[questionId] ?? ''
  if (text === question.humanDraft) {
    if (showFeedback) worksheetError.value = t('paper.agentHumanSaved')
    return question
  }
  if (!busyAlreadyHeld) worksheetBusy.value = questionId
  worksheetError.value = ''
  try {
    const loaded = await saveAgentTenQuestionDraft<TenQuestionWorksheet>(
      props.paperId,
      questionId,
      text,
      question.humanEditRevision,
    )
    worksheet.value = loaded
    const saved = loaded.questions.find(item => item.id === questionId)
    if (showFeedback) worksheetError.value = t('paper.agentHumanSaved')
    return saved
  } catch (error) {
    worksheetError.value = displayAgentError(error)
    await loadWorksheet().catch(() => {})
    return undefined
  } finally {
    if (!busyAlreadyHeld) worksheetBusy.value = null
  }
}

function scheduleHumanDraftSave(questionId: TenQuestionId) {
  clearTimeout(draftTimers.get(questionId))
  draftTimers.set(questionId, setTimeout(() => {
    draftTimers.delete(questionId)
    void saveHumanDraft(questionId)
  }, 450))
}

async function startInitialAnswer(questionId: TenQuestionId) {
  const question = worksheetQuestion(questionId)
  if (!question || question.aiInitial || question.pending || activeTurn.value || worksheetBusy.value) return
  worksheetBusy.value = questionId
  worksheetError.value = ''
  try {
    const snapshot = await prepareSnapshot(true)
    activeTurn.value = await startAgentTurn({
      paperId: props.paperId,
      engine: selectedEngine.value,
      conversation: 'worksheet',
      conversationId: 'ten-questions',
      contextRevision: snapshot.revision,
      message: buildInitialAnswerPrompt(questionId),
      executablePath: settings.paperAgentExecutables[selectedEngine.value] || undefined,
      worksheet: { questionId, phase: 'initial', humanRevision: 0, humanEditRevision: 0 },
    })
    await loadWorksheet()
  } catch (error) {
    worksheetError.value = displayAgentError(error)
  } finally {
    worksheetBusy.value = null
  }
}

async function saveAndReanswer(questionId: TenQuestionId) {
  if (activeTurn.value || worksheetBusy.value) return
  worksheetBusy.value = questionId
  worksheetError.value = ''
  try {
    const saved = await saveHumanDraft(questionId, false, true)
    if (!saved?.aiInitial) return
    const committedWorksheet = await commitAgentTenQuestionHumanAnswer<TenQuestionWorksheet>(
      props.paperId,
      questionId,
      saved.humanEditRevision,
    )
    worksheet.value = committedWorksheet
    const committed = committedWorksheet.questions.find(question => question.id === questionId)
    if (!committed) throw new Error('Paper question is missing')
    const snapshot = await prepareSnapshot(true)
    activeTurn.value = await startAgentTurn({
      paperId: props.paperId,
      engine: selectedEngine.value,
      conversation: 'worksheet',
      conversationId: 'ten-questions',
      contextRevision: snapshot.revision,
      message: buildReanswerPrompt(committed),
      executablePath: settings.paperAgentExecutables[selectedEngine.value] || undefined,
      worksheet: {
        questionId,
        phase: 'reanswer',
        humanRevision: committed.humanCommittedRevision,
        humanEditRevision: committed.humanEditRevision,
      },
    })
    await loadWorksheet()
  } catch (error) {
    worksheetError.value = displayAgentError(error)
    await loadWorksheet().catch(() => {})
  } finally {
    worksheetBusy.value = null
  }
}

async function send() {
  const message = input.value.trim()
  if (!message || !canSend.value) return
  input.value = ''
  try {
    const snapshot = await prepareSnapshot(true)
    activeTurn.value = await startAgentTurn({
      paperId: props.paperId,
      engine: selectedEngine.value,
      conversation: 'chat',
      conversationId: 'main',
      contextRevision: snapshot.revision,
      message,
      executablePath: settings.paperAgentExecutables[selectedEngine.value] || undefined,
    })
  } catch (error) {
    input.value = message
    messages.value.push({ id: `local-error:${Date.now()}`, role: 'assistant', text: `⚠ ${displayAgentError(error)}` })
  }
}

async function stop() {
  const turn = activeTurn.value
  if (!turn) return
  await stopAgentTurn(props.paperId, turn.turnId).catch(error => {
    if (turn.conversation === 'worksheet') worksheetError.value = displayAgentError(error)
    else messages.value.push({ id: `stop-error:${Date.now()}`, role: 'assistant', text: `⚠ ${displayAgentError(error)}` })
  })
  activeTurn.value = null
  if (turn.conversation === 'worksheet') await loadWorksheet().catch(() => {})
}

function interactionPayload(interaction: UiInteraction, value?: string): unknown {
  const fieldAnswer = (field: UiInteractionField): string[] => {
    if (field.other.trim()) return [field.other.trim()]
    return (Array.isArray(field.value) ? field.value : [field.value]).map(answer => answer.trim()).filter(Boolean)
  }
  if (interaction.nativeMethod === 'item/tool/requestUserInput') {
    const answers: Record<string, { answers: string[] }> = {}
    for (const field of interaction.fields) {
      const fieldAnswers = fieldAnswer(field)
      if (!fieldAnswers.length) throw new Error(t('paper.agentInputRequired'))
      answers[field.id] = { answers: fieldAnswers }
    }
    return { answers }
  }
  if (interaction.nativeMethod === 'claude/can_use_tool' && interaction.fields.length) {
    const envelope = recordValue(interaction.opaque)
    const request = recordValue(envelope?.request)
    const originalInput = recordValue(request?.input) ?? {}
    const answers: Record<string, string> = {}
    for (const field of interaction.fields) {
      const fieldAnswers = fieldAnswer(field)
      if (!fieldAnswers.length) throw new Error(t('paper.agentInputRequired'))
      answers[field.id] = fieldAnswers.join(', ')
    }
    return {
      behavior: 'allow',
      updatedInput: { ...originalInput, answers },
      toolUseID: request?.tool_use_id,
      decisionClassification: 'user_temporary',
    }
  }
  if ((interaction.nativeMethod === 'mcpServer/elicitation/request' || interaction.nativeMethod === 'claude/elicitation') && value === 'accept') {
    try {
      return { action: 'accept', content: interaction.input.trim() ? JSON.parse(interaction.input) : {} }
    } catch {
      throw new Error(t('paper.agentJsonRequired'))
    }
  }
  return undefined
}

async function answerInteraction(interaction: UiInteraction, value?: string) {
  interaction.error = ''
  try {
    const payload = interactionPayload(interaction, value)
    const confirmed = ['allow', 'accept', 'acceptForSession', 'confirm', 'true', 'yes'].includes(value ?? '')
    await respondToAgentInteraction(props.paperId, interaction.turnId, interaction.requestId, {
      value: value ?? interaction.input,
      confirmed,
      payload,
    })
    interactions.value = interactions.value.filter(item => item.requestId !== interaction.requestId)
  } catch (error) {
    interaction.error = String(error)
  }
}

async function cancelInteraction(interaction: UiInteraction) {
  await respondToAgentInteraction(props.paperId, interaction.turnId, interaction.requestId, { cancelled: true })
  interactions.value = interactions.value.filter(item => item.requestId !== interaction.requestId)
}

async function openWorkspace() {
  try {
    const workspacePath = preparedWorkspacePath
      || (activeTurn.value ? await agentWorkspacePath(props.paperId) : (await prepareSnapshot(false)).workspacePath)
    const { openPath } = await import('@tauri-apps/plugin-opener')
    await openPath(workspacePath)
  } catch (error) {
    messages.value.push({ id: `workspace-error:${Date.now()}`, role: 'assistant', text: `⚠ ${displayAgentError(error)}` })
  }
}

async function resetNativeSession() {
  if (activeTurn.value) return
  try {
    await resetAgentSession(props.paperId, selectedEngine.value, sidebarView.value)
    const text = t('paper.agentSessionResetDone')
    if (sidebarView.value === 'chat') messages.value.push({ id: `session-reset:${Date.now()}`, role: 'assistant', text })
    else worksheetError.value = text
  } catch (error) {
    const text = displayAgentError(error)
    if (sidebarView.value === 'chat') messages.value.push({ id: `session-reset-error:${Date.now()}`, role: 'assistant', text: `⚠ ${text}` })
    else worksheetError.value = text
  }
}

watch(selectedEngine, async () => {
  await loadSelectedStatus()
  await loadConversation()
})
watch(
  () => [props.currentPage, props.selection?.page, props.selection?.text, props.annotations],
  () => {
    contextGeneration += 1
    clearTimeout(contextTimer)
    if (!textSnapshot || activeTurn.value) return
    contextTimer = setTimeout(() => void prepareSnapshot(false).catch(() => {}), 500)
  },
  { deep: true },
)

onMounted(async () => {
  removeLegacyTenQuestionCache(props.paperId)
  await loadSelectedStatus()
  unlisten = await onPaperAgentEvent(applyEvent)
  await loadConversation()
  await loadWorksheet()
})

onBeforeUnmount(() => {
  clearTimeout(contextTimer)
  for (const timer of draftTimers.values()) clearTimeout(timer)
  for (const question of worksheet.value?.questions ?? []) {
    if ((worksheetDrafts.value[question.id] ?? '') !== question.humanDraft) {
      void saveAgentTenQuestionDraft(
        props.paperId,
        question.id,
        worksheetDrafts.value[question.id] ?? '',
        question.humanEditRevision,
      ).catch(() => {})
    }
  }
  unlisten?.()
})
</script>

<template>
  <section class="agent-sidebar" :aria-label="t('paper.agentTitle')">
    <header class="agent-head">
      <strong>{{ t('paper.agentTitle') }}</strong>
      <span v-if="activeTurn" class="running-dot">{{ t('paper.agentRunning') }}</span>
      <button class="open-workspace" type="button" @click="openWorkspace">{{ t('paper.agentOpenWorkspace') }}</button>
      <button class="close" type="button" :aria-label="t('common.close')" @click="$emit('close')">✕</button>
    </header>

    <div v-if="!checkingSelectedStatus && !engineReady" class="agent-setup-notice">
      <span>{{ t('paper.agentSetupNeeded') }}</span>
      <button type="button" class="btn btn-sm" @click="openAgentSettings">{{ t('paper.agentOpenSettings') }}</button>
    </div>
    <button type="button" class="session-reset" :disabled="!!activeTurn" @click="resetNativeSession">
      {{ t('paper.agentResetSession') }}
    </button>

    <div class="view-tabs" role="tablist" :aria-label="t('paper.agentViews')">
      <button role="tab" :aria-selected="sidebarView === 'chat'" :class="{ active: sidebarView === 'chat' }" @click="sidebarView = 'chat'">
        {{ t('paper.agentConversation') }}
      </button>
      <button role="tab" :aria-selected="sidebarView === 'worksheet'" :class="{ active: sidebarView === 'worksheet' }" @click="sidebarView = 'worksheet'">
        {{ t('paper.aiTen') }}
      </button>
    </div>

    <template v-if="sidebarView === 'chat'">
      <div ref="scroll" class="conversation" role="log" aria-live="polite">
        <div v-if="!messages.length" class="empty">
          <strong>{{ t('paper.agentEmptyTitle') }}</strong>
          <p>{{ t('paper.agentEmptyHint') }}</p>
        </div>
        <div v-for="message in messages" :key="message.id" class="message" :class="message.role">
          {{ message.text || '…' }}
        </div>
        <div v-for="tool in tools" :key="tool.id" class="tool-row" :class="tool.status">
          <strong>{{ tool.name }}</strong><span>{{ tool.summary }}</span>
        </div>
        <article v-for="interaction in interactions" :key="interaction.requestId" class="interaction-card">
          <strong>{{ t('paper.agentNeedsInput') }}</strong>
          <p>{{ interaction.prompt }}</p>
          <div v-for="field in interaction.fields" :key="field.id" class="interaction-field">
            <label>{{ field.label }}</label>
            <select v-if="field.options.length" v-model="field.value" class="input" :multiple="field.multiSelect">
              <option v-if="!field.multiSelect" value="" disabled>{{ t('paper.agentChooseAnswer') }}</option>
              <option v-for="option in field.options" :key="option.label" :value="option.label">
                {{ option.label }}{{ option.description ? ` — ${option.description}` : '' }}
              </option>
            </select>
            <input v-if="field.allowOther" v-model="field.other" class="input" :placeholder="t('paper.agentOtherAnswer')" />
          </div>
          <textarea
            v-if="interaction.inputAllowed && !interaction.fields.length"
            v-model="interaction.input"
            class="input"
            rows="2"
            :placeholder="interaction.nativeMethod === 'mcpServer/elicitation/request' ? t('paper.agentJsonInput') : ''"
          />
          <p v-if="interaction.error" class="interaction-error">{{ interaction.error }}</p>
          <div class="interaction-actions">
            <button
              v-for="choice in interaction.choices"
              :key="choice.value"
              type="button"
              class="btn btn-sm"
              @click="answerInteraction(interaction, choice.value)"
            >{{ choice.label }}</button>
            <button v-if="interaction.inputAllowed && !interaction.choices.length" type="button" class="btn btn-sm btn-primary" @click="answerInteraction(interaction)">
              {{ t('common.confirm') }}
            </button>
            <button type="button" class="btn btn-sm" @click="cancelInteraction(interaction)">{{ t('common.cancel') }}</button>
          </div>
        </article>
      </div>

      <p v-if="preparing" class="preparing">{{ preparationLabel }}</p>
      <form class="composer" @submit.prevent="send">
        <textarea v-model="input" rows="2" :placeholder="t('paper.agentPlaceholder')" @keydown.meta.enter.prevent="send" @keydown.ctrl.enter.prevent="send" />
        <button v-if="activeTurn" type="button" class="btn btn-sm stop" @click="stop">{{ t('common.stop') }}</button>
        <button v-else type="submit" class="btn btn-sm btn-primary" :disabled="!canSend">{{ t('paper.aiSend') }}</button>
      </form>
    </template>

    <div v-else class="worksheet" role="tabpanel">
      <div class="worksheet-summary">
        <span>{{ t('paper.agentWorksheetProgress', { answered: answeredQuestionCount, total: 10 }) }}</span>
        <span>{{ t('paper.agentWorksheetHint') }}</span>
      </div>
      <p v-if="worksheetError" class="worksheet-notice">{{ worksheetError }}</p>
      <p v-if="preparing" class="preparing">{{ preparationLabel }}</p>

      <article v-for="question in worksheet?.questions ?? []" :key="question.id" class="question-card">
        <button
          type="button"
          class="question-head"
          :aria-expanded="expandedQuestion === question.id"
          @click="expandedQuestion = question.id"
        >
          <span class="question-number" :class="{ done: !!question.aiReanswer }">{{ question.id.toUpperCase() }}</span>
          <strong>{{ tenQuestionText(question.id) }}</strong>
          <span>{{ expandedQuestion === question.id ? '⌃' : '⌄' }}</span>
        </button>

        <div v-if="expandedQuestion === question.id" class="question-body">
          <section class="answer-region ai-initial">
            <header>
              <strong>{{ t('paper.agentInitialAnswer') }}</strong>
              <small
                v-if="question.aiInitial"
                :title="`${question.aiInitial.contextRevision} · ${question.aiInitial.nativeSessionId} · ${question.aiInitial.nativeTurnId}`"
              >{{ t('paper.agentTitle') }}</small>
            </header>
            <div v-if="question.aiInitial" class="answer-text">{{ question.aiInitial.text }}</div>
            <p v-if="question.aiInitial?.stale" class="stale-note">{{ t('paper.agentInitialStale') }}</p>
            <p v-else-if="question.pending?.phase === 'initial'" class="answer-pending">
              {{ t('paper.agentRunning') }}
            </p>
            <button
              v-else
              type="button"
              class="btn btn-sm"
              :disabled="!!activeTurn || !!worksheetBusy || !engineReady"
              @click="startInitialAnswer(question.id)"
            >{{ t('paper.agentAskInitial') }}</button>
          </section>

          <section class="answer-region human-answer">
            <header>
              <strong>{{ t('paper.agentMyAnswer') }}</strong>
              <small>{{ t('paper.agentHumanRevision', { revision: question.humanCommittedRevision }) }}</small>
            </header>
            <textarea
              v-model="worksheetDrafts[question.id]"
              rows="6"
              :placeholder="t('paper.agentHumanPlaceholder')"
              @input="scheduleHumanDraftSave(question.id)"
              @blur="saveHumanDraft(question.id)"
            />
            <div class="human-actions">
              <button
                type="button"
                class="btn btn-sm"
                :disabled="worksheetBusy === question.id"
                @click="saveHumanDraft(question.id, true)"
              >{{ t('common.save') }}</button>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                :disabled="!question.aiInitial || !!activeTurn || !!worksheetBusy || !engineReady || !worksheetDrafts[question.id]?.trim()"
                @click="saveAndReanswer(question.id)"
              >{{ t('paper.agentSaveAndReanswer') }}</button>
            </div>
          </section>

          <section class="answer-region ai-reanswer" :class="{ stale: question.aiReanswer?.stale }">
            <header>
              <strong>{{ t('paper.agentReanswer') }}</strong>
              <small
                v-if="question.aiReanswer"
                :title="`${question.aiReanswer.contextRevision} · ${question.aiReanswer.nativeSessionId} · ${question.aiReanswer.nativeTurnId}`"
              >
                {{ t('paper.agentTitle') }} · {{ t('paper.agentBasedOnRevision', { revision: question.aiReanswer.humanRevision }) }}
              </small>
            </header>
            <div v-if="question.aiReanswer" class="answer-text">{{ question.aiReanswer.text }}</div>
            <p v-else-if="question.pending?.phase === 'reanswer'" class="answer-pending">
              {{ t('paper.agentRunning') }}
            </p>
            <p v-else class="answer-empty">{{ t('paper.agentReanswerEmpty') }}</p>
            <p v-if="question.aiReanswer?.stale" class="stale-note">
              {{ t('paper.agentReanswerStale') }}
            </p>
            <p v-if="question.lastError" class="answer-error">{{ displayAgentError(question.lastError) }}</p>
          </section>
        </div>
      </article>

      <article v-for="interaction in interactions" :key="interaction.requestId" class="interaction-card worksheet-interaction">
        <strong>{{ t('paper.agentNeedsInput') }}</strong>
        <p>{{ interaction.prompt }}</p>
        <div v-for="field in interaction.fields" :key="field.id" class="interaction-field">
          <label>{{ field.label }}</label>
          <select v-if="field.options.length" v-model="field.value" class="input" :multiple="field.multiSelect">
            <option v-if="!field.multiSelect" value="" disabled>{{ t('paper.agentChooseAnswer') }}</option>
            <option v-for="option in field.options" :key="option.label" :value="option.label">
              {{ option.label }}{{ option.description ? ` — ${option.description}` : '' }}
            </option>
          </select>
          <input v-if="field.allowOther" v-model="field.other" class="input" :placeholder="t('paper.agentOtherAnswer')" />
        </div>
        <textarea
          v-if="interaction.inputAllowed && !interaction.fields.length"
          v-model="interaction.input"
          class="input"
          rows="2"
          :placeholder="interaction.nativeMethod === 'mcpServer/elicitation/request' ? t('paper.agentJsonInput') : ''"
        />
        <p v-if="interaction.error" class="interaction-error">{{ interaction.error }}</p>
        <div class="interaction-actions">
          <button
            v-for="choice in interaction.choices"
            :key="choice.value"
            type="button"
            class="btn btn-sm"
            @click="answerInteraction(interaction, choice.value)"
          >{{ choice.label }}</button>
          <button v-if="interaction.inputAllowed && !interaction.choices.length" type="button" class="btn btn-sm btn-primary" @click="answerInteraction(interaction)">
            {{ t('common.confirm') }}
          </button>
          <button type="button" class="btn btn-sm" @click="cancelInteraction(interaction)">{{ t('common.cancel') }}</button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.agent-sidebar { height: 100%; display: flex; flex-direction: column; min-height: 0; color: var(--text); }
.agent-head { display: flex; align-items: center; gap: 9px; padding: 10px 14px 8px; border-bottom: 1px solid var(--border); }
.agent-head strong { font-size: 13px; }
.running-dot { font-size: 11px; color: var(--brand); }
.open-workspace { margin-left: auto; border: 0; background: none; color: var(--brand); font-size: 11px; }
.close { border: 0; background: none; color: var(--text-3); font-size: 15px; }
.agent-setup-notice { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 9px 12px 4px; padding: 8px 9px; border: 1px solid color-mix(in srgb, var(--brand) 28%, var(--border)); border-radius: 8px; background: var(--bg); color: var(--text-2); font-size: 11px; line-height: 1.45; }
.agent-setup-notice .btn { flex: 0 0 auto; }
.session-reset { align-self: flex-end; margin: 4px 12px 3px; border: 0; background: none; color: var(--text-3); font-size: 10px; }
.session-reset:disabled { opacity: .45; }
.view-tabs { display: flex; gap: 3px; padding: 4px 12px 8px; }
.view-tabs button { flex: 1; border: 0; border-radius: 7px; padding: 6px; background: transparent; color: var(--text-3); font-size: 12px; }
.view-tabs button.active { background: var(--bg); color: var(--text); font-weight: 600; }
.conversation { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 8px 14px 12px; }
.empty { margin: auto 0; color: var(--text-3); text-align: center; font-size: 12px; }
.empty p { margin: 5px 0; }
.message { max-width: 92%; padding: 8px 10px; border-radius: 10px; white-space: pre-wrap; line-height: 1.65; font-size: 12.5px; overflow-wrap: anywhere; }
.message.user { align-self: flex-end; background: var(--brand); color: #fff; }
.message.assistant { align-self: flex-start; background: var(--bg); }
.tool-row { display: grid; grid-template-columns: auto 1fr; gap: 7px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; color: var(--text-3); font-size: 10.5px; }
.tool-row span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tool-row.failed { border-color: var(--danger, #d64b4b); }
.interaction-card { padding: 9px; border: 1px solid var(--brand); border-radius: 9px; background: var(--bg); font-size: 11.5px; }
.interaction-card p { margin: 6px 0; white-space: pre-wrap; }
.interaction-card .input { box-sizing: border-box; width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 7px; background: var(--card); color: var(--text); font: inherit; }
.interaction-field { display: grid; gap: 5px; margin-top: 7px; }
.interaction-field label { color: var(--text-2); line-height: 1.45; }
.interaction-error { color: var(--danger, #c94545); }
.interaction-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.preparing { margin: 0; padding: 6px 14px 0; color: var(--brand); font-size: 11px; }
.composer { display: flex; gap: 8px; align-items: flex-end; padding: 10px 14px 12px; border-top: 1px solid var(--border); }
.composer textarea { flex: 1; min-height: 38px; max-height: 120px; resize: vertical; border: 1px solid var(--border); border-radius: 9px; padding: 8px 9px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; }
.composer .stop { color: var(--danger, #c94545); }
.worksheet { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px 16px; }
.worksheet-summary { display: flex; justify-content: space-between; gap: 10px; padding: 3px 2px 9px; color: var(--text-3); font-size: 10.5px; }
.worksheet-notice { margin: 0 0 8px; padding: 7px 9px; border-radius: 7px; background: var(--bg); color: var(--brand); font-size: 11px; overflow-wrap: anywhere; }
.question-card { margin-bottom: 8px; border: 1px solid var(--border); border-radius: 9px; background: var(--card); overflow: hidden; }
.question-head { width: 100%; display: grid; grid-template-columns: auto 1fr auto; align-items: start; gap: 8px; padding: 9px; border: 0; background: transparent; color: var(--text); text-align: left; }
.question-head strong { font-size: 11.5px; line-height: 1.45; }
.question-number { min-width: 27px; color: var(--text-3); font-size: 10px; font-weight: 700; }
.question-number.done { color: var(--success, #23a55a); }
.question-body { display: flex; flex-direction: column; gap: 7px; padding: 0 8px 8px; }
.answer-region { padding: 9px; border-radius: 8px; background: var(--bg); }
.answer-region > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
.answer-region > header strong { font-size: 11px; }
.answer-region > header small { color: var(--text-3); font-size: 9.5px; }
.answer-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11.5px; line-height: 1.65; }
.answer-pending, .answer-empty, .answer-error, .stale-note { margin: 4px 0 0; color: var(--text-3); font-size: 10.5px; }
.answer-error { color: var(--danger, #c94545); }
.human-answer { border: 1px solid color-mix(in srgb, var(--brand) 35%, var(--border)); }
.human-answer textarea { width: 100%; resize: vertical; min-height: 92px; border: 1px solid var(--border); border-radius: 7px; padding: 8px; background: var(--card); color: var(--text); font: inherit; font-size: 11.5px; line-height: 1.55; }
.human-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 7px; }
.ai-reanswer.stale { border: 1px solid color-mix(in srgb, #d69a28 45%, var(--border)); }
.stale-note { color: #b57600; }
.worksheet-interaction { margin-top: 8px; }
</style>
