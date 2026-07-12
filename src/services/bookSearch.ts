/**
 * 全书内容检索引擎 (VSCode 风格):
 *  - 关键词 / 多关键词 (空格分隔, 段落内同时命中才算结果)
 *  - 正则表达式、区分大小写、全词匹配
 *  - 流式产出: 边扫描边返回结果与进度, 可中途取消
 * 独立于 foliate 内置 search (其不支持正则与多关键词)。
 */

export interface SearchOptions {
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
}

export interface SearchHit {
  cfi: string
  sectionIndex: number
  /** 所属章节标题 (由 toc 推断, 可能为空) */
  chapter: string
  /** 摘要分段: hit 段高亮 (多关键词时全部命中词都标记) */
  segments: Array<{ text: string; hit: boolean }>
}

export interface SearchEvent {
  progress: number
  hits: SearchHit[]
  done?: boolean
  /** 达到结果上限提前停止 */
  truncated?: boolean
}

interface SectionText {
  text: string
  /** 文本片段 → 源文本节点及其在拼接文本中的起点 */
  nodes: Array<{ node: Text; start: number }>
  /** 块级边界位置 (用于多关键词的"同段落"判定) */
  blocks: Array<{ start: number; end: number }>
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'DD', 'DT', 'PRE', 'SECTION', 'ARTICLE'])

/** 提取分节文本与节点映射 */
function extractSection(doc: Document): SectionText {
  const nodes: SectionText['nodes'] = []
  const blocks: SectionText['blocks'] = []
  let text = ''
  let blockStart = 0

  const walk = (el: Element) => {
    // XHTML 文档的 tagName 保留小写, 统一转大写比较
    const isBlock = BLOCK_TAGS.has(el.tagName.toUpperCase())
    const startPos = text.length
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = (child as Text).nodeValue ?? ''
        if (value) {
          nodes.push({ node: child as Text, start: text.length })
          text += value
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child as Element)
      }
    }
    if (isBlock && text.length > startPos) {
      blocks.push({ start: blockStart <= startPos ? startPos : blockStart, end: text.length })
      blockStart = text.length
    }
  }
  if (doc.body) walk(doc.body)
  return { text, nodes, blocks }
}

/** 文本区间 → DOM Range */
function rangeFromOffsets(section: SectionText, start: number, end: number, doc: Document): Range | null {
  const locate = (pos: number, isEnd: boolean) => {
    for (let i = section.nodes.length - 1; i >= 0; i--) {
      const entry = section.nodes[i]
      const len = entry.node.nodeValue?.length ?? 0
      if (pos >= entry.start && pos <= entry.start + len) {
        // 终点落在节点边界时归属前一节点
        if (isEnd && pos === entry.start && i > 0) continue
        return { node: entry.node, offset: pos - entry.start }
      }
    }
    return null
  }
  const s = locate(start, false)
  const e = locate(end, true)
  if (!s || !e) return null
  try {
    const range = doc.createRange()
    range.setStart(s.node, s.offset)
    range.setEnd(e.node, e.offset)
    return range
  } catch {
    return null
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 构造主匹配正则与附加关键词; 正则非法时抛错 */
export function buildMatchers(query: string, opts: SearchOptions): { primary: RegExp; others: RegExp[] } {
  const flags = 'g' + (opts.caseSensitive ? '' : 'i')
  if (opts.regex) {
    return { primary: new RegExp(query, flags), others: [] }
  }
  const terms = query.split(/\s+/).filter(Boolean)
  const make = (term: string) => {
    let src = escapeRegExp(term)
    if (opts.wholeWord) src = `\\b${src}\\b`
    return new RegExp(src, flags)
  }
  const [first, ...rest] = terms
  return { primary: make(first), others: rest.map(make) }
}

/** 由 toc 推断各分节所属章节标题 */
function sectionChapterMap(book: any): Map<number, string> {
  const map = new Map<number, string>()
  const hrefOf = (item: any) => String(item?.href ?? '').split('#')[0]
  const flat: Array<{ href: string; label: string }> = []
  const walkToc = (items: any[]) => {
    for (const item of items ?? []) {
      if (item.href) flat.push({ href: hrefOf(item), label: String(item.label ?? '').trim() })
      if (item.subitems?.length) walkToc(item.subitems)
    }
  }
  walkToc(book?.toc ?? [])
  let current = ''
  for (let i = 0; i < (book?.sections?.length ?? 0); i++) {
    const id = String(book.sections[i]?.id ?? '')
    const hit = flat.find(f => f.href && (id === f.href || id.endsWith('/' + f.href) || f.href.endsWith('/' + id)))
    if (hit) current = hit.label
    map.set(i, current)
  }
  return map
}

const EXCERPT_SPAN = 60

/**
 * 摘要分段高亮: 主匹配区间必亮, 再用全部匹配器扫描摘要文本,
 * 命中区间合并后切分为 [普通|高亮] 交替段落。
 */
function buildSegments(
  pre: string,
  match: string,
  post: string,
  matchers: RegExp[],
): SearchHit['segments'] {
  const text = pre + match + post
  const intervals: Array<[number, number]> = [[pre.length, pre.length + match.length]]
  for (const source of matchers) {
    // 克隆正则, 避免污染外层扫描循环的 lastIndex
    const re = new RegExp(source.source, source.flags)
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0] === '') { re.lastIndex++; continue }
      intervals.push([m.index, m.index + m[0].length])
    }
  }
  intervals.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const iv of intervals) {
    const last = merged[merged.length - 1]
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else merged.push([iv[0], iv[1]])
  }
  const segments: SearchHit['segments'] = []
  let pos = 0
  for (const [a, b] of merged) {
    if (a > pos) segments.push({ text: text.slice(pos, a), hit: false })
    segments.push({ text: text.slice(a, b), hit: true })
    pos = b
  }
  if (pos < text.length) segments.push({ text: text.slice(pos), hit: false })
  return segments
}

/**
 * 全书流式检索。调用方用 for await 消费; 提前 return/break 即取消。
 */
export async function* searchBook(
  view: any,
  query: string,
  opts: SearchOptions,
  limit = 500,
): AsyncGenerator<SearchEvent> {
  const book = view.book
  const sections = book?.sections ?? []
  const { primary, others } = buildMatchers(query, opts)
  const chapters = sectionChapterMap(book)
  let total = 0

  for (let index = 0; index < sections.length; index++) {
    const hits: SearchHit[] = []
    try {
      if (!sections[index]?.createDocument) continue
      const doc: Document = await sections[index].createDocument()
      const section = extractSection(doc)
      if (section.text) {
        const blockAt = (pos: number) =>
          section.blocks.find(b => pos >= b.start && pos < b.end)
        // 无块结构的文档退化为 ±200 字窗口
        const scopeAt = (pos: number) => {
          const block = blockAt(pos)
          return block
            ? section.text.slice(block.start, block.end)
            : section.text.slice(Math.max(0, pos - 200), pos + 200)
        }
        primary.lastIndex = 0
        for (let m = primary.exec(section.text); m; m = primary.exec(section.text)) {
          if (m[0] === '') { primary.lastIndex++; continue } // 空匹配 (如 a*) 防死循环
          const start = m.index
          const end = m.index + m[0].length
          // 多关键词: 其余关键词须出现在同一段落
          if (others.length) {
            const scope = scopeAt(start)
            if (!others.every(re => { re.lastIndex = 0; return re.test(scope) })) continue
          }
          const range = rangeFromOffsets(section, start, end, doc)
          if (!range) continue
          let cfi = ''
          try {
            cfi = view.getCFI(index, range)
          } catch { /* 个别节点无法生成 CFI, 跳过 */ }
          if (!cfi) continue
          hits.push({
            cfi,
            sectionIndex: index,
            chapter: chapters.get(index) ?? '',
            segments: buildSegments(
              section.text.slice(Math.max(0, start - EXCERPT_SPAN), start).trimStart(),
              m[0],
              section.text.slice(end, end + EXCERPT_SPAN).trimEnd(),
              [primary, ...others],
            ),
          })
          total++
          if (total >= limit) {
            yield { progress: 1, hits, done: true, truncated: true }
            return
          }
        }
      }
    } catch { /* 单节解析失败不中断全书扫描 */ }
    yield { progress: (index + 1) / sections.length, hits }
    // 让出主线程, 保持界面响应
    await new Promise(r => setTimeout(r, 0))
  }
  yield { progress: 1, hits: [], done: true }
}
