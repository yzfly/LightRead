/**
 * 双语对照 (issue #23) 的纯函数: 哪些段落要翻、翻成什么、先翻哪几段、缓存键。
 * DOM 与本机模型的编排在 services/bilingual.ts; 这里不依赖 Vue / 浏览器 API, 便于 node --test。
 *
 * 译文作为段落的**最后一个子元素** (<span data-lr-inert>) 插入, 原文的节点序号与字符偏移都不变,
 * 所以划线 / 书签 / 阅读进度的 CFI 在开关前后指向同一处。其他遍历正文的模块 (听书、打字机、点睛、
 * 简繁转换、选段) 都要跳过带 INERT_ATTR 的元素, 用 isInertNode 判断。
 */
import { mostlyChinese, resolveTarget, type TranslateLang, type TranslateTarget } from './translateCore.ts'

/** 正文里由轻阅插入、不属于原书的元素 (双语译文等) */
export const INERT_ATTR = 'data-lr-inert'
export const BILINGUAL_CLASS = 'lr-bilingual'
/** 往后预翻几段 (含当前可见的第一段): 本机模型一段几秒, 读完一屏前大致能跟上 */
export const BILINGUAL_AHEAD = 8

/** 节点本身或祖先是否为轻阅插入的元素 (遍历正文时据此跳过) */
export function isInertNode(node: { nodeType: number; parentElement?: unknown } | null | undefined): boolean {
  let cur = (node?.nodeType === 1 ? node : node?.parentElement) as { hasAttribute?(n: string): boolean; parentElement?: unknown } | null | undefined
  for (let depth = 0; cur && depth < 64; depth++) {
    if (cur.hasAttribute?.(INERT_ATTR)) return true
    cur = cur.parentElement as typeof cur
  }
  return false
}

/** 段落文字归一: 合并空白 */
export function normalizeParagraph(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function latinShare(text: string): number {
  let latin = 0
  let letters = 0
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue
    letters++
    if (/\p{Script=Latin}/u.test(ch)) latin++
  }
  return letters ? latin / letters : 0
}

/**
 * 这一段翻成什么; 不用翻时返回 null: 没有文字 (页码、分隔符、纯数字)、太短,
 * 或者本来就是目标语言 (中文书开着对照又选了译成中文, 英文段落目标是英文)。
 */
export function paragraphTarget(text: string, setting: TranslateTarget, uiLang: 'zh' | 'en'): TranslateLang | null {
  const t = normalizeParagraph(text)
  const letters = (t.match(/\p{L}/gu) ?? []).length
  if (letters < 2) return null
  // 明确选了译成中文: 中文段落不翻 (划词翻译这时改译英文, 对照里没有意义; 简繁互转用「简繁转换」)
  if ((setting === 'zh-Hans' || setting === 'zh-Hant') && mostlyChinese(t)) return null
  const target = resolveTarget(t, setting, uiLang)
  if (target === 'en' && !mostlyChinese(t) && latinShare(t) > 0.8 && looksEnglish(t)) return null
  return target
}

/** 粗判英文 (目标是英文时, 法 / 德 / 西文段落仍要翻) */
function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? []
  if (words.length < 3) return true
  const common = new Set(['the', 'and', 'of', 'to', 'a', 'in', 'is', 'that', 'it', 'was', 'he', 'for', 'with', 'as', 'his', 'on', 'be', 'at', 'by', 'i', 'you', 'not', 'this', 'are', 'but', 'from', 'or', 'have', 'an', 'they', 'which', 'she', 'her', 'we', 'had', 'were'])
  return words.filter(w => common.has(w)).length / words.length >= 0.12
}

/** 段落指纹 (FNV-1a 两路 + 长度): 缓存用, 书改版、段落改动后自然失效 */
export function paragraphHash(text: string): string {
  const t = normalizeParagraph(text)
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0
  }
  return `${a.toString(36)}${b.toString(36)}-${t.length.toString(36)}`
}

/** 一段译文在缓存里的键 (同一本书、同一个模型下) */
export function entryKey(text: string, target: TranslateLang): string {
  return `${target}:${paragraphHash(text)}`
}

/** 一本书一份缓存: 书 + 模型 (换模型重新翻) */
export function bookCacheKey(bookId: string, model: string): string {
  return `${bookId}|${model}`
}

/**
 * 接下来翻哪几段: 从 start (当前看到的第一段) 起往后 ahead 段里还没译的、需要翻的,
 * 按阅读顺序。start 越界时为空。
 */
export function planParagraphs(count: number, start: number, needs: (i: number) => boolean, ahead = BILINGUAL_AHEAD): number[] {
  if (start < 0 || start >= count) return []
  const out: number[] = []
  for (let i = start; i < count && i < start + ahead; i++) if (needs(i)) out.push(i)
  return out
}

/** 模型输出整理: 去首尾空白与模型偶尔加的引号 / 「译文：」前缀 */
export function cleanTranslation(raw: string): string {
  let s = raw.trim()
  s = s.replace(/^(译文|翻译|Translation)\s*[:：]\s*/i, '')
  return s.trim()
}

/** 注入到每个分节文档里的样式: 译文另起一行、稍小、半透明 (深浅主题都适用), 不能选中 (免得划线落在译文里) */
export const BILINGUAL_CSS = `
.${BILINGUAL_CLASS} {
  display: block;
  margin-top: 0.3em;
  text-indent: 0;
  font-size: 0.92em;
  font-weight: normal;
  font-style: normal;
  opacity: 0.72;
  -webkit-user-select: none;
  user-select: none;
}
.${BILINGUAL_CLASS}[data-pending] { opacity: 0.45; }
`
