/**
 * 歌词模式控制器 (DOM, docs/research/reading-modes-landscape.md §4)。
 *
 * 前提: 阅读器已临时切到滚动排版、单栏 (useReadingModes 负责, 退出时恢复)。滚动排版下 foliate 的
 * iframe 与内容等高、自身不滚动, 由外层 container 滚动, 所以 Range.getClientRects() 的坐标就是
 * 分节文档坐标, 行框测一次可以一直用到重排为止。
 *
 * - 行: 当前行前后一段文本 (约 800 + 2500 字, 段落边界截断) 按出字单位取 rect.top → pacing.groupLines,
 *   前进到窗口末尾附近时再补测; 重排 (改字号、窗口尺寸) 后以当前行的字符偏移为锚点重测。
 * - 呈现: CSS Custom Highlight `lr-ly-dim` / `lr-ly-hide` 覆盖「全节减去聚焦带」, 只改颜色, 不改 DOM;
 *   旧 WebView 改用 foliate overlayer 在聚焦带上下各画一块主题背景色矩形。3 行时左侧画一条强调色竖条。
 * - 定位: 当前行中心固定在视口 anchor (默认 38.2%) 处, 平滑滚动 250ms; 减少动效 / 墨水屏直接跳,
 *   墨水屏改为「整屏跳」(当前行越过 80% 才一次性放回 10% 处)。
 * - 推进: pace 按 字/分 逐行停留 (lyric.lineDwellMs); tts 由 followRange 驱动 (句子跨行时按估计语速逐行);
 *   manual 只响应 next / prev / 点按。
 * - 手动滚动: 暂停跟随 (detached), 通知外壳显示「回到当前行」; 不会自动回弹。
 * - 任何异常都 stop() 并清除压暗, 绝不把正文留在淡显状态。
 */
import { SectionText } from './blocks.ts'
import { tokenize } from './pacing.ts'
import {
  einkJumpDelta,
  focusWindow,
  lineAt,
  lineDwellMs,
  lineIndexOf,
  lineSide,
  lineSpans,
  pinDelta,
  updateFollowRate,
  type LyricLine,
  type LyricLineKind,
} from './lyric.ts'
import { clearReadingModeMarks, supportsHighlights, type RevealColors } from './revealLayer.ts'

export type LyricState = 'idle' | 'running' | 'paused' | 'turning'
export type LyricDriver = 'pace' | 'tts' | 'manual'
export type LyricSide = 'above' | 'below' | 'visible'

export const HL_LY_DIM = 'lr-ly-dim'
export const HL_LY_HIDE = 'lr-ly-hide'
export const LYRIC_PREFIX = 'lr-ly-'
const OV_MASK = 'lr-ly-mask'
const OV_BAR = 'lr-ly-bar'
const SVG_NS = 'http://www.w3.org/2000/svg'

const MEASURE_BEFORE = 800
const MEASURE_AFTER = 2500
const MEASURE_MAX = 6000
const SCROLL_MS = 250
const CHAPTER_CARD_MS = 1200
const SECTION_WATCHDOG_MS = 4000
/** 跟听书时句内逐行的默认语速 (毫秒/字当量), 第二句之后改用实测 */
const DEFAULT_FOLLOW_RATE = 240

export interface LyricConfig {
  lines: number
  others: 'dim' | 'hide'
  /** 当前行中心在视口高度的位置 (0.4 / 0.5) */
  anchor: number
  driver: LyricDriver
  /** 字当量/分 (与打字机共用) */
  unitsPerMinute: number
  punctuationPause: boolean
  /** 平滑滚动 (减少动效 / 墨水屏时为 false) */
  smooth: boolean
  /** 墨水屏: 整屏跳, 竖条用正文色 */
  eink: boolean
}

export interface LyricHost {
  /** 当前显示的分节 (跨章连续滚动时为阅读线所在的主章) */
  contents(): { doc: Document; index: number; overlayer?: any } | null
  /** 指定文档所在的已渲染分节 (跨章连续滚动时同时有多个); 不提供时只认 contents() */
  contentOf?(doc: Document): { doc: Document; index: number; overlayer?: any } | null
  visibleRange(): Range | null
  /** 阅读区视口在宿主窗口中的位置 */
  viewportRect(): DOMRect | null
  /** 滚动排版的滚动位置 (renderer.start) 与上限 (viewSize − size) */
  getScroll(): number
  setScroll(px: number): void
  maxScroll(): number
  nextSection(): unknown
  atBookEnd(): boolean
  colors(): RevealColors
  lang(): string
}

export interface LyricEvents {
  onState?(state: LyricState): void
  /** 前进到新的一行 (阅读计时 ping) */
  onLine?(index: number): void
  /** 手动滚动后当前行在视口的哪一侧; null 表示回到跟随 */
  onDetach?(side: LyricSide | null): void
  /** 跟听书时点了另一行: 阅读器从这里重新朗读 */
  onSeek?(range: Range): void
  /** 平均每行字当量 (面板显示「≈ x 秒/行」) */
  onMeasure?(unitsPerLine: number): void
  onFinish?(reason: 'book-end' | 'error', error?: unknown): void
}

export type LyricTapResult = false | 'moved' | 'paused' | 'resumed' | 'menu'

const HEADING_RE = /^h[1-6]$/
const BLOCK_RE = /^(p|div|li|blockquote|section|article|h[1-6]|pre|td|th|dd|dt|figure|figcaption|body)$/

export class LyricController {
  #host: LyricHost
  #cfg: LyricConfig
  #ev: LyricEvents
  #state: LyricState = 'idle'

  #text: SectionText | null = null
  #section = -1
  #lines: LyricLine[] = []
  #winStart = 0
  #winEnd = 0
  #cur = 0
  /** 当前行起点的节内偏移: 重测后以它找回当前行 */
  #anchorOffset = 0
  #measured = false

  #hl: { dim: any; reg: any; name: string } | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  #dueAt = 0
  #remaining = 0
  #anim = 0
  #selfUntil = 0
  /** 上次定位后当前行顶在窗口中的 y: 滚动事件里当前行没动 (渲染器在视口上方插入 / 卸载分节后的补偿滚动) 不算手动滚动 */
  #pinnedTop: number | null = null
  #detached: LyricSide | null = null
  #wasRunning = false
  #turnTimer: ReturnType<typeof setTimeout> | undefined
  #watchdog: ReturnType<typeof setTimeout> | undefined
  #awaitingSection = false
  #remeasureTimer: ReturnType<typeof setTimeout> | undefined
  #ro: ResizeObserver | null = null

  #followTimers: Array<ReturnType<typeof setTimeout>> = []
  #followRate: number | null = null
  #lastFollow: { at: number; weight: number; paused: number } | null = null
  #followPausedAt = 0
  #followPausedTotal = 0
  #pendingFollow: Range | null = null

  constructor(host: LyricHost, cfg: LyricConfig, ev: LyricEvents = {}) {
    this.#host = host
    this.#cfg = { ...cfg }
    this.#ev = ev
  }

  get state(): LyricState { return this.#state }
  get active(): boolean { return this.#state !== 'idle' }
  get doc(): Document | null { return this.#text?.doc ?? null }
  /** 当前分节序号 */
  get section(): number { return this.#section }
  get driver(): LyricDriver { return this.#cfg.driver }
  get detached(): LyricSide | null { return this.#detached }
  get config(): Readonly<LyricConfig> { return this.#cfg }

  /** 当前行的 Range (退出时阅读器据此回到原处) */
  currentRange(): Range | null {
    const text = this.#text
    const line = this.#lines[this.#cur]
    if (!text || !line) return null
    return text.range(line.start, Math.max(line.start, line.end))
  }

  /**
   * 开始。from: 起点 Range (听书正在播放时为朗读句) 或节内偏移; 不传则从当前可见范围的第一行开始。
   * 没有可用的分节时返回 false。
   */
  start(from?: Range | number | null): boolean {
    this.stop()
    const c = this.#host.contents()
    if (!c?.doc?.body) return false
    try {
      this.#attach(c.doc, c.index)
      const text = this.#text!
      if (!text.length) {
        this.stop()
        return false
      }
      let offset = 0
      if (typeof from === 'number') offset = from
      else {
        const r = from ?? this.#host.visibleRange()
        if (r && r.startContainer?.ownerDocument === text.doc) offset = text.offsetOf(r.startContainer, r.startOffset)
      }
      this.#anchorOffset = Math.min(text.length, Math.max(0, offset))
      this.#measure(this.#anchorOffset)
      this.#cur = Math.max(0, lineIndexOf(this.#lines, this.#anchorOffset))
      // 可见范围从行中间开始 (上一屏末行露了半行): 取下一行
      const first = this.#lines[this.#cur]
      if (typeof from !== 'number' && !from && first && first.start < this.#anchorOffset && this.#cur + 1 < this.#lines.length) this.#cur++
      this.#anchorOffset = this.#lines[this.#cur]?.start ?? this.#anchorOffset
      this.#setState('running')
      this.#render()
      this.#pin(this.#cur, false)
      this.#ev.onLine?.(this.#cur)
      this.#schedule()
    } catch (e) {
      this.#fail(e)
      return false
    }
    return true
  }

  pause() {
    if (this.#state !== 'running' && this.#state !== 'turning') return
    if (this.#state === 'turning') {
      clearTimeout(this.#turnTimer)
      this.#turnTimer = undefined
    }
    if (this.#timer) {
      this.#remaining = Math.max(0, this.#dueAt - performance.now())
      clearTimeout(this.#timer)
      this.#timer = undefined
    } else this.#remaining = 0
    this.#clearFollowTimers()
    this.#setState('paused')
  }

  resume() {
    if (this.#state !== 'paused') return
    this.#setState('running')
    if (this.#detached) this.returnToCurrent()
    else this.#schedule(this.#remaining > 0 ? this.#remaining : undefined)
    this.#remaining = 0
    if (this.#pendingFollow) {
      const r = this.#pendingFollow
      this.#pendingFollow = null
      this.followRange(r)
    }
  }

  togglePause(): 'paused' | 'resumed' | null {
    if (this.#state === 'running' || this.#state === 'turning') {
      this.pause()
      return 'paused'
    }
    if (this.#state === 'paused') {
      this.resume()
      return 'resumed'
    }
    return null
  }

  /** 退出: 清除压暗, 正文恢复原样 */
  stop() {
    clearTimeout(this.#timer)
    clearTimeout(this.#turnTimer)
    clearTimeout(this.#watchdog)
    clearTimeout(this.#remeasureTimer)
    this.#timer = this.#turnTimer = this.#watchdog = this.#remeasureTimer = undefined
    this.#clearFollowTimers()
    this.#cancelAnim()
    this.#awaitingSection = false
    this.#teardownDoc()
    this.#text = null
    this.#lines = []
    this.#measured = false
    this.#pendingFollow = null
    this.#lastFollow = null
    if (this.#detached) {
      this.#detached = null
      this.#ev.onDetach?.(null)
    }
    this.#setState('idle')
  }

  dispose() { this.stop() }

  setConfig(partial: Partial<LyricConfig>) {
    const prev = this.#cfg
    this.#cfg = { ...prev, ...partial }
    const c = this.#cfg
    if (!this.active) return
    try {
      if (c.others !== prev.others || c.lines !== prev.lines || c.eink !== prev.eink) this.#render()
      if (c.anchor !== prev.anchor || c.eink !== prev.eink) this.#pin(this.#cur, false)
      if (c.driver !== prev.driver) {
        clearTimeout(this.#timer)
        this.#timer = undefined
        this.#clearFollowTimers()
        this.#lastFollow = null
        if (this.#state === 'paused' && c.driver !== 'pace') this.#setState('running')
        this.#schedule()
      } else if (c.unitsPerMinute !== prev.unitsPerMinute || c.punctuationPause !== prev.punctuationPause) {
        // 调速: 本行剩余停留按新速度折算
        if (this.#timer && this.#state === 'running') {
          const left = Math.max(0, this.#dueAt - performance.now())
          clearTimeout(this.#timer)
          this.#timer = undefined
          this.#schedule(left * (prev.unitsPerMinute / Math.max(1, c.unitsPerMinute)))
        }
      }
    } catch (e) {
      this.#fail(e)
    }
  }

  refreshColors() {
    if (this.active) this.#safe(() => this.#render())
  }

  // ---- 推进 ----

  next(): boolean { return this.#safe(() => this.#step(1)) ?? false }
  prev(): boolean { return this.#safe(() => this.#step(-1)) ?? false }

  /** 跳到第 index 行 (点按淡显的行) */
  jumpTo(index: number) {
    this.#safe(() => {
      if (index < 0 || index >= this.#lines.length) return
      this.#moveTo(index, true)
      clearTimeout(this.#timer)
      this.#timer = undefined
      this.#schedule()
    })
  }

  /** 「回到当前行」: 取消手动滚动的脱离状态, 回到当前行并继续 */
  returnToCurrent() {
    if (!this.active) return
    this.#safe(() => {
      const was = this.#wasRunning
      this.#detached = null
      this.#wasRunning = false
      this.#ev.onDetach?.(null)
      this.#pin(this.#cur, this.#cfg.smooth)
      if (this.#state === 'paused' && was) this.#setState('running')
      if (this.#state === 'running') this.#schedule(this.#remaining > 0 ? this.#remaining : undefined)
      this.#remaining = 0
    })
  }

  /**
   * 跟听书: 听书每句开始出声时调用 (阅读器 onSentenceStart → listenRange)。当前句所在行成为聚焦行;
   * 句子跨行时按估计语速逐行前移。分节不同 (还没翻过去) 时忽略, 等 onSectionLoad 后的下一句。
   */
  followRange(range: Range) {
    if (!this.active || this.#cfg.driver !== 'tts' || !range) return
    const text = this.#text
    if (!text || range.startContainer?.ownerDocument !== text.doc) return
    if (this.#state === 'paused') {
      this.#pendingFollow = range
      return
    }
    this.#safe(() => {
      const now = performance.now()
      const start = text.offsetOf(range.startContainer, range.startOffset)
      const end = Math.max(start, text.offsetOf(range.endContainer, range.endOffset))
      if (this.#lastFollow) {
        const elapsed = now - this.#lastFollow.at - (this.#followPausedTotal - this.#lastFollow.paused)
        this.#followRate = updateFollowRate(this.#followRate, elapsed, this.#lastFollow.weight)
      }
      this.#ensureLines(start)
      const i0 = Math.max(0, lineIndexOf(this.#lines, start))
      const i1 = Math.max(i0, lineIndexOf(this.#lines, Math.max(start, end - 1)))
      // 这句话在各行里的字当量 (按字符重叠比例分摊)
      const weights: number[] = []
      for (let i = i0; i <= i1; i++) {
        const l = this.#lines[i]
        const span = Math.max(1, l.end - l.start)
        const overlap = Math.max(0, Math.min(l.end, end) - Math.max(l.start, start))
        weights.push(l.weight * Math.min(1, overlap / span))
      }
      const total = weights.reduce((s, w) => s + w, 0)
      this.#lastFollow = { at: now, weight: total, paused: this.#followPausedTotal }
      this.#clearFollowTimers()
      this.#moveTo(i0, true)
      if (i1 > i0) {
        const rate = this.#followRate ?? DEFAULT_FOLLOW_RATE
        let acc = 0
        for (let k = 0; k < weights.length - 1; k++) {
          acc += weights[k]
          const idx = i0 + k + 1
          this.#followTimers.push(setTimeout(() => this.#safe(() => {
            if (this.#state === 'running' && this.#cfg.driver === 'tts' && idx < this.#lines.length) this.#moveTo(idx, true)
          }), acc * rate))
        }
      }
    })
  }

  /** 听书暂停 / 继续 (跟听书时由阅读器转告) */
  setFollowPaused(paused: boolean) {
    if (paused) {
      if (!this.#followPausedAt) this.#followPausedAt = performance.now()
      this.#clearFollowTimers()
    } else if (this.#followPausedAt) {
      this.#followPausedTotal += performance.now() - this.#followPausedAt
      this.#followPausedAt = 0
    }
  }

  /**
   * 轻点正文。y 为点在分节文档里的纵坐标 (iframe 内 clientY), 不知道时传 null。
   * - 脱离跟随时: 回到当前行;
   * - 点了聚焦带以外的行: 跳到那一行 (跟听书时还让听书从那一句读);
   * - 手动: 点视口下半部分下一行, 上半部分上一行;
   * - 自动: 暂停 / 继续; 跟听书: 'menu' (阅读器切换工具栏)。
   */
  tap(y: number | null): LyricTapResult {
    if (!this.active) return false
    return this.#safe((): LyricTapResult => {
      if (this.#detached) {
        this.returnToCurrent()
        return 'resumed'
      }
      const idx = y == null ? -1 : lineAt(this.#lines, y)
      const [lo, hi] = focusWindow(this.#cur, this.#cfg.lines, this.#lines.length)
      if (idx >= 0 && (idx < lo || idx > hi)) {
        this.jumpTo(idx)
        if (this.#cfg.driver === 'tts') {
          const r = this.currentRange()
          if (r) this.#ev.onSeek?.(r)
        }
        return 'moved'
      }
      if (this.#cfg.driver === 'manual') {
        const vp = this.#host.viewportRect()
        const frame = this.#frameTop()
        const lower = y == null || !vp || frame == null ? true : frame + y >= vp.top + vp.height / 2
        this.#step(lower ? 1 : -1)
        return 'moved'
      }
      if (this.#cfg.driver === 'pace') return this.togglePause() ?? false
      return 'menu'
    }) ?? false
  }

  /** 当前行在视口内 (尚未测量时视为在); 文档已卸载为 false */
  currentInView(): boolean {
    if (!this.active || !this.#text) return false
    const line = this.#lines[this.#cur]
    if (!this.#measured || !line) return true
    const vp = this.#host.viewportRect()
    const frame = this.#frameTop()
    if (frame == null) return false
    if (!vp) return true
    return lineSide(frame + line.top, frame + line.bottom, vp.top, vp.height) == null
  }

  /** 外层容器滚动 (renderer 'scroll' 事件): 区分自己的滚动与用户手动滚动 */
  onScroll() {
    if (!this.active || !this.#measured) return
    if (performance.now() < this.#selfUntil) return
    // 章末等待进入下一节: 渲染器滚向下一节的滚动不是用户操作
    if (this.#awaitingSection) return
    // 当前行在窗口中的位置没变: 是渲染器的补偿滚动 (跨章连续滚动时在视口上方插入 / 卸载分节), 不是手动滚动
    if (this.#pinnedTop != null && !this.#detached) {
      const line = this.#lines[this.#cur]
      const frame = this.#frameTop()
      if (line && frame != null && Math.abs(frame + line.top - this.#pinnedTop) < 2) return
    }
    this.#safe(() => {
      const side = this.#sideOfCurrent() ?? 'visible'
      // 手动换行时当前行还在屏上: 不算离开。放大焦点行 (×1.4) 后换行会改变上方行高, 浏览器的滚动锚定
      // 随之微调滚动位置, 被当成手动滚动, 就会误显示「回到当前行」并吃掉下一次轻点 (K30 实测 2/8 次)。
      // 手动模式下没有自动推进, 不需要为这种滚动暂停; 下一次换行会重新定位。
      if (side === 'visible' && !this.#detached && this.#cfg.driver === 'manual') return
      if (!this.#detached) {
        this.#wasRunning = this.#state === 'running' && this.#cfg.driver === 'pace'
        if (this.#timer) {
          this.#remaining = Math.max(0, this.#dueAt - performance.now())
          clearTimeout(this.#timer)
          this.#timer = undefined
        }
      }
      if (side !== this.#detached) {
        this.#detached = side
        this.#ev.onDetach?.(side)
      }
    })
  }

  /** foliate relocate: 跳转 (目录、搜索) 时以新位置为当前行; 重排后以当前行偏移重测 */
  onRelocate(detail: { range?: Range | null; reason?: string } | null | undefined) {
    const text = this.#text
    const range = detail?.range
    if (!this.active || !text || !range) return
    if (range.startContainer?.ownerDocument !== text.doc) return
    if (detail?.reason === 'scroll') return
    // 自己的平滑滚动途中 (跨章连续滚动时渲染器在滚动中节流派发 relocate): 不重测, 免得打断动画直接跳过去
    if (performance.now() < this.#selfUntil && detail?.reason !== 'navigation' && detail?.reason !== 'selection') return
    if (detail?.reason === 'navigation' || detail?.reason === 'selection') {
      this.#anchorOffset = text.offsetOf(range.startContainer, range.startOffset)
      this.#detached = null
      this.#ev.onDetach?.(null)
    }
    this.#scheduleRemeasure(60)
  }

  /**
   * foliate load: 换节 (章末自动进入下一章, 或用户跳到别的章节)。跨章连续滚动时由主章切换 (section-change) 驱动;
   * from: 新分节里的起点 (用户滚过去时的可见范围), 不传从节首开始
   */
  onSectionLoad(doc: Document, index: number, from?: Range | null) {
    if (!this.active || !doc || this.#text?.doc === doc) return
    this.#safe(() => {
      clearTimeout(this.#watchdog)
      this.#watchdog = undefined
      const wasTurning = this.#state === 'turning' || this.#awaitingSection
      this.#awaitingSection = false
      this.#attach(doc, index)
      this.#anchorOffset = from && from.startContainer?.ownerDocument === doc
        ? this.#text!.offsetOf(from.startContainer, from.startOffset)
        : 0
      this.#cur = 0
      this.#lines = []
      this.#measured = false
      if (wasTurning) this.#setState('running')
      // 新分节在首次绘制前先整体压暗, 布局稳定后再测量定位
      this.#renderAllDim()
      this.#scheduleRemeasure(120)
    })
  }

  // ---- 内部 ----

  #setState(s: LyricState) {
    if (s === this.#state) return
    this.#state = s
    this.#ev.onState?.(s)
  }

  #safe<T>(fn: () => T): T | undefined {
    try {
      return fn()
    } catch (e) {
      this.#fail(e)
      return undefined
    }
  }

  #fail(e: unknown) {
    console.error('lyric mode failed', e)
    this.stop()
    this.#ev.onFinish?.('error', e)
  }

  #attach(doc: Document, index: number) {
    this.#teardownDoc()
    this.#text = new SectionText(doc)
    this.#section = index
    this.#pinnedTop = null
    const win = doc.defaultView as any
    if (supportsHighlights(win)) {
      const dim = new win.Highlight()
      try { dim.priority = 90 } catch { /* 旧实现无 priority */ }
      this.#hl = { dim, reg: win.CSS.highlights, name: '' }
    } else this.#hl = null
    // 重排 (字号、窗口宽度) 后重测
    try {
      const RO = win?.ResizeObserver ?? (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null)
      if (RO && doc.body) {
        let first = true
        this.#ro = new RO(() => {
          if (first) { first = false; return }
          this.#scheduleRemeasure(150)
        })
        this.#ro!.observe(doc.body)
      }
    } catch { /* 忽略 */ }
  }

  #teardownDoc() {
    try { this.#ro?.disconnect() } catch { /* 忽略 */ }
    this.#ro = null
    const doc = this.#text?.doc
    if (this.#hl) {
      try {
        this.#hl.dim.clear()
        for (const name of [HL_LY_DIM, HL_LY_HIDE]) if (this.#hl.reg.get(name) === this.#hl.dim) this.#hl.reg.delete(name)
      } catch { /* 文档已卸载 */ }
      this.#hl = null
    }
    const ov = this.#overlayer()
    try { ov?.remove(OV_MASK) } catch { /* 忽略 */ }
    try { ov?.remove(OV_BAR) } catch { /* 忽略 */ }
    clearReadingModeMarks(doc, [LYRIC_PREFIX])
  }

  #overlayer(): any {
    const doc = this.#text?.doc
    if (!doc) return null
    const c = this.#host.contentOf ? this.#host.contentOf(doc) : this.#host.contents()
    return c && c.doc === doc ? c.overlayer : null
  }

  /** 记下当前行此刻在窗口中的位置 (见 #pinnedTop) */
  #notePinned() {
    const line = this.#lines[this.#cur]
    const frame = this.#frameTop()
    this.#pinnedTop = line && frame != null ? frame + line.top : null
  }

  #frameTop(): number | null {
    const frame = this.#text?.doc.defaultView?.frameElement as Element | null | undefined
    return frame ? frame.getBoundingClientRect().top : null
  }

  #clearFollowTimers() {
    for (const t of this.#followTimers) clearTimeout(t)
    this.#followTimers = []
  }

  #scheduleRemeasure(ms: number) {
    clearTimeout(this.#remeasureTimer)
    this.#remeasureTimer = setTimeout(() => {
      this.#remeasureTimer = undefined
      if (!this.active || !this.#text) return
      this.#safe(() => {
        this.#measure(this.#anchorOffset)
        this.#cur = Math.max(0, lineIndexOf(this.#lines, this.#anchorOffset))
        this.#render()
        if (!this.#detached) this.#pin(this.#cur, false)
        if (this.#state === 'running' && !this.#timer) this.#schedule()
      })
    }, ms)
  }

  /** 测量 around 前后一段文本的视觉行 */
  #measure(around: number) {
    const text = this.#text!
    const len = text.length
    let a = around > MEASURE_BEFORE ? text.breakBefore(around - MEASURE_BEFORE) : 0
    if (a > around) a = 0
    let b = text.breakAtOrAfter(Math.min(len, Math.max(around, a) + MEASURE_AFTER))
    if (b - a > MEASURE_MAX) b = Math.min(len, Math.max(around + MEASURE_AFTER, a + MEASURE_MAX))
    if (b <= a) b = len
    const str = text.slice(a, b)
    const lang = this.#host.lang()
    const tokens = tokenize(str, lang, { wholeWords: true })
    for (const [s, e] of text.silentSpans(a, b)) {
      for (const tok of tokens) {
        if (tok.start >= s && tok.end <= e && tok.weight > 0) {
          tok.weight = 0
          tok.kind = 'space'
        }
      }
    }
    const scrollY = text.doc.defaultView?.scrollY ?? 0
    const weighted = tokens.filter(t => t.weight > 0)
    const tops: number[] = []
    const bottoms: number[] = []
    const lefts: number[] = []
    const heights: number[] = []
    for (const tok of weighted) {
      const r = text.range(a + tok.start, a + tok.end)
      const rect = r ? Array.from(r.getClientRects()).find(x => x.width > 0 && x.height > 0) : undefined
      if (rect) {
        tops.push(rect.top + scrollY)
        bottoms.push(rect.bottom + scrollY)
        lefts.push(rect.left)
        heights.push(rect.height)
      } else {
        tops.push(NaN)
        bottoms.push(NaN)
        lefts.push(NaN)
      }
    }
    heights.sort((x, y) => x - y)
    const lineHeight = heights.length ? heights[heights.length >> 1] : 20
    const breaks = text.breaks.filter(x => x > a && x <= b).map(x => x - a)
    const spans = lineSpans(tokens, tops, lineHeight, breaks)
    const lines: LyricLine[] = []
    let p = 0
    for (const sp of spans) {
      let top = Infinity
      let bottom = -Infinity
      let left = Infinity
      let firstTok = -1
      while (p < weighted.length && weighted[p].start < sp.end) {
        if (Number.isFinite(tops[p])) {
          top = Math.min(top, tops[p])
          bottom = Math.max(bottom, bottoms[p])
          left = Math.min(left, lefts[p])
          if (firstTok < 0) firstTok = p
        }
        p++
      }
      if (!Number.isFinite(top)) continue
      lines.push({
        ...sp,
        start: sp.start + a,
        end: sp.end + a,
        top,
        bottom,
        left,
        kind: firstTok >= 0 ? this.#kindAt(a + weighted[firstTok].start) : 'text',
      })
    }
    // 图片等原子块: 整块作为一行, 不压暗, 停留按高度
    const vpH = this.#host.viewportRect()?.height || 600
    for (const atom of text.atoms) {
      if (atom.offset < a || atom.offset > b) continue
      const rect = atom.el.getBoundingClientRect()
      if (rect.height < 24 || rect.width < 24) continue
      lines.push({
        start: atom.offset,
        end: atom.offset,
        weight: 0,
        pause: 0,
        para: true,
        top: rect.top + scrollY,
        bottom: rect.bottom + scrollY,
        left: rect.left,
        kind: 'atom',
        el: atom.el,
        ratio: rect.height / vpH,
      })
    }
    lines.sort((x, y) => x.top - y.top || x.start - y.start)
    this.#lines = lines
    this.#winStart = a
    this.#winEnd = b
    this.#measured = true
    const textLines = lines.filter(l => l.kind === 'text' && l.weight > 0)
    if (textLines.length) {
      const ws = textLines.map(l => l.weight).sort((x, y) => x - y)
      this.#ev.onMeasure?.(ws[ws.length >> 1])
    }
  }

  #kindAt(offset: number): LyricLineKind {
    const pt = this.#text!.point(offset)
    for (let el = pt?.node.parentElement ?? null; el; el = el.parentElement) {
      const name = el.localName?.toLowerCase() ?? ''
      if (HEADING_RE.test(name)) return 'heading'
      if (name === 'pre') return 'code'
      if (BLOCK_RE.test(name)) return 'text'
    }
    return 'text'
  }

  /** 保证第 index 行附近有测量结果 (前进到窗口边缘时补测) */
  #ensureLines(offset: number) {
    const text = this.#text!
    const n = this.#lines.length
    const outside = !n || offset < this.#winStart || offset >= this.#winEnd
    const nearEnd = n > 0 && this.#winEnd < text.length && lineIndexOf(this.#lines, offset) >= n - 3
    const nearStart = n > 0 && this.#winStart > 0 && lineIndexOf(this.#lines, offset) <= 1
    if (outside || nearEnd || nearStart) {
      this.#measure(offset)
      this.#cur = Math.max(0, lineIndexOf(this.#lines, this.#anchorOffset))
    }
  }

  #step(dir: 1 | -1): boolean {
    const text = this.#text
    if (!text || !this.#lines.length) return false
    const target = this.#cur + dir
    if (target >= this.#lines.length - 3 || target <= 1) {
      const probe = this.#lines[Math.min(this.#lines.length - 1, Math.max(0, target))]
      this.#ensureLines(probe.start)
    }
    const idx = this.#cur + dir
    if (idx >= this.#lines.length) {
      if (this.#winEnd >= text.length) this.#endOfSection()
      return false
    }
    if (idx < 0) return false
    this.#moveTo(idx, true)
    clearTimeout(this.#timer)
    this.#timer = undefined
    this.#schedule()
    return true
  }

  #moveTo(index: number, smooth: boolean) {
    this.#cur = index
    this.#anchorOffset = this.#lines[index].start
    this.#render()
    if (this.#detached) {
      const side = this.#sideOfCurrent() ?? 'visible'
      if (side !== this.#detached) {
        this.#detached = side
        this.#ev.onDetach?.(side)
      }
    } else this.#pin(index, smooth && this.#cfg.smooth)
    this.#ev.onLine?.(index)
  }

  #schedule(ms?: number) {
    if (this.#state !== 'running' || this.#cfg.driver !== 'pace' || this.#detached || this.#timer) return
    const line = this.#lines[this.#cur]
    if (!line) return
    const dwell = ms ?? lineDwellMs(line, this.#cfg.unitsPerMinute, { punctuationPause: this.#cfg.punctuationPause })
    this.#dueAt = performance.now() + dwell
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (this.#state === 'running') this.#safe(() => this.#step(1))
    }, dwell)
  }

  #endOfSection() {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#host.atBookEnd()) {
      this.stop()
      this.#ev.onFinish?.('book-end')
      return
    }
    if (this.#cfg.driver === 'tts') return // 听书自己会翻到下一章
    this.#setState('turning')
    clearTimeout(this.#turnTimer)
    this.#turnTimer = setTimeout(() => {
      this.#turnTimer = undefined
      if (this.#state !== 'turning') return
      this.#awaitingSection = true
      clearTimeout(this.#watchdog)
      this.#watchdog = setTimeout(() => {
        // 迟迟没有进入下一节: 停在当前节末, 暂停
        if (this.#awaitingSection && this.#state === 'turning') {
          this.#awaitingSection = false
          this.#setState('paused')
        }
      }, SECTION_WATCHDOG_MS)
      try {
        void Promise.resolve(this.#host.nextSection()).catch(e => console.warn('lyric: next section failed', e))
      } catch (e) {
        console.warn('lyric: next section failed', e)
      }
    }, CHAPTER_CARD_MS)
  }

  #sideOfCurrent(): 'above' | 'below' | null {
    const line = this.#lines[this.#cur]
    const vp = this.#host.viewportRect()
    const frame = this.#frameTop()
    if (!line || !vp || frame == null) return null
    return lineSide(frame + line.top, frame + line.bottom, vp.top, vp.height)
  }

  #pin(index: number, smooth: boolean) {
    const line = this.#lines[index]
    const vp = this.#host.viewportRect()
    const frame = this.#frameTop()
    if (!line || !vp || frame == null || vp.height <= 0) return
    const top = frame + line.top
    const bottom = frame + line.bottom
    let delta: number | null
    if (this.#cfg.eink) delta = einkJumpDelta(top, bottom, vp.top, vp.height)
    else if (line.kind === 'atom' && bottom - top > vp.height * (1 - this.#cfg.anchor)) {
      // 超出视口的大图: 顶部对齐锚点
      delta = top - (vp.top + vp.height * this.#cfg.anchor)
    } else delta = pinDelta(top, bottom, vp.top, vp.height, this.#cfg.anchor)
    if (delta == null || Math.abs(delta) < 1) {
      this.#notePinned()
      return
    }
    this.#scrollBy(delta, smooth && !this.#cfg.eink)
  }

  #cancelAnim() {
    if (this.#anim) cancelAnimationFrame(this.#anim)
    this.#anim = 0
  }

  #scrollBy(delta: number, smooth: boolean) {
    const from = this.#host.getScroll()
    const to = Math.max(0, Math.min(this.#host.maxScroll(), from + delta))
    this.#cancelAnim()
    if (Math.abs(to - from) < 1) {
      this.#notePinned()
      return
    }
    const set = (px: number) => {
      this.#selfUntil = performance.now() + 160
      this.#host.setScroll(px)
      this.#notePinned()
    }
    if (!smooth) {
      set(to)
      return
    }
    const t0 = performance.now()
    const frame = (now: number) => {
      const f = Math.min(1, (now - t0) / SCROLL_MS)
      const eased = 1 - Math.pow(1 - f, 3)
      set(from + (to - from) * eased)
      this.#anim = f < 1 ? requestAnimationFrame(frame) : 0
    }
    this.#anim = requestAnimationFrame(frame)
  }

  /** 新分节在测量前整节压暗, 避免先闪一下全亮 */
  #renderAllDim() {
    const text = this.#text
    if (!text) return
    const all = text.rangeToEnd(0)
    this.#paint(all ? [all] : [], null)
  }

  #render() {
    const text = this.#text
    if (!text) return
    const n = this.#lines.length
    if (!n) {
      this.#paint([], null)
      return
    }
    const [lo, hi] = focusWindow(this.#cur, this.#cfg.lines, n)
    const fs = this.#lines[lo].start
    const fe = Math.max(fs, this.#lines[hi].end)
    const ranges: Range[] = []
    if (fs > 0) {
      const r = text.range(0, fs)
      if (r && !r.collapsed) ranges.push(r)
    }
    const tail = text.rangeToEnd(fe)
    if (tail && !tail.collapsed) ranges.push(tail)
    let top = Infinity
    let bottom = -Infinity
    let left = Infinity
    for (let i = lo; i <= hi; i++) {
      top = Math.min(top, this.#lines[i].top)
      bottom = Math.max(bottom, this.#lines[i].bottom)
      left = Math.min(left, this.#lines[i].left)
    }
    this.#paint(ranges, { top, bottom, left, range: text.range(fs, Math.max(fs, fe)) })
  }

  #paint(ranges: Range[], focus: { top: number; bottom: number; left: number; range: Range | null } | null) {
    const hl = this.#hl
    const name = this.#cfg.others === 'hide' ? HL_LY_HIDE : HL_LY_DIM
    if (hl) {
      if (hl.name !== name) {
        if (hl.name && hl.reg.get(hl.name) === hl.dim) hl.reg.delete(hl.name)
        hl.reg.set(name, hl.dim)
        hl.name = name
      } else if (hl.reg.get(name) !== hl.dim) hl.reg.set(name, hl.dim)
      hl.dim.clear()
      for (const r of ranges) hl.dim.add(r)
    }
    const ov = this.#overlayer()
    if (!ov) return
    const colors = this.#host.colors()
    const doc = this.#text!.doc
    const anchor = focus?.range && !focus.range.collapsed ? focus.range : (() => {
      const r = doc.createRange()
      if (doc.body) r.selectNodeContents(doc.body)
      return r
    })()
    try {
      // 回退路径: 聚焦带上下各一块主题背景色矩形 (淡显 70% / 隐藏 100%)
      if (!hl) {
        const width = Math.max(doc.documentElement.scrollWidth, doc.body?.scrollWidth ?? 0)
        const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0)
        const opacity = this.#cfg.others === 'hide' ? '1' : '0.7'
        ov.add(OV_MASK, anchor, () => {
          const g = document.createElementNS(SVG_NS, 'g')
          const rects = focus
            ? [[0, focus.top - 2], [focus.bottom + 2, height]]
            : [[0, height]]
          for (const [y0, y1] of rects) {
            if (y1 <= y0) continue
            const el = document.createElementNS(SVG_NS, 'rect')
            el.setAttribute('x', '0')
            el.setAttribute('y', String(y0))
            el.setAttribute('width', String(width))
            el.setAttribute('height', String(y1 - y0))
            el.setAttribute('fill', colors.bg)
            el.setAttribute('fill-opacity', opacity)
            g.append(el)
          }
          return g
        })
      }
      // 3 行: 当前带左侧 3px 竖条 (墨水屏为正文色实心黑条)
      if (focus && this.#cfg.lines === 3) {
        const color = this.#cfg.eink ? colors.fg : colors.link
        ov.add(OV_BAR, anchor, () => {
          const el = document.createElementNS(SVG_NS, 'rect')
          el.setAttribute('x', String(Math.max(0, focus.left - 10)))
          el.setAttribute('y', String(focus.top))
          el.setAttribute('width', '3')
          el.setAttribute('height', String(Math.max(4, focus.bottom - focus.top)))
          el.setAttribute('rx', '1.5')
          el.setAttribute('fill', color)
          return el
        })
      } else ov.remove(OV_BAR)
    } catch { /* overlayer 随分节卸载 */ }
  }
}
