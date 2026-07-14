/**
 * 论文整页翻译: 编号段落协议 + 流式逐段回填 + 按页缓存。
 * 走用户配置的 AI 服务 (services/ai)。
 */
import { chatStream, type AiMessage } from './ai'
import { useSettings } from '../stores/settings'

const SYSTEM_PROMPT =
  '你是专业的学术论文翻译。把用户提供的编号段落逐段翻译成流畅准确的简体中文: ' +
  '术语首次出现保留英文原文于括号内; 公式、变量名、引用编号原样保留。' +
  '文中形如 {v1} {v2} 的占位符代表公式或特殊符号, 必须在译文的对应位置原样保留, 不得翻译、改写或遗漏。' +
  '严格按输入编号输出, 每段以 [[编号]] 开头, 编号一一对应, 除译文外不输出任何内容。'

/** 单请求段落字符预算 (过长分批, 兼容试用通道上下文限制) */
const BATCH_CHAR_BUDGET = 6000

const cacheKey = (bookId: string, page: number) => `lightread-ptr:${bookId}:${page}`

export function cachedTranslation(bookId: string, page: number, expect: number): string[] | null {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey(bookId, page)) ?? '')
    if (Array.isArray(data.t) && data.t.length === expect && data.model) return data.t
  } catch { /* 无缓存 */ }
  return null
}

function saveTranslation(bookId: string, page: number, translations: string[]) {
  try {
    const s = useSettings()
    localStorage.setItem(cacheKey(bookId, page), JSON.stringify({ model: s.aiModel, t: translations }))
  } catch { /* 存储满时放弃缓存, 不影响功能 */ }
}

/** 把段落切成若干批, 每批总字符不超预算 */
function makeBatches(paras: string[]): Array<{ start: number; items: string[] }> {
  const batches: Array<{ start: number; items: string[] }> = []
  let start = 0
  let size = 0
  let items: string[] = []
  paras.forEach((p, i) => {
    if (items.length && size + p.length > BATCH_CHAR_BUDGET) {
      batches.push({ start, items })
      start = i
      items = []
      size = 0
    }
    items.push(p)
    size += p.length
  })
  if (items.length) batches.push({ start, items })
  return batches
}

/**
 * 翻译一页段落。流式回调 onUpdate(全量译文数组快照)。
 * cancelled() 返回 true 时中止 (不写缓存)。
 */
export async function translatePage(
  bookId: string,
  page: number,
  paras: string[],
  onUpdate: (translations: string[]) => void,
  cancelled: () => boolean,
): Promise<string[]> {
  const out: string[] = new Array(paras.length).fill('')
  for (const batch of makeBatches(paras)) {
    const numbered = batch.items.map((p, i) => `[[${i + 1}]] ${p}`).join('\n\n')
    const messages: AiMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: numbered },
    ]
    let buffer = ''
    for await (const delta of chatStream(messages)) {
      if (cancelled()) return out
      buffer += delta
      // [[n]] 分段解析, 流式回填
      const parts = buffer.split(/\[\[\s*(\d+)\s*\]\]/)
      for (let i = 1; i < parts.length; i += 2) {
        const local = parseInt(parts[i], 10) - 1
        const idx = batch.start + local
        if (local >= 0 && local < batch.items.length && idx < out.length) {
          out[idx] = (parts[i + 1] ?? '').trim()
        }
      }
      onUpdate([...out])
    }
    if (cancelled()) return out
  }
  saveTranslation(bookId, page, out)
  return out
}
