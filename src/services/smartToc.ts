/**
 * 智能目录: 书本身没有目录 (常见于纯文本灌制的 MOBI、无 nav 的 EPUB) 时,
 * 扫描各分节正文, 依据标题标签与章节行规则识别章节, 生成以 CFI 定位的目录.
 *
 * 纯函数部分 (detectChapters / nestChapters) 不依赖 DOM, 便于契约测试;
 * buildSmartToc 用 foliate 各分节的 createDocument() 取到与渲染一致的 DOM,
 * 再用 view.getCFI() 生成可直接 goTo 的 CFI (与书内搜索定位方式相同).
 */
import { compare as compareCfi, collapse as collapseCfi } from 'foliate-js/epubcfi.js'
import type { TocItem } from '../components/TocList.vue'

/** 一行正文: 标题标签内的行带 heading 级别 (1-6) */
export interface TextLine {
  text: string
  heading?: number
}

export interface ChapterHit {
  /** 在 lines 中的下标 */
  index: number
  label: string
  /** 0 为顶层, 越大越深 */
  level: number
}

/** 中文网络小说与常见英文书的章节标题模式 (TXT 导入切章与智能目录共用) */
export const CHAPTER_RE =
  /^\s*(?:第\s*[0-9一二三四五六七八九十百千万零两〇]+\s*[章节卷回部集话]|(?:Chapter|CHAPTER|Part|PART)\s+[0-9IVXLC]+|序章|序言|楔子|前言|引子|后记|尾声|终章|番外(?:篇)?[0-9一二三四五六七八九十]*).{0,40}$/

/** 网络小说抓取稿的元信息行: 标题行紧跟其后 */
const META_LINE_RE = /^\s*(?:更新时间|发布时间|更新于|本章字数|字数)\s*[:：]?\s*\S/
const MAX_LABEL = 80
const MAX_REGEX_LABEL = 50
const MAX_META_TITLE = 40
const MIN_ITEMS = 2
export const MAX_ITEMS = 3000

const normalizeLabel = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * 从正文行中识别章节.
 * 规则优先级: 至少两处 h1-h3 标题 → 只用标题 (层级来自标题级别);
 * 否则用章节标题正则 (与 TXT 导入一致) + 「标题行 + 元信息行」模式, 结果为平铺.
 */
export function detectChapters(lines: TextLine[]): ChapterHit[] {
  const headings: ChapterHit[] = []
  for (const [index, line] of lines.entries()) {
    if (!line.heading || line.heading > 3) continue
    const label = normalizeLabel(line.text)
    if (!label || label.length > MAX_LABEL) continue
    headings.push({ index, label, level: line.heading })
  }
  if (headings.length >= MIN_ITEMS) {
    const min = Math.min(...headings.map(h => h.level))
    return headings.map(h => ({ ...h, level: h.level - min }))
  }

  const hits: ChapterHit[] = []
  for (let i = 0; i < lines.length; i++) {
    const label = normalizeLabel(lines[i].text)
    if (!label || label.length > MAX_LABEL) continue
    if (label.length <= MAX_REGEX_LABEL && CHAPTER_RE.test(label)) {
      hits.push({ index: i, label, level: 0 })
      continue
    }
    if (label.length > MAX_META_TITLE) continue
    let j = i + 1
    while (j < lines.length && !lines[j].text.trim()) j++
    if (j < lines.length && META_LINE_RE.test(lines[j].text)) {
      hits.push({ index: i, label, level: 0 })
    }
  }
  return hits
}

/** 按 level 组装成 TocList 需要的树 */
export function nestChapters<T extends { level: number; label: string; href: string }>(flat: T[]): TocItem[] {
  const root: TocItem[] = []
  const stack: Array<{ level: number; item: TocItem }> = []
  for (const hit of flat) {
    const item: TocItem = { label: hit.label, href: hit.href }
    while (stack.length && stack[stack.length - 1].level >= hit.level) stack.pop()
    const parent = stack[stack.length - 1]?.item
    if (parent) (parent.subitems ??= []).push(item)
    else root.push(item)
    stack.push({ level: hit.level, item })
  }
  return root
}

export function flattenToc(items: TocItem[] | null | undefined): TocItem[] {
  return (items ?? []).flatMap(i => [i, ...flattenToc(i.subitems)])
}

/**
 * 当前位置所在的章节: 文档顺序上最后一个不晚于「可见范围末尾」的条目.
 * relocate 给的是可见页的范围 CFI; 与 foliate 自身的 TOC 进度一致,
 * 章节标题只要进入当前页就算进入该章 (跳转落点时标题常不在页首).
 */
export function findCurrentSmartItem<T extends { href: string }>(flat: T[], cfi: string): T | undefined {
  if (!cfi) return undefined
  let end: string
  try {
    end = collapseCfi(cfi, true)
  } catch {
    return undefined
  }
  let lo = 0
  let hi = flat.length - 1
  let found: T | undefined
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    let cmp: number
    try {
      cmp = compareCfi(flat[mid].href, end)
    } catch {
      return undefined
    }
    if (cmp <= 0) {
      found = flat[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}

// ---- DOM 扫描 ----

interface DomLine extends TextLine {
  node: Text
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
const SKIP_TAGS = new Set(['head', 'script', 'style', 'svg', 'math', 'template', 'noscript', 'title'])

/** 把文档正文切成「行」: 块级元素边界与 <br> 处断行, 记录每行首个文本节点用于定位 */
export function collectLines(doc: Document): DomLine[] {
  const lines: DomLine[] = []
  let cur: DomLine | null = null
  const flush = () => {
    if (cur && cur.text.trim()) lines.push(cur)
    cur = null
  }
  const visit = (node: Node, heading?: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node as Text).data
      if (!cur) {
        if (!text.trim()) return
        cur = { text: '', node: node as Text, heading }
      }
      cur.text += text
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const tag = (node as Element).localName
    if (SKIP_TAGS.has(tag)) return
    if (tag === 'br') {
      flush()
      return
    }
    const level = /^h[1-6]$/.test(tag) ? Number(tag[1]) : heading
    const block = BLOCK_TAGS.has(tag)
    if (block) flush()
    for (const child of Array.from(node.childNodes)) visit(child, level)
    if (block) flush()
  }
  visit(doc.body ?? doc.documentElement)
  flush()
  return lines
}

export interface SmartTocResult {
  items: TocItem[]
  /** 文档顺序平铺, 用于按 CFI 判定当前章节 */
  flat: Array<{ label: string; href: string }>
}

/**
 * 为已 open 的 foliate-view 生成智能目录. 无法识别 (少于 2 项) 时返回空.
 * 固定版式 / 漫画等无 createDocument 的分节直接跳过.
 */
export async function buildSmartToc(view: any): Promise<SmartTocResult> {
  const empty: SmartTocResult = { items: [], flat: [] }
  const book = view?.book
  if (!book?.sections?.length || book.rendition?.layout === 'pre-paginated') return empty

  const lines: Array<DomLine & { section: number }> = []
  for (const [index, section] of (book.sections as any[]).entries()) {
    if (!section || section.linear === 'no' || typeof section.createDocument !== 'function') continue
    let doc: Document | undefined
    try {
      doc = await section.createDocument()
    } catch {
      continue
    }
    if (!doc) continue
    for (const line of collectLines(doc)) lines.push({ ...line, section: index })
    // 让出主线程, 大书扫描不阻塞翻页
    if (index % 8 === 7) await new Promise(r => setTimeout(r, 0))
  }

  const hits = detectChapters(lines).slice(0, MAX_ITEMS)
  if (hits.length < MIN_ITEMS) return empty

  const flat: Array<{ label: string; href: string; level: number }> = []
  for (const hit of hits) {
    const line = lines[hit.index]
    try {
      const range = line.node.ownerDocument.createRange()
      range.setStart(line.node, 0)
      range.collapse(true)
      flat.push({ label: hit.label, level: hit.level, href: view.getCFI(line.section, range) })
    } catch {
      /* 个别节点无法定位则跳过 */
    }
  }
  if (flat.length < MIN_ITEMS) return empty
  return { items: nestChapters(flat), flat }
}
