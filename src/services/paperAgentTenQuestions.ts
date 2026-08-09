import type { PaperAgentEngine } from './paperAgent.ts'
import { t } from '../i18n/index.ts'

export const TEN_QUESTION_IDS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => `q${index + 1}` as const),
)

export type TenQuestionId = (typeof TEN_QUESTION_IDS)[number]
export type TenQuestionPhase = 'initial' | 'reanswer'

export interface TenQuestionAnswer {
  text: string
  engine: PaperAgentEngine
  turnId: string
  nativeSessionId: string
  nativeTurnId: string
  contextRevision: string
  humanRevision: number
  humanEditRevision: number
  completedAtMs: number
  stale: boolean
  staleReason?: string
}

export interface TenQuestionPending {
  phase: TenQuestionPhase
  engine: PaperAgentEngine
  turnId: string
  contextRevision: string
  humanRevision: number
  humanEditRevision: number
  startedAtMs: number
}

export interface TenQuestionRecord {
  id: TenQuestionId
  aiInitial: TenQuestionAnswer | null
  humanDraft: string
  humanEditRevision: number
  humanCommitted: string
  humanCommittedRevision: number
  aiReanswer: TenQuestionAnswer | null
  pending: TenQuestionPending | null
  lastError?: string
}

export interface TenQuestionWorksheet {
  version: 1
  questions: TenQuestionRecord[]
  updatedAtMs: number
}

export function tenQuestionText(id: TenQuestionId): string {
  return t(`paper.aiQ${Number(id.slice(1))}`)
}

export function buildInitialAnswerPrompt(id: TenQuestionId): string {
  return [
    `论文十问 · ${id.toUpperCase()}`,
    `问题：${tenQuestionText(id)}`,
    '',
    '请完整阅读 current-paper/paper.txt，并结合 paper.pdf、notes.md 和 context.md 回答。',
    '给出一份准确、具体、可供读者继续人工修改的初答；引用依据时标明 PDF 页码。论文未提供的信息请明确说明，不要猜测。',
  ].join('\n')
}

export function buildReanswerPrompt(question: TenQuestionRecord): string {
  if (!question.aiInitial || !question.humanCommitted.trim() || question.humanCommittedRevision < 1) {
    throw new Error('AI initial answer and a committed human answer are required')
  }
  return [
    `论文十问 · ${question.id.toUpperCase()} · 人工回答修订 ${question.humanCommittedRevision}`,
    `问题：${tenQuestionText(question.id)}`,
    '',
    'AI 初答：',
    question.aiInitial.text,
    '',
    `我的回答（修订 ${question.humanCommittedRevision}，必须按原文理解，不得覆盖或改写此字段）：`,
    question.humanCommitted,
    '',
    '请重新阅读 current-paper 下的论文全文、笔记和当前上下文，以“我的回答”为关键反馈，重新独立给出一份完整、纠正后的答案。',
    '不要只评价或复述我的修改；保留正确部分，纠正错误与遗漏，并用 PDF 页码说明论文依据。',
  ].join('\n')
}

/** 旧 OpenAI 十问缓存不迁入新工作流，避免把用户不满意的结果冒充 Agent 初答。 */
export function removeLegacyTenQuestionCache(paperId: string): void {
  try {
    for (let index = 0; index < 10; index += 1) {
      localStorage.removeItem(`lightread-pai:${paperId}:q${index}`)
    }
  } catch { /* 无存储权限时不阻塞原生工作流 */ }
}

export function isReanswerCurrent(question: TenQuestionRecord): boolean {
  return Boolean(
    question.aiReanswer
    && !question.aiReanswer.stale
    && question.aiReanswer.humanRevision === question.humanCommittedRevision
    && question.aiReanswer.humanEditRevision === question.humanEditRevision,
  )
}
