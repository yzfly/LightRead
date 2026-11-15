/**
 * 打字声播放器: WebAudio 播放 CC0 录音切出的单发样本 (public/sounds/typewriter/, 来源见 docs/ambient-sources.md)。
 *
 * - AudioContext 在第一次 warm() (用户点「开始」/「试听」的手势里) 时才创建, 避免自动播放限制和无谓的音频设备占用;
 *   同时按当前音色懒加载样本 (每个音色 6 条 + 段落点缀, Opus 每条约 1.3 KB; 系统不支持 Opus 时用 AAC)。
 * - 每次击键: 轮换袋取样本 (不会连着两次同一条) + 音高 ±3% / 音量 ±2 dB 随机, 45 ms 内只响一次, 最多 4 声重叠。
 * - 录音解不了 (旧 WebView、离线且没缓存) 时改用 soundPresets.synthHit 的模态合成, 不会无声也不会报错。
 * 调度用的纯函数在 soundPresets.ts。
 */
import {
  DEFAULT_TYPING_SOUND_VOLUME,
  MAX_VOICES,
  allowHit,
  createRoundRobin,
  hitVariation,
  resolveTypingSoundPreset,
  synthHit,
  voicesToSteal,
  volumeToGain,
  type RoundRobin,
  type TypingSoundPreset,
  type TypingSoundPresetId,
} from './soundPresets'

export interface TypingSoundOptions {
  preset?: TypingSoundPresetId
  /** 0–1, 默认 0.4 */
  volume?: number
}

export interface TypingSound {
  /** 在用户手势里调用一次, 创建 / 唤醒 AudioContext 并开始加载当前音色 */
  warm(): void
  /** 响一声; accent: 段落末的点缀 (打字机回车 / 空格键), 没有点缀样本的音色照常响一声 */
  click(opts?: { accent?: boolean }): void
  /** 切换音色 (懒加载, 加载完成前沿用旧音色) */
  setPreset(id: TypingSoundPresetId): void
  /** 0–1 */
  setVolume(volume: number): void
  /** 试听: 以约 300 字/分 的节奏敲 7 下, 最后一下是段落点缀; 需要先在手势里 warm() (内部也会调) */
  preview(id?: TypingSoundPresetId): Promise<void>
  /**
   * 打字机暂停 / 退出时调用: 挂起 AudioContext。运行中的 AudioContext 即使没声音也占着系统的音频输出流
   * (安卓显示为正在播放, 费电); 下次 warm() 自动恢复, 已加载的音色保留。
   */
  suspend(): void
  dispose(): void
}

type Bank = { hits: AudioBuffer[]; accent: AudioBuffer | null; synth: boolean }
type Voice = { src: AudioBufferSourceNode; gain: GainNode; end: number }

/** 本机解不了的格式 (Opus 解码失败后整个会话改用 m4a) */
let oggBroken = false

function soundsBase(): string {
  return (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/') + 'sounds/typewriter/'
}

function preferOgg(): boolean {
  if (oggBroken) return false
  try {
    const r = document.createElement('audio').canPlayType('audio/ogg; codecs=opus')
    return r === 'probably' || r === 'maybe'
  } catch {
    return false
  }
}

function decode(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    // 回调写法兼容旧 Safari (decodeAudioData 不返回 Promise)
    const p = ctx.decodeAudioData(data, resolve, reject) as Promise<AudioBuffer> | undefined
    p?.catch?.(reject)
  })
}

async function fetchDecode(ctx: AudioContext, path: string, ext: 'ogg' | 'm4a'): Promise<AudioBuffer> {
  const res = await fetch(`${soundsBase()}${path}.${ext}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return decode(ctx, await res.arrayBuffer())
}

async function loadBank(ctx: AudioContext, preset: TypingSoundPreset): Promise<Bank> {
  const paths = [...preset.hits, ...(preset.accent ? [preset.accent] : [])]
  const tryExt = async (ext: 'ogg' | 'm4a') => Promise.all(paths.map(p => fetchDecode(ctx, p, ext)))
  let bufs: AudioBuffer[] | null = null
  if (preferOgg()) {
    try { bufs = await tryExt('ogg') } catch { oggBroken = true }
  }
  if (!bufs) {
    try { bufs = await tryExt('m4a') } catch { bufs = null }
  }
  if (bufs) {
    return { hits: bufs.slice(0, preset.hits.length), accent: preset.accent ? bufs[bufs.length - 1] : null, synth: false }
  }
  return synthBank(ctx, preset.id)
}

function synthBank(ctx: AudioContext, id: TypingSoundPresetId): Bank {
  const make = () => {
    const data = synthHit(id, ctx.sampleRate)
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate)
    buf.getChannelData(0).set(data)
    return buf
  }
  return { hits: Array.from({ length: 6 }, make), accent: null, synth: true }
}

export function createTypingSound(opts: TypingSoundOptions = {}): TypingSound {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let preset = resolveTypingSoundPreset(opts.preset)
  let volume = opts.volume ?? DEFAULT_TYPING_SOUND_VOLUME
  const banks = new Map<TypingSoundPresetId, Promise<Bank>>()
  const ready = new Map<TypingSoundPresetId, Bank>()
  /** 当前在用的音色 (加载完成前可能仍是上一个) */
  let active: { id: TypingSoundPresetId; bank: Bank; rr: RoundRobin } | null = null
  let voices: Voice[] = []
  let lastHit = -Infinity
  let disposed = false

  const ensure = (): AudioContext | null => {
    if (disposed) return null
    if (!ctx) {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext
      if (!AC) return null
      try {
        ctx = new AC() as AudioContext
      } catch {
        return null
      }
      master = ctx.createGain()
      master.gain.value = volumeToGain(volume)
      master.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    return ctx
  }

  const load = (p: TypingSoundPreset): Promise<Bank> => {
    const c = ensure()
    if (!c) return Promise.reject(new Error('no audio'))
    let job = banks.get(p.id)
    if (!job) {
      job = loadBank(c, p).catch(() => synthBank(c, p.id)).then(bank => {
        ready.set(p.id, bank)
        // 仍是想要的音色才切过去 (用户可能已经又换了)
        if (!disposed && preset.id === p.id) active = { id: p.id, bank, rr: createRoundRobin(bank.hits.length) }
        return bank
      })
      banks.set(p.id, job)
    }
    return job
  }

  const play = (accent: boolean, when?: number) => {
    const c = ctx
    const a = active
    if (!c || !master || !a || c.state !== 'running') return
    const nowMs = c.currentTime * 1000
    if (when == null && !allowHit(nowMs, lastHit, accent)) return
    lastHit = nowMs
    const useAccent = accent && !!a.bank.accent
    const buf = useAccent ? a.bank.accent! : a.bank.hits[a.rr.next()]
    if (!buf) return
    try {
      const t = when ?? c.currentTime
      // 复音上限: 让最早的几声 5 ms 内淡出
      voices = voices.filter(v => v.end > c.currentTime)
      for (const v of voices.splice(0, voicesToSteal(voices.length, MAX_VOICES))) {
        try {
          v.gain.gain.setTargetAtTime(0, t, 0.004)
          v.src.stop(t + 0.03)
        } catch { /* 已停 */ }
      }
      const vary = hitVariation()
      const src = c.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = useAccent ? 1 : vary.rate
      const gain = c.createGain()
      gain.gain.value = useAccent ? 1 : vary.gain
      src.connect(gain)
      gain.connect(master)
      src.start(t)
      const end = t + buf.duration / src.playbackRate.value + 0.01
      voices.push({ src, gain, end })
      src.onended = () => {
        voices = voices.filter(v => v.src !== src)
        try { gain.disconnect() } catch { /* ignore */ }
      }
    } catch { /* 音频不可用时静默 */ }
  }

  const setPreset = (id: TypingSoundPresetId) => {
    preset = resolveTypingSoundPreset(id)
    const bank = ready.get(preset.id)
    if (bank) active = { id: preset.id, bank, rr: createRoundRobin(bank.hits.length) }
    else if (ctx) void load(preset).catch(() => {})
  }

  return {
    warm() {
      if (ensure()) void load(preset).catch(() => {})
    },
    click(o) {
      play(!!o?.accent)
    },
    setPreset,
    setVolume(v) {
      volume = v
      const c = ctx
      if (c && master) master.gain.setTargetAtTime(volumeToGain(v), c.currentTime, 0.02)
    },
    async preview(id) {
      if (id) setPreset(id)
      const c = ensure()
      if (!c) return
      try { await load(preset) } catch { return }
      if (c.state !== 'running') {
        try { await c.resume() } catch { return }
      }
      // 约 300 字/分 (每 200 ms 一下), 带一点人手的快慢
      const t0 = c.currentTime + 0.05
      let t = t0
      for (let i = 0; i < 7; i++) {
        play(i === 6, t)
        t += 0.2 + (Math.random() * 2 - 1) * 0.025
      }
      lastHit = (t - 0.2) * 1000
      await new Promise(r => setTimeout(r, Math.max(0, (t - c.currentTime) * 1000 + 300)))
    },
    suspend() {
      if (ctx?.state === 'running') void ctx.suspend().catch(() => {})
    },
    dispose() {
      disposed = true
      const c = ctx
      ctx = null
      master = null
      active = null
      voices = []
      banks.clear()
      ready.clear()
      void c?.close().catch(() => {})
    },
  }
}

// ---- 设置页 / 面板里的试听: 共用一个实例, 闲置 15 秒后释放音频设备 ----
let shared: TypingSound | null = null
let sharedTimer: ReturnType<typeof setTimeout> | null = null

/** 在点击「试听」的手势里调用 */
export function previewTypingSound(id: TypingSoundPresetId, volume = DEFAULT_TYPING_SOUND_VOLUME): Promise<void> {
  shared ??= createTypingSound({ preset: id, volume })
  shared.setVolume(volume)
  shared.warm()
  if (sharedTimer) clearTimeout(sharedTimer)
  const s = shared
  return s.preview(id).finally(() => {
    if (sharedTimer) clearTimeout(sharedTimer)
    sharedTimer = setTimeout(() => {
      if (shared === s) {
        shared.dispose()
        shared = null
      }
    }, 15000)
  })
}
