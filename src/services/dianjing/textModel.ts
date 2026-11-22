/**
 * 一节文档的「段 → 句」文本模型, 编号与听书的 SentenceCursor 一致:
 * 段的切分同 readAloud.collectBlocks (相邻块级元素起点之间为一段, 空段跳过),
 * 段内用同一个 splitSentences 断句。区别是这里一次遍历建好所有段的文本节点 (O(n)),
 * 20 万字的 TXT 单节也不会因逐段回溯而变慢; 句子 Range 惰性创建。
 *
 * 文档可能是 foliate 的 iframe 文档, 也可能是 section.createDocument() 得到的未渲染文档 (预取下一章):
 * 两者结构相同, 文本相同, 所以块 hash 相同、缓存可共用。
 * Range / Node 来自另一个 realm: 一律不用 instanceof, 只用 nodeType 与方法鸭子类型。
 */
import { locateOffset, splitSentences, type Span } from '../readAloud.ts'
import type { SectionBlock } from './chunker.ts'
import { INERT_ATTR } from '../bilingualCore.ts'

const BLOCK_TAGS = new Set([
  'article', 'aside', 'audio', 'blockquote', 'caption',
  'details', 'dialog', 'div', 'dl', 'dt', 'dd',
  'figure', 'footer', 'form', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li',
  'main', 'math', 'nav', 'ol', 'p', 'pre', 'section', 'tr',
])
const SKIP_TAGS = new Set(['script', 'style', 'rt', 'rp'])

interface BlockData {
  /** 段起点元素 (无块级元素时为 body) */
  el: Element
  nodes: Text[]
  text: string
  lengths: number[]
  spans?: Span[]
}

export class SectionTextModel {
  readonly doc: Document
  readonly lang: string
  #blocks: BlockData[] = []
  #nodeBlock = new Map<Node, number>()

  constructor(doc: Document, lang?: string) {
    this.doc = doc
    this.lang = lang || doc.documentElement?.lang || doc.body?.lang || 'zh'
    this.#build()
  }

  #build() {
    const body = this.doc.body
    if (!body) return
    let cur: BlockData | null = null
    let sawBlock = false
    const pre: Text[] = [] // 第一个块级元素之前的文字 (只在全文没有块级元素时成段)
    const flush = () => {
      if (cur && cur.text.trim()) {
        const idx = this.#blocks.length
        this.#blocks.push(cur)
        for (const n of cur.nodes) this.#nodeBlock.set(n, idx)
      }
    }
    const walker = this.doc.createTreeWalker(body, 0x1 | 0x4, {
      acceptNode: (n: Node) => {
        if (n.nodeType === 1 && (SKIP_TAGS.has((n as Element).tagName.toLowerCase()) || (n as Element).hasAttribute(INERT_ATTR))) return 2 // REJECT (含双语译文)
        return 1 // ACCEPT
      },
    })
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 1) {
        if (!BLOCK_TAGS.has((n as Element).tagName.toLowerCase())) continue
        flush()
        sawBlock = true
        cur = { el: n as Element, nodes: [], text: '', lengths: [] }
        continue
      }
      const t = n as Text
      if (!cur) { pre.push(t); continue }
      cur.nodes.push(t)
      cur.lengths.push(t.data.length)
      cur.text += t.data
    }
    flush()
    if (!sawBlock && pre.length) {
      cur = { el: body, nodes: pre, text: pre.map(t => t.data).join(''), lengths: pre.map(t => t.data.length) }
      flush()
    }
  }

  get blockCount() { return this.#blocks.length }

  /** 段的句子区间 (段内偏移) */
  spans(block: number): Span[] {
    const b = this.#blocks[block]
    if (!b) return []
    b.spans ??= splitSentences(b.text.replace(/\r/g, ' '), this.lang)
    return b.spans
  }

  sentenceTexts(block: number): string[] {
    const b = this.#blocks[block]
    return b ? this.spans(block).map(s => b.text.slice(s.start, s.end)) : []
  }

  /** 供分块: 全部段的句子文本 (从 from 段起, 可限制段数) */
  sectionBlocks(from = 0, count = Infinity): SectionBlock[] {
    const out: SectionBlock[] = []
    for (let i = from; i < this.#blocks.length && out.length < count; i++) out.push({ block: i, sentences: this.sentenceTexts(i) })
    return out
  }

  blockElement(block: number): Element | null {
    return this.#blocks[block]?.el ?? null
  }

  /** 段内 [start, end) 偏移 → Range */
  rangeOf(block: number, start: number, end: number): Range | null {
    const b = this.#blocks[block]
    if (!b || end <= start) return null
    const a = locateOffset(b.lengths, start)
    const z = locateOffset(b.lengths, end, true)
    try {
      const r = this.doc.createRange()
      r.setStart(b.nodes[a.node], a.offset)
      r.setEnd(b.nodes[z.node], z.offset)
      return r
    } catch { return null }
  }

  sentenceRange(block: number, sentence: number): Range | null {
    const s = this.spans(block)[sentence]
    return s ? this.rangeOf(block, s.start, s.end) : null
  }

  /** 句内 [start, end) (相对句首) → Range */
  termRange(block: number, sentence: number, start: number, end: number): Range | null {
    const s = this.spans(block)[sentence]
    if (!s) return null
    return this.rangeOf(block, s.start + start, Math.min(s.end, s.start + end))
  }

  sentenceLength(block: number, sentence: number): number {
    const s = this.spans(block)[sentence]
    return s ? s.end - s.start : 0
  }

  /**
   * 一个 DOM 点所在的 (段, 句)。点在元素上时取其后第一个文本节点。
   * 找不到返回 null。
   */
  locate(node: Node | null | undefined, offset: number): { block: number; sentence: number } | null {
    if (!node) return null
    let text: Node | null = node
    let off = offset
    if (node.nodeType !== 3) {
      const child = node.childNodes?.[offset] ?? null
      const walker = this.doc.createTreeWalker(this.doc.body ?? this.doc, 0x4)
      walker.currentNode = child ?? node
      text = child && child.nodeType === 3 ? child : walker.nextNode()
      off = 0
    }
    // 落在跳过的节点 (rt 等) 或段外: 往后找最近的已知文本节点
    let guard = 0
    while (text && !this.#nodeBlock.has(text) && guard++ < 200) {
      const walker = this.doc.createTreeWalker(this.doc.body ?? this.doc, 0x4)
      walker.currentNode = text
      text = walker.nextNode()
      off = 0
    }
    if (!text) return null
    const block = this.#nodeBlock.get(text)!
    const b = this.#blocks[block]
    let pos = 0
    for (let i = 0; i < b.nodes.length; i++) {
      if (b.nodes[i] === text) { pos += Math.min(off, b.lengths[i]); break }
      pos += b.lengths[i]
    }
    const spans = this.spans(block)
    for (let s = 0; s < spans.length; s++) if (pos < spans[s].end) return { block, sentence: s }
    return spans.length ? { block, sentence: spans.length - 1 } : { block, sentence: 0 }
  }

  /** 全节字数 (不含空白), 用于进度与 60% 预取判断 */
  totalChars(): number {
    return this.charsBefore(this.#blocks.length)
  }

  #cum: number[] | null = null

  /** 第 block 段之前的字数 (不含空白); 前缀和惰性计算一次 */
  charsBefore(block: number): number {
    if (!this.#cum) {
      const cum = [0]
      for (const b of this.#blocks) cum.push(cum[cum.length - 1] + b.text.replace(/\s+/g, '').length)
      this.#cum = cum
    }
    return this.#cum[Math.max(0, Math.min(block, this.#blocks.length))]
  }
}
