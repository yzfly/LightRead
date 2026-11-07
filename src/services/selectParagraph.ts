/**
 * 「选中本段」: 把正文里的选区扩到所在的整段 (跨段选时从首段开头到末段结尾)。
 * 段落按常见块元素认; 都不是时取最近一个按块显示的祖先, 到 body 为止。
 * 结果去掉段首尾空白, 免得划线 / 翻译带上缩进。
 */
const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, td, th, figcaption, pre, caption'
const BLOCK_DISPLAY = /^(block|list-item|table-cell|table-caption|flow-root)$/

function elementOf(node: Node): Element | null {
  return node.nodeType === 1 ? (node as Element) : node.parentElement
}

/** 节点所在的段落元素; 找不到 (直接在 body 下的文字) 返回 null */
export function paragraphOf(node: Node): Element | null {
  const el = elementOf(node)
  if (!el) return null
  const tagged = el.closest(BLOCK_SELECTOR)
  if (tagged && tagged !== el.ownerDocument.body) return tagged
  const win = el.ownerDocument.defaultView
  for (let cur: Element | null = el; cur && cur !== el.ownerDocument.body; cur = cur.parentElement) {
    const display = win?.getComputedStyle(cur).display ?? ''
    if (BLOCK_DISPLAY.test(display)) return cur
  }
  return null
}

/** 文本节点里第一个 / 最后一个非空白字符的位置 */
function edge(root: Element, fromStart: boolean): { node: Text; offset: number } | null {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
  const texts: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text)
  const list = fromStart ? texts : texts.reverse()
  for (const node of list) {
    const s = node.data
    if (!/\S/.test(s)) continue
    if (fromStart) return { node, offset: s.search(/\S/) }
    const m = /\s*$/.exec(s)
    return { node, offset: s.length - (m ? m[0].length : 0) }
  }
  return null
}

/** 扩到整段后的新选区; 选区不在任何段落里或段落没有文字时返回 null */
export function paragraphRange(range: Range): Range | null {
  const first = paragraphOf(range.startContainer)
  const last = paragraphOf(range.endContainer) ?? first
  if (!first || !last) return null
  const start = edge(first, true)
  const end = edge(last, false)
  if (!start || !end) return null
  const out = first.ownerDocument.createRange()
  out.setStart(start.node, start.offset)
  out.setEnd(end.node, end.offset)
  if (out.collapsed) return null
  return out
}

/** 当前选区是否已经是整段 (此时不必再显示「选中本段」) */
export function isWholeParagraph(range: Range): boolean {
  const p = paragraphRange(range)
  if (!p) return true
  return p.compareBoundaryPoints(Range.START_TO_START, range) >= 0
    && p.compareBoundaryPoints(Range.END_TO_END, range) <= 0
}
