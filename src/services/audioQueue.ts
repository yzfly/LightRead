/**
 * 听书管线的调度部件 (与 Web Audio 无关, 可在 node 下用假引擎测试):
 * - SentenceSource: 包住阅读器的 ListenFeed, 读取串行化, 支持把未播放的句子退回队首 (换设置 / 回退引擎时重排);
 * - ChunkPrefetcher: 边读句子边分块, 按时长预取合成, 限并发与内存, 按序交付;
 * - MarkTicker: 按时钟触发「某句开始出声」。
 */
import type { ListenFeed, ListenSentence } from './listenPlayer.ts'
import {
  chunkWeight, estimateSeconds, makeChunk, nextChunkSize,
  type ChunkProfile, type ListenChunk,
} from './listenPlan.ts'

/** 阅读器的 feed 抛错 (解析下一章失败等), 与合成失败区分 */
export class FeedError extends Error {
  cause: unknown
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.cause = cause
  }
}

export class SentenceSource {
  private feed: ListenFeed
  /** 退回的 / 读到时调用方已作废的句子, 先于 feed 交付 */
  private front: ListenSentence[] = []
  private ended = false
  private chain: Promise<unknown> = Promise.resolve()

  constructor(feed: ListenFeed) {
    this.feed = feed
  }

  /**
   * 取下一句; null = 读完。读取串行执行 (feed 不必支持并发)。
   * 调用方在等待期间作废 (stale() 为真) 时返回 undefined, 读到的句子留在队列里给下一个读者。
   */
  next(stale: () => boolean): Promise<ListenSentence | null | undefined> {
    const run = async (): Promise<ListenSentence | null | undefined> => {
      if (stale()) return undefined
      if (this.front.length) return this.front.shift()!
      if (this.ended) return null
      let s: ListenSentence | null
      try {
        s = await this.feed.next()
      } catch (e) {
        throw new FeedError(e)
      }
      if (!s) {
        this.ended = true
        return stale() ? undefined : null
      }
      // 读的过程中可能有句子被退回队首; 新读到的句子总在它们之后
      if (stale()) {
        this.front.push(s)
        return undefined
      }
      return s
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => {})
    return p
  }

  /** 退回尚未播放的句子 (保持原顺序), 下次 next() 先拿到它们 */
  unshift(sentences: readonly ListenSentence[]) {
    if (sentences.length) this.front.unshift(...sentences)
  }
}

export interface PrefetchOptions<T> {
  source: SentenceSource
  profile: ChunkProfile
  /** 同时合成的块数 (离线 1, 在线 2) */
  concurrency: number
  /** 预取到播放前多少秒 (按估算 / 实际时长) */
  lookaheadSeconds: number
  /** 已合成未交付的块数上限 (内存) */
  maxChunks: number
  rate: number
  synth: (chunk: ListenChunk) => Promise<T>
  /** 合成结果的实际时长 (秒) */
  seconds: (result: T) => number
}

interface Slot<T> {
  chunk: ListenChunk
  est: number
  state: 'queued' | 'running' | 'ready' | 'failed'
  result?: T
  error?: unknown
}

export interface PrefetchedChunk<T> {
  chunk: ListenChunk
  result: T
}

/**
 * 分块预取: 句子不够就向 source 要, 缓冲时长不够就开新块, 有并发余量就开始合成;
 * 块按顺序交付 (并发时先完成的后面块先等着)。cancel()/drain() 后迟到的结果一律丢弃。
 */
export class ChunkPrefetcher<T> {
  private opts: PrefetchOptions<T>
  private pending: ListenSentence[] = []
  private slots: Slot<T>[] = []
  private running = 0
  private reading = false
  private sourceDone = false
  private feedError: unknown = null
  private first = true
  private cancelled = false
  private waiters: (() => void)[] = []
  /** 已开始合成的块数 (测试 / 诊断用) */
  started = 0

  constructor(opts: PrefetchOptions<T>) {
    this.opts = opts
  }

  /** 开始读句子与合成 (take() 也会自动开始) */
  start() {
    this.pump()
  }

  get isCancelled() { return this.cancelled }

  /** 已合成或在合成中、尚未交付的秒数 */
  bufferedSeconds(): number {
    let s = 0
    for (const slot of this.slots) {
      s += slot.state === 'ready' ? this.opts.seconds(slot.result as T) : slot.est
    }
    return s
  }

  /** 队首已合成好, take() 会立即返回 */
  headReady(): boolean {
    return this.slots[0]?.state === 'ready'
  }

  /**
   * 按序取下一块; null = 读完或已取消。队首合成失败时抛出原错误 (块仍留在队首, 由 drain() 收回);
   * feed 出错抛 FeedError。
   */
  async take(): Promise<PrefetchedChunk<T> | null> {
    for (;;) {
      if (this.cancelled) return null
      const head = this.slots[0]
      if (head?.state === 'ready') {
        this.slots.shift()
        this.pump()
        return { chunk: head.chunk, result: head.result as T }
      }
      if (head?.state === 'failed') throw head.error
      if (!head && this.sourceDone && !this.pending.length) {
        if (this.feedError) throw this.feedError
        return null
      }
      this.pump()
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
  }

  cancel() {
    this.cancelled = true
    this.wake()
  }

  /** 取消并收回所有未交付的句子 (按原顺序), 调用方负责退回 source */
  drain(): ListenSentence[] {
    this.cancel()
    const out: ListenSentence[] = []
    for (const slot of this.slots) out.push(...slot.chunk.sentences)
    out.push(...this.pending)
    this.slots = []
    this.pending = []
    return out
  }

  private wake() {
    const waiters = this.waiters
    this.waiters = []
    for (const w of waiters) w()
  }

  private pump() {
    if (this.cancelled) return
    const o = this.opts
    // 1. 缓冲不够就再分一块; 句子不够就去读
    while (this.slots.length < o.maxChunks && this.bufferedSeconds() < o.lookaheadSeconds) {
      const n = nextChunkSize(this.pending, o.profile, this.first, this.sourceDone)
      if (!n) {
        if (!this.sourceDone && !this.reading) this.readMore()
        break
      }
      const chunk = makeChunk(this.pending.splice(0, n))
      this.first = false
      this.slots.push({ chunk, est: estimateSeconds(chunkWeight(chunk), o.rate), state: 'queued' })
    }
    // 2. 按顺序开始合成
    for (const slot of this.slots) {
      if (this.running >= o.concurrency) break
      if (slot.state === 'queued') this.run(slot)
    }
  }

  private readMore() {
    this.reading = true
    this.opts.source.next(() => this.cancelled).then(s => {
      this.reading = false
      if (s === undefined) return
      if (s === null) this.sourceDone = true
      else this.pending.push(s)
      this.pump()
      this.wake()
    }, e => {
      // 已读到的句子照常合成交付, 之后再抛
      this.reading = false
      this.feedError = e
      this.sourceDone = true
      this.pump()
      this.wake()
    })
  }

  private run(slot: Slot<T>) {
    slot.state = 'running'
    this.running++
    this.started++
    this.opts.synth(slot.chunk).then(result => {
      slot.state = 'ready'
      slot.result = result
    }, error => {
      slot.state = 'failed'
      slot.error = error
    }).finally(() => {
      this.running--
      if (this.cancelled) return
      this.pump()
      this.wake()
    })
  }
}

// ---------------- 逐句时刻 ----------------

export interface SentenceMark {
  /** 时钟上的时刻 (秒) */
  at: number
  key: string
  /** 所属块, 退回未播放的块时一并撤销 */
  clip: number
}

/**
 * 按时钟 (AudioContext.currentTime 或 audio.currentTime) 触发句子开始。
 * 不为每句设定时器: 只等最近的一个标记, 定时器最长 250ms 自检一次, 暂停时时钟停住、标记自然不触发。
 */
export class MarkTicker {
  private marks: SentenceMark[] = []
  private clock: () => number = () => 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private fire: (key: string) => void

  constructor(fire: (key: string) => void) {
    this.fire = fire
  }

  /** 加入一块的标记 (时刻递增); 换时钟时先清空 */
  add(marks: readonly SentenceMark[], clock: () => number) {
    if (clock !== this.clock) {
      this.tick()
      this.marks = []
    }
    this.clock = clock
    this.marks.push(...marks)
    this.tick()
  }

  /** 撤销某块尚未触发的标记 */
  dropClip(clip: number) {
    this.marks = this.marks.filter(m => m.clip !== clip)
  }

  clear() {
    this.marks = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    liveTickers.delete(this)
  }

  get pendingCount() { return this.marks.length }

  tick = () => {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const now = this.clock()
    while (this.marks.length && this.marks[0].at <= now + 0.005) this.fire(this.marks.shift()!.key)
    if (!this.marks.length) { liveTickers.delete(this); return }
    liveTickers.add(this)
    const ms = (this.marks[0].at - now) * 1000
    this.timer = setTimeout(this.tick, Math.min(250, Math.max(10, ms)))
  }
}

/** 等到 clock() >= t; alive() 变假时提前返回 false。暂停时时钟停住, 低频轮询 */
export async function waitForClock(
  clock: () => number, t: number, alive: () => boolean, maxStepMs = 250,
): Promise<boolean> {
  while (alive()) {
    const d = t - clock()
    if (d <= 0) return true
    await sleep(Math.min(maxStepMs, Math.max(10, d * 1000)))
  }
  return false
}

/**
 * 还没到点的等待与句子标记。页面隐藏后 WebView 会把定时器压到很低的频率 (隐藏满 5 分钟后约每分钟一次),
 * 比播放器提前排期的 15 秒还长, 声音会断。安卓原生层在后台听书时定期调 pumpListenTimers(),
 * 到点的等待由它放行, 不再只靠定时器。
 */
interface PendingSleep { at: number; done: () => void }
const pendingSleeps = new Set<PendingSleep>()
const liveTickers = new Set<MarkTicker>()

export const sleep = (ms: number) => new Promise<void>(resolve => {
  const entry: PendingSleep = {
    at: performance.now() + ms,
    done: () => {
      if (!pendingSleeps.delete(entry)) return
      clearTimeout(timer)
      resolve()
    },
  }
  pendingSleeps.add(entry)
  const timer = setTimeout(entry.done, ms)
})

/** 放行已到点的等待, 并让句子标记按时钟自检一次; 没有到点的什么都不做 */
export function pumpListenTimers(): void {
  const now = performance.now()
  for (const entry of [...pendingSleeps]) if (entry.at <= now) entry.done()
  for (const ticker of [...liveTickers]) ticker.tick()
}
