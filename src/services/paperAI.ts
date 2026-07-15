/**
 * 论文 AI 辅读: 整体总结 / 论文十问 / 基于全文的问答。
 * 上下文来自 pdf.js 逐页提取的正文文本 (超预算截断), 走用户配置的 AI 服务。
 * 总结与十问答案按论文缓存 (localStorage), 问答为会话性质不缓存。
 */
import { chatStream, type AiMessage } from './ai'
import { useSettings } from '../stores/settings'
import { t } from '../i18n'

/** 上下文字符预算: 约 8k token, 兼顾免费模型的上下文与费用 */
export const DOC_CHAR_BUDGET = 24000

/** 论文十问 (沈向洋十问, 与 ReadPaper 学习任务同源的通用粗读框架) */
export const TEN_QUESTIONS = () =>
  Array.from({ length: 10 }, (_, i) => t(`paper.aiQ${i + 1}`))

export interface DocText {
  text: string
  truncated: boolean
}

export function buildDocSystem(title: string, doc: DocText): string {
  return (
    `你是学术论文阅读助手。用户正在阅读论文《${title}》, 以下是论文正文文本` +
    `${doc.truncated ? ' (论文较长, 仅截取前面部分)' : ''}。` +
    '基于论文内容用简体中文回答, 准确具体, 分点或短段落; 论文中没有的信息明确说明, 不要编造。\n\n' +
    `论文内容:\n${doc.text}`
  )
}

export const SUMMARY_PROMPT =
  '请对这篇论文做整体总结, 依次包含: 研究问题、核心方法、主要实验与结果、贡献、局限或未尽之处。' +
  '每部分一个小标题, 内容简洁准确。'

/* ---- 总结 / 十问缓存 (按论文 + 已配置模型) ---- */

const cacheKey = (bookId: string, slot: string) => `lightread-pai:${bookId}:${slot}`

export function cachedAi(bookId: string, slot: string): string | null {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey(bookId, slot)) ?? '')
    if (typeof data.text === 'string' && data.text && data.model) return data.text
  } catch { /* 无缓存 */ }
  return null
}

export function saveAi(bookId: string, slot: string, text: string) {
  try {
    const s = useSettings()
    localStorage.setItem(cacheKey(bookId, slot), JSON.stringify({ model: s.aiModel, text }))
  } catch { /* 存储满时放弃缓存 */ }
}

/**
 * 基于论文上下文的流式生成。history 为问答会话的既往轮次 (总结/十问传空)。
 * cancelled() 为真时中止。返回完整文本 (中止时为已生成部分)。
 */
export async function askDoc(
  system: string,
  history: AiMessage[],
  question: string,
  onDelta: (full: string) => void,
  cancelled: () => boolean,
): Promise<string> {
  const messages: AiMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: question },
  ]
  let full = ''
  for await (const delta of chatStream(messages)) {
    if (cancelled()) return full
    full += delta
    onDelta(full)
  }
  return full
}
