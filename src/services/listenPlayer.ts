/**
 * 听书播放器: 把阅读器给出的句子流变成连续不断的语音。
 *
 * 接口契约 (阅读器 ReaderView 依赖它, 改动需同步):
 * - 阅读器只负责「下一句是什么」(ListenFeed) 和「某句开始出声时做什么」(onSentenceStart: 高亮 / 翻页 / 记断点);
 * - 播放器负责: 语义分块 (若干句合成一段, 兼顾起播速度与语调连贯)、预取预合成、无缝衔接播放、段落停顿、
 *   块内按时间推算每句开始时刻、暂停 / 继续 / 停止、换音色/倍速后丢弃尚未播放的预合成。
 *
 * 实现要点:
 * - 分块 / 时刻 / 静音裁剪等纯函数在 listenPlan.ts, 预取与句子源在 audioQueue.ts;
 * - 神经引擎 (edge / local): 合成 → decodeAudioData → 裁掉两端静音、淡入淡出、响度对齐 →
 *   在 AudioContext 时间线上首尾相接排期 (块间按句 / 段 / 章插入停顿), 暂停用 ctx.suspend() 冻结时间线;
 *   提前排进时间线约 15 秒, 页面在后台定时器被节流时也不断音;
 * - 不支持 Web Audio 或解码失败: 退回 <audio> 逐块顺序播放;
 * - 系统语音 (无音频数据): 每句一个 utterance, 提前排 3 句让浏览器连续读;
 * - 神经引擎失败: 已排上的音频照常播完, 余下 (含失败块) 改用系统语音, 与 tts.ts 一致只提示一次。
 */
import { neuralEngine, pickVoice, reportNeuralFailure, type NeuralEngine } from './tts.ts'
import { useSettings } from '../stores/settings'
import {
  CHUNK_PROFILES, analyzeSpeech, chunkGain, chunkWeight, estimateSeconds, gapSeconds, nextStartTime,
  sentenceOffsets, trimAndFade, type ChunkPause, type ListenChunk, type SpeechStats,
} from './listenPlan.ts'
import {
  ChunkPrefetcher, FeedError, MarkTicker, SentenceSource, sleep, waitForClock, type PrefetchedChunk,
} from './audioQueue.ts'

export interface ListenSentence {
  /** 调用方的不透明定位键 (如 "分节:段:句"), onSentenceStart 原样回传 */
  key: string
  text: string
  /** 这是一段的最后一句: 之后应有段落停顿, 分块时优先在此断开 */
  paragraphEnd?: boolean
  /** 这是章节 / 分节的最后一句: 停顿更长, 分块必须在此断开 */
  sectionEnd?: boolean
}

export interface ListenFeed {
  /** 依次取下一句; null 表示读完 (书末)。可能是异步的 (跨章时要先解析下一节) */
  next(): Promise<ListenSentence | null>
}

export interface ListenCallbacks {
  /** Hosts without Web Speech can reject system fallback; omitted preserves the desktop policy. */
  canUseSystemSpeech?(): boolean
  /** 某句开始出声 */
  onSentenceStart(key: string): void
  /** 播放结束: 读完 / 被停止 / 出错 */
  onEnd(reason: 'finished' | 'stopped' | 'error', error?: unknown): void
  /** 合成跟不上、正在缓冲 (true) / 恢复出声 (false) */
  onBuffering?(waiting: boolean): void
}

export type ListenState = 'idle' | 'playing' | 'paused' | 'buffering'

/** 各引擎的预取参数: 离线推理占满 CPU, 只能一块一块来, 但尽量多攒; 在线可并发 */
const PIPELINE: Record<'edge' | 'local' | 'cloud' | 'sapi' | 'qwen', { concurrency: number; lookaheadSeconds: number; maxChunks: number }> = {
  edge: { concurrency: 2, lookaheadSeconds: 45, maxChunks: 8 },
  local: { concurrency: 1, lookaheadSeconds: 90, maxChunks: 12 },
  // 按字计费: 预取只够消除等待, 跳章时不为没听到的内容多付钱
  cloud: { concurrency: 2, lookaheadSeconds: 30, maxChunks: 4 },
  sapi: { concurrency: 1, lookaheadSeconds: 45, maxChunks: 6 },
  // 本机语音模型占着显卡 / 处理器, 一块一块来; 少攒一些, 换音色或跳章时浪费得少
  qwen: { concurrency: 1, lookaheadSeconds: 60, maxChunks: 6 },
}
/** 提前排进 AudioContext 时间线的秒数 (排上的音频不依赖 JS 定时器) */
const SCHEDULE_AHEAD = 15
/** 系统语音提前排队的句数 */
const SYSTEM_AHEAD = 3
/** 块两端淡入淡出 */
const FADE_SECONDS = 0.006

type Prepared =
  | { kind: 'buffer'; buffer: AudioBuffer; duration: number; stats: SpeechStats }
  /** 无法用 Web Audio 解码: 原样交给 <audio>, 时长为估算 */
  | { kind: 'blob'; blob: Blob; duration: number }

interface Clip {
  id: number
  start: number
  end: number
  chunk: ListenChunk
  src: AudioBufferSourceNode
  gain: GainNode
  /** 排入前的时间线状态, 退回本块时恢复 */
  prev: { tail: number; pause: ChunkPause | null; gain: number | null }
}

type RunOutcome = 'finished' | 'switch' | 'stopped'

/** <audio> 回退也播不了: 带上这一块, 交给系统语音补读 */
class PlaybackError extends Error {
  chunk: ListenChunk
  constructor(chunk: ListenChunk, message: string) {
    super(message)
    this.chunk = chunk
  }
}

export class ListenPlayer {
  private cb: ListenCallbacks
  private active = false
  private paused = false
  private waiting = false
  private _state: ListenState = 'idle'
  /** play/stop 递增; 旧会话的异步回调据此作废 */
  private session = 0
  private source: SentenceSource | null = null
  /** 当前引擎循环对 invalidate() 的处理 */
  private invalidateHook: (() => void) | null = null

  // ---- Web Audio 时间线 ----
  private ctx: AudioContext | null = null
  /** 所有块经过的总音量 (定时关闭的淡出只动它, 不碰各块的响度对齐) */
  private master: GainNode | null = null
  private webAudioOff = false
  private clips: Clip[] = []
  private clipSeq = 0
  /** 时间线上最后一块结束的时刻 */
  private tail = 0
  private lastPause: ChunkPause | null = null
  private lastGain: number | null = null
  private ticker: MarkTicker
  private clock = () => this.ctx ? this.ctx.currentTime : 0

  // ---- <audio> 回退 ----
  private element: HTMLAudioElement | null = null
  private elementDone: (() => void) | null = null
  /** 已从预取取出、等待开始播放的块 (只在 <audio> 回退时存在) */
  private heldChunk: ListenChunk | null = null

  // ---- 系统语音 ----
  private systemActive = false

  // ---- 定时关闭的淡出 ----
  /** 淡出开始时刻 (performance.now) 与时长; <audio> 回退按它逐步调音量 */
  private fade: { from: number; ms: number; timer: ReturnType<typeof setInterval> } | null = null

  constructor(cb: ListenCallbacks) {
    this.cb = cb
    this.ticker = new MarkTicker(key => this.cb.onSentenceStart(key))
  }

  get state(): ListenState {
    return this._state
  }

  /** 停掉当前播放, 从 feed 的第一句开始; 应在用户手势内调用 (解锁音频) */
  play(feed: ListenFeed): void {
    this.halt()
    // 浏览器的系统语音暂停后, cancel 不会解除暂停 (Chrome): 新排的句子会一直静音, 先恢复
    try { if (typeof speechSynthesis !== 'undefined' && speechSynthesis.paused) speechSynthesis.resume() } catch { /* 无系统语音 */ }
    const session = this.session
    this.active = true
    this.source = new SentenceSource(feed)
    this.ensureContext()
    // 神经引擎要先合成第一块: 从缓冲开始
    if (neuralEngine()) this.setWaiting(true)
    this.refresh()
    void this.loop(session)
  }

  pause(): void {
    if (!this.active || this.paused) return
    this.paused = true
    this.ctx?.suspend().catch(() => {})
    this.element?.pause()
    if (this.systemActive) speechSynthesis.pause()
    this.refresh()
  }

  resume(): void {
    if (!this.active || !this.paused) return
    this.restoreVolume()
    this.paused = false
    this.ctx?.resume().catch(() => {})
    this.element?.play().catch(() => {})
    if (this.systemActive) speechSynthesis.resume()
    this.ticker.tick()
    this.refresh()
  }

  /** 停止并清空所有预合成; 会触发 onEnd('stopped') (空闲时调用无事发生) */
  stop(): void {
    if (!this.active) return
    this.halt(true)
    this.cb.onEnd('stopped')
  }

  /**
   * 定时关闭: seconds 秒内把音量渐弱到 0, 然后暂停 (继续播放时音量复原)。
   * - 'done': 已淡出并暂停;
   * - 'unsupported': 正在用系统语音 (没法调音量), 什么也没做, 由调用方在句末暂停;
   * - 'cancelled': 淡出中被暂停 / 停止 / 换句, 音量已复原。
   */
  async fadeOut(seconds = 3): Promise<'done' | 'unsupported' | 'cancelled'> {
    if (!this.active || this.paused) return 'cancelled'
    if (this.systemActive && !this.clips.length && !this.element) return 'unsupported'
    const session = this.session
    this.restoreVolume()
    const ms = Math.max(0, seconds * 1000)
    if (this.ctx && this.master) {
      const g = this.master.gain
      const now = this.ctx.currentTime
      try {
        g.cancelScheduledValues(now)
        g.setValueAtTime(1, now)
        g.linearRampToValueAtTime(0, now + seconds)
      } catch { g.value = 0 }
    }
    const from = performance.now()
    // <audio> 回退 (含淡出途中才换上的块) 没有增益节点, 按时间调 volume
    const timer = setInterval(() => {
      if (this.element) this.element.volume = this.fadeVolume()
    }, 80)
    this.fade = { from, ms, timer }
    if (this.element) this.element.volume = this.fadeVolume()
    await sleep(ms)
    if (session !== this.session || !this.active || this.paused || this.fade?.timer !== timer) {
      if (this.fade?.timer === timer) this.restoreVolume()
      return 'cancelled'
    }
    this.pause()
    return 'done'
  }

  private fadeVolume(): number {
    if (!this.fade) return 1
    return Math.max(0, Math.min(1, 1 - (performance.now() - this.fade.from) / Math.max(1, this.fade.ms)))
  }

  /** 撤销淡出, 音量回到原样 */
  private restoreVolume() {
    if (this.fade) {
      clearInterval(this.fade.timer)
      this.fade = null
    }
    if (this.ctx && this.master) {
      const g = this.master.gain
      try {
        g.cancelScheduledValues(this.ctx.currentTime)
        g.setValueAtTime(1, this.ctx.currentTime)
      } catch { /* 旧实现 */ }
      g.value = 1
    }
    if (this.element) this.element.volume = 1
  }

  /** 音色 / 倍速 / 引擎变了: 正在播放的这一块读完后, 后续按新设置重新合成 */
  invalidate(): void {
    if (this.active) this.invalidateHook?.()
  }

  // ================= 会话 =================

  private refresh() {
    this._state = !this.active ? 'idle' : this.paused ? 'paused' : this.waiting ? 'buffering' : 'playing'
  }

  private setWaiting(waiting: boolean) {
    if (this.waiting === waiting) return
    this.waiting = waiting
    this.refresh()
    this.cb.onBuffering?.(waiting)
  }

  /**
   * 结束当前会话的一切 (不发 onEnd)。release: 会话真正结束 (停止 / 读完 / 出错) 时挂起 AudioContext,
   * 不占音频设备; play() 换会话时不挂起 —— 跳句等场景会在定时器里调用 play(), 不在用户手势内,
   * 部分 WebView 不允许那时再 resume。
   */
  private halt(release = false) {
    this.session++
    this.restoreVolume()
    this.active = false
    this.paused = false
    this.invalidateHook = null
    this.source = null
    this.heldChunk = null
    if (this.waiting) this.setWaiting(false)
    this.ticker.clear()
    for (const clip of this.clips) this.stopClip(clip)
    this.clips = []
    this.tail = 0
    this.lastPause = null
    this.lastGain = null
    if (this.element) {
      this.element.pause()
      this.element = null
    }
    this.elementDone?.()
    if (this.systemActive) {
      this.systemActive = false
      speechSynthesis.cancel()
    }
    if (release && this.ctx?.state === 'running') this.ctx.suspend().catch(() => {})
    this.refresh()
  }

  private ensureContext() {
    if (!this.ctx && !this.webAudioOff) {
      const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
      const AC = g.AudioContext ?? g.webkitAudioContext
      if (AC) {
        try {
          this.ctx = new AC({ latencyHint: 'playback' })
        } catch {
          try { this.ctx = new AC() } catch { this.webAudioOff = true }
        }
      } else {
        this.webAudioOff = true
      }
    }
    if (this.ctx && !this.master) {
      try {
        this.master = this.ctx.createGain()
        this.master.connect(this.ctx.destination)
      } catch { this.master = null }
    }
    if (this.ctx) {
      // 上次解码失败可能只是个别坏数据, 新会话再试 Web Audio
      this.webAudioOff = false
      this.ctx.resume().catch(() => {})
    }
  }

  private async loop(session: number) {
    const alive = () => session === this.session
    try {
      for (;;) {
        const engine = neuralEngine()
        const outcome = engine ? await this.runNeural(session, engine) : await this.runSystem(session)
        if (!alive() || outcome === 'stopped') return
        if (outcome === 'finished') break
        // 'switch': 换设置 / 神经引擎失败, 按当前设置继续
      }
      // 等最后一块播完, 句子标记都已触发
      if (!(await waitForClock(this.clock, this.tail, alive))) return
      this.ticker.tick()
      this.halt(true)
      this.cb.onEnd('finished')
    } catch (e) {
      if (!alive()) return
      console.error(e)
      // feed 出错 (如下一章解析失败): 已排上的先读完
      if (e instanceof FeedError) {
        if (!(await waitForClock(this.clock, this.tail, alive))) return
        this.ticker.tick()
      }
      this.halt(true)
      this.cb.onEnd('error', e instanceof FeedError ? e.cause : e)
    }
  }

  // ================= 神经引擎: 预取 + 无缝排期 =================

  private async runNeural(session: number, engine: NeuralEngine): Promise<RunOutcome> {
    const source = this.source!
    const rate = useSettings().ttsRate
    let switching = false
    const alive = () => session === this.session && !switching
    const prefetcher: ChunkPrefetcher<Prepared> = new ChunkPrefetcher<Prepared>({
      source,
      profile: CHUNK_PROFILES[engine.kind],
      ...PIPELINE[engine.kind],
      rate,
      synth: chunk => this.prepare(engine, chunk, rate, () => alive() && !prefetcher.isCancelled),
      seconds: r => r.duration,
    })
    const hook = () => {
      switching = true
      // 正在出声的块读完; 排在它后面的、取出未播的、预取中的全部退回, 按新设置重新合成
      const back = this.dropUnstarted()
      if (this.heldChunk) back.push(...this.heldChunk.sentences)
      this.heldChunk = null
      back.push(...prefetcher.drain())
      source.unshift(back)
    }
    this.invalidateHook = hook
    prefetcher.start()
    try {
      for (;;) {
        if (!alive()) return session === this.session ? 'switch' : 'stopped'
        // 时间线上已排够, 等播一会儿再取
        if (this.tail - this.clock() > SCHEDULE_AHEAD) {
          await waitForClock(this.clock, this.tail - SCHEDULE_AHEAD, alive)
          continue
        }
        let item: PrefetchedChunk<Prepared> | null
        try {
          item = await this.takeOrBuffer(prefetcher, alive)
          if (item && alive()) await this.playPrepared(item, alive)
        } catch (e) {
          if (e instanceof FeedError) throw e
          if (!alive()) continue
          // 合成 / 播放失败: 已排上的照常播完, 余下 (含失败块) 改用系统语音
          reportNeuralFailure(e)
          if (this.cb.canUseSystemSpeech?.() === false) {
            // Finish audio already scheduled, then report the original service error.
            // Do not enter a system engine the host cannot provide.
            if (!(await waitForClock(this.clock, this.tail, alive))) continue
            throw e
          }
          switching = true
          const back = e instanceof PlaybackError ? [...e.chunk.sentences] : []
          this.heldChunk = null
          source.unshift([...back, ...prefetcher.drain()])
          return 'switch'
        }
        if (!item) {
          if (!alive()) continue
          return 'finished'
        }
      }
    } finally {
      if (this.invalidateHook === hook) this.invalidateHook = null
      prefetcher.cancel()
      // 本机语音模型: 已经发给原生层、还在合成的那一块也停下
      engine.cancel?.()
    }
  }

  /** 取下一块; 时间线播空时还没合成好就进入缓冲 (onBuffering), 拿到后由排期处恢复 */
  private async takeOrBuffer(
    prefetcher: ChunkPrefetcher<Prepared>, alive: () => boolean,
  ): Promise<PrefetchedChunk<Prepared> | null> {
    const p = prefetcher.take()
    if (prefetcher.headReady()) return p
    let settled = false
    const done = p.then(() => { settled = true }, () => { settled = true })
    const dry = await Promise.race([done.then(() => false), waitForClock(this.clock, this.tail, () => alive() && !settled)])
    // 稍等片刻再报缓冲, 合成恰好完成时不闪一下
    if (dry && !settled) await Promise.race([done, sleep(40)])
    if (dry && alive() && !settled) this.setWaiting(true)
    return p
  }

  /** 一块的合成 + 解码 + 处理 (在预取里并发执行) */
  private async prepare(engine: NeuralEngine, chunk: ListenChunk, rate: number, alive: () => boolean): Promise<Prepared> {
    let blob: Blob
    try {
      blob = await engine.synth(chunk.text)
    } catch (e) {
      // 在线引擎偶发网络抖动: 重试一次再判定失败; API 语音的 Key、余额问题重试也没用
      if (!(engine.kind === 'edge' || engine.retryable?.(e)) || !alive()) throw e
      await sleep(600)
      if (!alive()) throw e
      blob = await engine.synth(chunk.text)
    }
    const ctx = this.ctx
    if (ctx && !this.webAudioOff && alive()) {
      try {
        return this.process(ctx, await decodeAudio(ctx, await blob.arrayBuffer()))
      } catch (e) {
        console.warn('decodeAudioData failed, falling back to <audio>', e)
        this.webAudioOff = true
      }
    }
    return { kind: 'blob', blob, duration: estimateSeconds(chunkWeight(chunk), rate) }
  }

  /** 裁掉两端静音并淡入淡出; 响度在排期时按相邻块平滑 */
  private process(ctx: AudioContext, decoded: AudioBuffer): Prepared {
    const stats = analyzeSpeech(decoded.getChannelData(0), decoded.sampleRate)
    const length = Math.max(1, stats.end - stats.start)
    const out = ctx.createBuffer(decoded.numberOfChannels, length, decoded.sampleRate)
    const fade = Math.round(decoded.sampleRate * FADE_SECONDS)
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      out.getChannelData(c).set(trimAndFade(decoded.getChannelData(c), stats.start, stats.end, fade))
    }
    return { kind: 'buffer', buffer: out, duration: out.duration, stats }
  }

  private async playPrepared(item: PrefetchedChunk<Prepared>, alive: () => boolean) {
    const { chunk, result } = item
    if (result.kind === 'buffer' && this.ctx && !this.webAudioOff) {
      this.schedule(chunk, result.buffer, result.stats)
      this.setWaiting(false)
      return
    }
    this.heldChunk = chunk
    // 时间线上的音频先播完, 再停顿, 再用 <audio> 播
    const gap = gapSeconds(this.lastPause, useSettings().ttsRate)
    if (!(await waitForClock(this.clock, this.tail, alive))) return
    await sleep(gap * 1000)
    while (this.paused && alive()) await sleep(100)
    if (!alive()) return
    this.heldChunk = null
    const blob = result.kind === 'blob' ? result.blob : bufferToWav(result.buffer)
    await this.playElement(chunk, blob, result.duration, alive)
    this.lastPause = chunk.pause
  }

  /** 在时间线上紧接上一块排期, 并登记块内各句的开始时刻 */
  private schedule(chunk: ListenChunk, buffer: AudioBuffer, stats: SpeechStats) {
    const ctx = this.ctx!
    const prev = { tail: this.tail, pause: this.lastPause, gain: this.lastGain }
    const at = nextStartTime(ctx.currentTime, this.tail, gapSeconds(this.lastPause, useSettings().ttsRate))
    const gainValue = chunkGain(stats, this.lastGain)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    gain.gain.value = gainValue
    src.connect(gain)
    gain.connect(this.master ?? ctx.destination)
    src.start(at)
    // 未在用户手势内恢复 (或被系统打断) 时时间线不走, 再试一次
    if (ctx.state === 'suspended' && !this.paused) ctx.resume().catch(() => {})
    const clip: Clip = { id: ++this.clipSeq, start: at, end: at + buffer.duration, chunk, src, gain, prev }
    src.onended = () => {
      this.disconnect(clip)
      const i = this.clips.indexOf(clip)
      if (i >= 0) this.clips.splice(i, 1)
    }
    this.clips.push(clip)
    this.tail = clip.end
    this.lastPause = chunk.pause
    this.lastGain = gainValue
    const offsets = sentenceOffsets(chunk.weights, buffer.duration)
    this.ticker.add(chunk.keys.map((key, i) => ({ at: at + offsets[i], key, clip: clip.id })), this.clock)
  }

  /** 撤下尚未开始出声的块, 返回它们的句子 (按顺序); 时间线状态回到第一块排入之前 */
  private dropUnstarted(): ListenSentence[] {
    const now = this.clock()
    const i = this.clips.findIndex(c => c.start > now + 0.01)
    if (i < 0) return []
    const dropped = this.clips.splice(i)
    for (const clip of dropped) {
      this.stopClip(clip)
      this.ticker.dropClip(clip.id)
    }
    const { prev } = dropped[0]
    this.tail = prev.tail
    this.lastPause = prev.pause
    this.lastGain = prev.gain
    return dropped.flatMap(c => c.chunk.sentences)
  }

  private stopClip(clip: Clip) {
    clip.src.onended = null
    try { clip.src.stop() } catch { /* 未开始 / 已结束 */ }
    this.disconnect(clip)
  }

  private disconnect(clip: Clip) {
    try {
      clip.src.disconnect()
      clip.gain.disconnect()
    } catch { /* 已断开 */ }
  }

  /** <audio> 回退: 播一块, 按 audio.currentTime 触发句子; 结束 / 被停止时返回 */
  private playElement(chunk: ListenChunk, blob: Blob, estimated: number, alive: () => boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      if (this.fade) audio.volume = this.fadeVolume()
      this.element = audio
      const clock = () => audio.currentTime
      let marked = false
      const mark = () => {
        if (marked) return
        marked = true
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : estimated
        const offsets = sentenceOffsets(chunk.weights, duration)
        this.ticker.add(chunk.keys.map((key, i) => ({ at: offsets[i], key, clip: 0 })), clock)
      }
      const done = (error?: unknown) => {
        URL.revokeObjectURL(url)
        if (this.element === audio) this.element = null
        if (this.elementDone === finish) this.elementDone = null
        if (error && alive()) reject(new PlaybackError(chunk, String(error)))
        else {
          if (alive()) this.ticker.tick()
          resolve()
        }
      }
      const finish = () => done()
      this.elementDone = finish
      audio.onloadedmetadata = mark
      audio.onplaying = mark
      audio.onended = finish
      audio.onerror = () => done(audio.error?.message || 'audio error')
      this.setWaiting(false)
      audio.play().catch(e => done(e))
    })
  }

  // ================= 系统语音 =================

  private async runSystem(session: number): Promise<RunOutcome> {
    if (this.cb.canUseSystemSpeech?.() === false) throw new Error('System speech is unavailable on this device')
    const source = this.source!
    const settings = useSettings()
    const alive = () => session === this.session
    let invalidated = false
    /** 本轮已主动 cancel, 之后的 utterance 事件都不处理 */
    let dead = false
    const live = () => alive() && !dead
    let wake: (() => void) | null = null
    const notify = () => {
      const w = wake
      wake = null
      w?.()
    }
    const hook = () => {
      invalidated = true
      notify()
    }
    this.invalidateHook = hook

    interface Pending { s: ListenSentence; u: SpeechSynthesisUtterance; started: boolean }
    const queue: Pending[] = []
    let errors = 0
    let voice: SpeechSynthesisVoice | undefined
    let voicePicked = false
    const cancelQueued = () => {
      dead = true
      speechSynthesis.cancel()
      this.systemActive = false
      source.unshift(queue.map(q => q.s))
      queue.length = 0
    }
    const remove = (item: Pending) => {
      const i = queue.indexOf(item)
      if (i >= 0) queue.splice(i, 1)
    }
    const speakOne = (s: ListenSentence) => {
      const u = new SpeechSynthesisUtterance(s.text)
      if (voice) {
        u.voice = voice
        u.lang = voice.lang
      }
      u.rate = settings.ttsRate
      const item: Pending = { s, u, started: false }
      const start = () => {
        if (item.started || !live()) return
        item.started = true
        this.setWaiting(false)
        this.cb.onSentenceStart(s.key)
      }
      u.onstart = start
      u.onend = () => {
        if (!live()) return
        start()
        errors = 0
        remove(item)
        // 换设置: 这一句读完就撤下浏览器里已排队的旧设置句子
        if (invalidated) cancelQueued()
        notify()
      }
      u.onerror = e => {
        if (!live()) return
        if (e.error !== 'canceled' && e.error !== 'interrupted') errors++
        remove(item)
        notify()
      }
      queue.push(item)
      this.systemActive = true
      speechSynthesis.speak(u)
      if (this.paused) speechSynthesis.pause()
    }

    try {
      // 神经语音已排上时间线的部分先播完
      if (!(await waitForClock(this.clock, this.tail, () => alive() && !invalidated))) {
        return alive() ? 'switch' : 'stopped'
      }
      let ended = false
      for (;;) {
        if (!alive()) return 'stopped'
        if (invalidated) {
          // 正在读的一句读完再切换 (onend 里撤下其余); 还没开始读就直接撤下
          if (!dead && queue.some(q => q.started)) {
            await new Promise<void>(resolve => { wake = resolve })
            continue
          }
          if (!dead) cancelQueued()
          return 'switch'
        }
        if (errors >= 3) throw new Error('speechSynthesis failed repeatedly')
        while (queue.length < SYSTEM_AHEAD && !ended && !invalidated) {
          const s = await source.next(() => !alive() || invalidated)
          if (s === undefined) break
          if (s === null) {
            ended = true
            break
          }
          if (!voicePicked) {
            voice = await pickVoice(settings.ttsVoice, s.text)
            voicePicked = true
            if (!alive() || invalidated) {
              source.unshift([s])
              break
            }
          }
          speakOne(s)
        }
        if (!alive()) return 'stopped'
        if (invalidated) continue
        if (!queue.length && ended) return 'finished'
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      if (this.invalidateHook === hook) this.invalidateHook = null
      if (alive()) this.systemActive = false
    }
  }
}

function decodeAudio(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  // 旧 WebKit 只有回调形式
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined
    p?.then(resolve, reject)
  })
}

/** 已解码的块 (仅在解码成功后 Web Audio 又被关掉时) 转回 16-bit WAV 交给 <audio> */
function bufferToWav(buffer: AudioBuffer): Blob {
  const data = buffer.getChannelData(0)
  const view = new DataView(new ArrayBuffer(44 + data.length * 2))
  const text = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
  text(0, 'RIFF')
  view.setUint32(4, 36 + data.length * 2, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, data.length * 2, true)
  for (let i = 0; i < data.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true)
  return new Blob([view.buffer], { type: 'audio/wav' })
}
