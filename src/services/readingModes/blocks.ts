/**
 * 分节文本模型 (DOM 薄层): 把一节正文的文本节点拼成一条连续的「节内偏移」坐标,
 * 供打字机按偏移推进、再换算回 DOM Range。
 *
 * - 遍历方式与 foliate text-walker / tts.js 一致: 跳过 script/style;
 *   段落边界取最近的块级祖先 (与 tts.js 的 blockTags 同一张表), <br> 也算一次换段;
 * - 图片 / SVG / MathML / 视频等是「原子块」: 不进文本流, 记下它在文本流里的位置, 到达时整块显示;
 * - ruby 的 rt/rp 文本进文本流但不占时间 (与基字一起出现); display:none 的文本 (内嵌脚注等) 同样不占时间;
 * - 只读 DOM, 不改结构, 不影响 CFI 与 foliate 排版。
 */
import { locateIn } from './pacing.ts'
import { INERT_ATTR } from '../bilingualCore.ts'

const BLOCK_TAGS = new Set([
  'article', 'aside', 'audio', 'blockquote', 'caption',
  'details', 'dialog', 'div', 'dl', 'dt', 'dd',
  'figure', 'footer', 'form', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
  'main', 'math', 'nav', 'ol', 'p', 'pre', 'section', 'tr', 'td', 'th', 'body',
])
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'title'])
const ATOM_TAGS = new Set(['img', 'svg', 'video', 'math', 'audio', 'canvas', 'iframe', 'object', 'embed', 'picture'])
const MUTE_TAGS = new Set(['rt', 'rp'])

export interface Atom {
  /** 在文本流里的位置: 它之前的文字都打完时出现 */
  offset: number
  el: Element
}

export class SectionText {
  readonly doc: Document
  readonly nodes: Text[] = []
  /** prefix[i] 为第 i 个文本节点在节内的起点, prefix[n] 为总长 */
  readonly prefix: number[] = [0]
  /** 段落结束处的偏移 (升序去重) */
  readonly breaks: number[] = []
  readonly atoms: Atom[] = []
  /** 1 = 注音文本 (rt/rp), 不占时间 */
  readonly muted: Uint8Array
  #index = new Map<Text, number>()
  /** display:none 检测缓存: -1 未测 / 0 可见 / 1 不可见 */
  #hidden: Int8Array

  constructor(doc: Document) {
    this.doc = doc
    const body = doc.body
    const mutedList: number[] = []
    let length = 0
    let prevBlock: Element | null = null
    const pushBreak = (at: number) => {
      if (at > 0 && this.breaks[this.breaks.length - 1] !== at) this.breaks.push(at)
    }
    if (body) {
      const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: node => {
          if (node.nodeType !== 1) return NodeFilter.FILTER_ACCEPT
          const name = (node as Element).localName?.toLowerCase() ?? ''
          if (SKIP_TAGS.has(name) || (node as Element).hasAttribute(INERT_ATTR)) return NodeFilter.FILTER_REJECT
          if (ATOM_TAGS.has(name)) {
            this.atoms.push({ offset: length, el: node as Element })
            return NodeFilter.FILTER_REJECT
          }
          if (name === 'br') pushBreak(length)
          return NodeFilter.FILTER_SKIP
        },
      })
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n as Text
        const len = text.data.length
        if (!len) continue
        if (text.data.trim()) {
          const block = blockOf(text)
          if (prevBlock && block !== prevBlock) pushBreak(length)
          prevBlock = block
        }
        this.#index.set(text, this.nodes.length)
        mutedList.push(isMuted(text) ? 1 : 0)
        this.nodes.push(text)
        length += len
        this.prefix.push(length)
      }
    }
    this.muted = Uint8Array.from(mutedList)
    this.#hidden = new Int8Array(this.nodes.length).fill(-1)
  }

  get length(): number {
    return this.prefix[this.prefix.length - 1]
  }

  /** DOM 点 → 节内偏移。不在文本节点上的点 (元素边界) 取其后第一个文本节点的起点 */
  offsetOf(node: Node, offset: number): number {
    const i = node.nodeType === 3 ? this.#index.get(node as Text) : undefined
    if (i != null) return this.prefix[i] + Math.min(offset, this.nodes[i].data.length)
    if (!this.nodes.length) return 0
    const probe = this.doc.createRange()
    try {
      probe.setStart(node, offset)
    } catch {
      return 0
    }
    // 第一个起点在该点之后 (或重合) 的文本节点
    let lo = 0
    let hi = this.nodes.length - 1
    let ans = this.nodes.length
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      let cmp: number
      try { cmp = probe.comparePoint(this.nodes[mid], 0) } catch { cmp = 1 }
      if (cmp >= 0) {
        ans = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    // 点落在某个文本节点内部 (例如 node 是该文本的父元素且 offset 指向其后): 前一个节点若包含该点, 取其末尾
    if (ans > 0) {
      const prev = this.nodes[ans - 1]
      try {
        if (probe.comparePoint(prev, prev.data.length) > 0) return this.prefix[ans - 1] + prev.data.length
      } catch { /* 忽略 */ }
    }
    return this.prefix[ans] ?? this.length
  }

  /** 节内偏移 → DOM 点; 没有文本时返回 null */
  point(offset: number, preferEnd = false): { node: Text; offset: number } | null {
    if (!this.nodes.length) return null
    const { node, offset: off } = locateIn(this.prefix, Math.max(0, Math.min(offset, this.length)), preferEnd)
    return { node: this.nodes[node], offset: off }
  }

  range(start: number, end: number): Range | null {
    const a = this.point(start)
    const b = this.point(Math.max(start, end), true)
    if (!a || !b) return null
    const r = this.doc.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
    return r
  }

  /** [start, 节末] (含其后的非文本内容), 隐藏层用 */
  rangeToEnd(start: number): Range | null {
    const a = this.point(start)
    const body = this.doc.body
    if (!a || !body) return null
    const r = this.doc.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(body, body.childNodes.length)
    return r
  }

  slice(start: number, end: number): string {
    if (end <= start || !this.nodes.length) return ''
    const a = locateIn(this.prefix, start)
    const b = locateIn(this.prefix, end, true)
    if (a.node === b.node) return this.nodes[a.node].data.slice(a.offset, b.offset)
    let out = this.nodes[a.node].data.slice(a.offset)
    for (let i = a.node + 1; i < b.node; i++) out += this.nodes[i].data
    return out + this.nodes[b.node].data.slice(0, b.offset)
  }

  /** 第 i 个文本节点不占时间: 注音, 或 display:none (没有 client rects) */
  silent(i: number): boolean {
    if (this.muted[i]) return true
    let h = this.#hidden[i]
    if (h < 0) {
      const parent = this.nodes[i].parentElement
      h = parent && parent.getClientRects().length === 0 ? 1 : 0
      this.#hidden[i] = h
    }
    return h === 1
  }

  /** [start, end) 内不占时间的区间 (窗口内偏移) */
  silentSpans(start: number, end: number): Array<[number, number]> {
    const out: Array<[number, number]> = []
    if (end <= start || !this.nodes.length) return out
    const first = locateIn(this.prefix, start).node
    for (let i = first; i < this.nodes.length && this.prefix[i] < end; i++) {
      if (!this.silent(i)) continue
      const s = Math.max(this.prefix[i], start) - start
      const e = Math.min(this.prefix[i + 1], end) - start
      const last = out[out.length - 1]
      if (last && last[1] === s) last[1] = e
      else out.push([s, e])
    }
    return out
  }

  /** offset 之后 (不含) 的第一个段落结束处; 没有则为节末 */
  breakAfter(offset: number): number {
    const i = upperBound(this.breaks, offset)
    return i < this.breaks.length ? this.breaks[i] : this.length
  }

  /** offset 之前 (不含) 的最后一个段落结束处; 没有则为 0 */
  breakBefore(offset: number): number {
    const i = upperBound(this.breaks, offset - 1) - 1
    return i >= 0 ? this.breaks[i] : 0
  }

  /** 第一个位置 ≥ from 的段落结束处 */
  breakAtOrAfter(from: number): number {
    const i = upperBound(this.breaks, from - 1)
    return i < this.breaks.length ? this.breaks[i] : this.length
  }
}

/** 升序数组里第一个 > x 的下标 */
export function upperBound(arr: ArrayLike<number>, x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function blockOf(node: Node): Element | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (BLOCK_TAGS.has(el.localName?.toLowerCase() ?? '')) return el
  }
  return null
}

function isMuted(node: Node): boolean {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const name = el.localName?.toLowerCase() ?? ''
    if (MUTE_TAGS.has(name)) return true
    if (name === 'ruby' || BLOCK_TAGS.has(name)) return false
  }
  return false
}
