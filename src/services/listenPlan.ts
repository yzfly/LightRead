/**
 * 听书管线的纯函数: 语义分块、块内逐句时刻、静音裁剪 / 响度、块间停顿。
 * 不依赖 DOM / Web Audio, 由 scripts/test-listen-player.mjs 单测。
 *
 * 「字」的口径 (speechWeight): 汉字 / 假名 / 谚文记 1, 西文字母与数字记 0.35 (西文约 13 字母/秒,
 * 中文约 4.5 字/秒, 折算后两者每秒都约 4.5 单位), 标点记停顿 (逗号 0.6, 句末 1)。
 * 分块上限、时长估算、块内句子时刻都用这一口径。
 */
import type { ListenSentence } from './listenPlayer.ts'

// ---------------- 朗读量口径 ----------------

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/
const WORD = /[\p{L}\p{N}]/u
const SOFT_PUNCT = /[，,、；;：:—]/
const STOP_PUNCT = /[。！？!?….．]/

export function speechWeight(text: string): number {
  let w = 0
  for (const ch of text) {
    if (CJK.test(ch)) w += 1
    else if (WORD.test(ch)) w += 0.35
    else if (STOP_PUNCT.test(ch)) w += 1
    else if (SOFT_PUNCT.test(ch)) w += 0.6
  }
  return w
}

/** 1.0x 下每秒朗读量 (speechWeight 单位) */
export const WEIGHT_PER_SECOND = 4.5

/** 未合成前的时长估算 (秒), 用于预取的「缓冲了多少秒」 */
export function estimateSeconds(weight: number, rate: number): number {
  return weight / (WEIGHT_PER_SECOND * Math.max(0.25, rate || 1))
}

/** 以句末标点结尾 (允许后随右引号 / 括号); 逗号处软切出来的半句不算 */
export function endsSentence(text: string): boolean {
  return /[。！？!?….．；;][”’」』"')）\]》\s]*$/.test(text)
}

// ---------------- 分块 ----------------

export interface ChunkProfile {
  /** 首块上限: 开始 / 换设置后尽快出声, 约一句 */
  firstMax: number
  /** 达到即开始找断点 */
  target: number
  /** 硬上限 (单句超长时整句成块, 不在句内切) */
  max: number
  /** 段落短于此值时与后文合并 (对话体一句一段, 逐段请求太碎) */
  minParagraph: number
}

/**
 * 分块尺寸 (speechWeight 单位, 约等于汉字数):
 * - edge: 云端一次请求有 0.3–1s 固定开销, 句间语调由服务端连贯处理, 长一点更自然; 并发合成, 可以走在播放前面。
 * - local: Kokoro 单次输入上限 510 个音素 token (中文约 2–3 token/字), sherpa-onnx 超长时内部按句切开再拼接,
 *   长块并不更连贯, 只会让这一块等得更久 (弱 CPU 上推理慢于实时)。块小一些, 起播和换设置后恢复更快;
 *   同时不低于约 10 字, 过短的输入 Kokoro 语调会变差。
 */
/**
 * 在线 (Edge): 以整段为单位合成 —— 段内句与句由合成引擎自己衔接, 语调与停顿最自然;
 * 只有超长段 (约 500 字以上) 才在句末切开。首块仍短, 保证起播快。
 * 离线 (Kokoro): 本机推理慢, 块小一些, 但同样优先在段末断开。
 * API 语音 (MiniMax / 豆包): 按字计费, 块小一些, 跳走时白花的钱少; 仍以段为单位保证语气连贯。
 * SAPI: 本机或适配器串行合成, 块大小介于两者之间。
 * (2026-10-05 真机实测: 原先 120 字一块, 长段里每一两句就切一次, 每块独立合成都带「句终」语调,
 *  接缝处再裁静音 + 插停顿, 听感就是句与句之间卡一下。)
 */
export const CHUNK_PROFILES: Record<'edge' | 'local' | 'cloud' | 'sapi' | 'qwen', ChunkProfile> = {
  edge: { firstMax: 60, target: 500, max: 600, minParagraph: 16 },
  local: { firstMax: 30, target: 100, max: 160, minParagraph: 12 },
  cloud: { firstMax: 60, target: 300, max: 400, minParagraph: 16 },
  sapi: { firstMax: 40, target: 200, max: 300, minParagraph: 12 },
  // 本机语音模型: 一块十几秒 (合成约为播放速度的两倍), 首块更短好尽快出声; 上限保证装得进模型的上下文
  qwen: { firstMax: 24, target: 70, max: 110, minParagraph: 12 },
}

/**
 * 从待读句子头部取多少句组成下一块; 返回 0 表示要再读入几句才能决定 (ended 时不会返回 0)。
 * 规则: 至少一句, 不在句内切; sectionEnd 必断; 段末且已有 minParagraph 字时断 (首块段末必断);
 * 达到 target 后在 max 以内找最近的好断点 —— 段末优先, 其次句末, 都没有就在当前句后断。
 */
export function nextChunkSize(
  pending: readonly ListenSentence[], profile: ChunkProfile, first: boolean, ended: boolean,
): number {
  if (!pending.length) return 0
  const limit = first ? profile.firstMax : profile.max
  const target = first ? profile.firstMax : profile.target
  let len = 0
  for (let i = 0; i < pending.length; i++) {
    const s = pending[i]
    const w = speechWeight(s.text)
    if (i > 0 && len + w > limit) return i
    len += w
    if (s.sectionEnd) return i + 1
    if (s.paragraphEnd && (first || len >= profile.minParagraph)) return i + 1
    if (len >= target) return goodBreak(pending, i, len, limit, ended)
  }
  return ended ? pending.length : 0
}

function goodBreak(pending: readonly ListenSentence[], i: number, len: number, limit: number, ended: boolean): number {
  let stop = endsSentence(pending[i].text) ? i : -1
  let cum = len
  for (let j = i + 1; j < pending.length; j++) {
    const s = pending[j]
    cum += speechWeight(s.text)
    if (cum > limit) return (stop >= 0 ? stop : i) + 1
    if (s.paragraphEnd || s.sectionEnd) return j + 1
    if (stop < 0 && endsSentence(s.text)) stop = j
  }
  return ended ? pending.length : 0
}

export type ChunkPause = 'clause' | 'sentence' | 'paragraph' | 'section'

export interface ListenChunk {
  sentences: ListenSentence[]
  keys: string[]
  /** 每句的朗读量, 用于块内逐句时刻 */
  weights: number[]
  /** 送去合成的文本 */
  text: string
  /** 本块之后的停顿 */
  pause: ChunkPause
}

const isCjkEdge = (ch: string | undefined) => !!ch && (CJK.test(ch) || /[　-〿＀-￯“”‘’]/.test(ch))

/** 合成文本: 中文句间不加空格; 没有标点的标题 / 段尾补句号, 否则合进一块后会和下一句连读 */
export function chunkText(sentences: readonly ListenSentence[]): string {
  let out = ''
  sentences.forEach((s, i) => {
    let text = s.text.trim()
    if (!text) return
    const last = i === sentences.length - 1
    if (!last && (s.paragraphEnd || s.sectionEnd) && !/[\p{P}]$/u.test(text)) {
      text += CJK.test(text) ? '。' : '.'
    }
    if (out && !(isCjkEdge(out[out.length - 1]) && isCjkEdge(text[0]))) out += ' '
    out += text
  })
  return out
}

export function makeChunk(sentences: ListenSentence[]): ListenChunk {
  const lastS = sentences[sentences.length - 1]
  const pause: ChunkPause = lastS.sectionEnd ? 'section'
    : lastS.paragraphEnd ? 'paragraph'
      : endsSentence(lastS.text) ? 'sentence' : 'clause'
  return {
    sentences,
    keys: sentences.map(s => s.key),
    weights: sentences.map(s => Math.max(0.5, speechWeight(s.text))),
    text: chunkText(sentences),
    pause,
  }
}

/** 整段一次性分块 (句子已全部可得时); 管线里按需增量调用 nextChunkSize */
export function planChunks(sentences: readonly ListenSentence[], profile: ChunkProfile): ListenChunk[] {
  const rest = sentences.slice()
  const out: ListenChunk[] = []
  while (rest.length) {
    const n = nextChunkSize(rest, profile, out.length === 0, true)
    out.push(makeChunk(rest.splice(0, n)))
  }
  return out
}

export const chunkWeight = (chunk: ListenChunk) => chunk.weights.reduce((a, b) => a + b, 0)

// ---------------- 块内逐句时刻 ----------------

/** 各句相对块起点的开始时刻 (秒): 按朗读量占比分配时长, 第一句恰在 0 */
export function sentenceOffsets(weights: readonly number[], duration: number): number[] {
  const total = weights.reduce((a, b) => a + b, 0)
  const out: number[] = []
  let cum = 0
  for (const w of weights) {
    out.push(total > 0 ? duration * cum / total : duration * out.length / weights.length)
    cum += w
  }
  return out
}

// ---------------- 块间停顿 ----------------

/** 块间插入的静音 (秒), 倍速越快停顿越短; 裁剪后两端各留了少量余音, 这里是额外的停顿 */
/** 块尾已保留约 140ms 的自然收音, 这里只补差额; 段内句末接缝要短, 听起来像同一口气读下去 */
export const PAUSE_SECONDS: Record<ChunkPause, number> = {
  clause: 0.05,
  sentence: 0.12,
  paragraph: 0.4,
  section: 0.75,
}

export function gapSeconds(pause: ChunkPause | null, rate: number): number {
  if (!pause) return 0
  return PAUSE_SECONDS[pause] / Math.min(2, Math.max(0.75, rate || 1))
}

/** 下一块的开始时刻: 紧接上一块 + 停顿; 时间线已空 (首块 / 缓冲后) 则稍留余量立即开始 */
export function nextStartTime(now: number, tail: number, gap: number, lead = 0.05): number {
  return Math.max(tail + gap, now + lead)
}

// ---------------- 音频处理 ----------------

export interface SpeechStats {
  /** 保留区间 [start, end) 的采样下标 (已含余量) */
  start: number
  end: number
  /** 保留区间内的峰值 */
  peak: number
  /** 有声帧的均方根 (不计停顿), 0 表示整段静音 */
  activeRms: number
}

export interface TrimOptions {
  frameMs?: number
  /** 开头保留的余量 */
  leadMs?: number
  /** 结尾保留的余量 (留住最后一个音的衰减) */
  tailMs?: number
}

/**
 * 找出有声区间: 按 10ms 帧算均方根, 比最响帧低 38dB 以下 (或绝对底噪以下) 的帧算静音,
 * 去掉首尾的静音帧, 两端各留一点余量。TTS 输出两端常有几百毫秒空白, 块与块接起来就是「卡壳」;
 * 但阈值太高会削掉轻声尾音 (「的」「了」), 余量也要够长, 否则接缝听着像被掐断。
 */
export function analyzeSpeech(samples: Float32Array, sampleRate: number, opts: TrimOptions = {}): SpeechStats {
  const frame = Math.max(1, Math.round(sampleRate * (opts.frameMs ?? 10) / 1000))
  const lead = Math.round(sampleRate * (opts.leadMs ?? 30) / 1000)
  const tail = Math.round(sampleRate * (opts.tailMs ?? 140) / 1000)
  const n = samples.length
  const frames = Math.ceil(n / frame)
  const rms = new Float32Array(frames)
  let maxRms = 0
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const end = Math.min(n, (f + 1) * frame)
    for (let i = f * frame; i < end; i++) sum += samples[i] * samples[i]
    rms[f] = Math.sqrt(sum / Math.max(1, end - f * frame))
    if (rms[f] > maxRms) maxRms = rms[f]
  }
  const silence = Math.max(0.0012, maxRms * 0.0126)
  let first = -1
  let last = -1
  for (let f = 0; f < frames; f++) {
    if (rms[f] < silence) continue
    if (first < 0) first = f
    last = f
  }
  if (first < 0) return { start: 0, end: n, peak: peakOf(samples, 0, n), activeRms: 0 }
  const start = Math.max(0, first * frame - lead)
  const end = Math.min(n, (last + 1) * frame + tail)
  // 有声帧: 不低于最响帧 -20dB, 句间停顿不拉低响度估计
  let sum = 0
  let count = 0
  for (let f = first; f <= last; f++) {
    if (rms[f] < maxRms * 0.1) continue
    sum += rms[f] * rms[f]
    count++
  }
  return { start, end, peak: peakOf(samples, start, end), activeRms: count ? Math.sqrt(sum / count) : 0 }
}

function peakOf(samples: Float32Array, start: number, end: number): number {
  let peak = 0
  for (let i = start; i < end; i++) {
    const a = Math.abs(samples[i])
    if (a > peak) peak = a
  }
  return peak
}

/** 截取 [start, end) 并在两端做线性淡入淡出, 避免接缝处的爆音 */
export function trimAndFade(samples: Float32Array, start: number, end: number, fadeSamples: number): Float32Array {
  const out = samples.slice(start, end)
  const fade = Math.min(fadeSamples, Math.floor(out.length / 2))
  for (let i = 0; i < fade; i++) {
    const g = i / fade
    out[i] *= g
    out[out.length - 1 - i] *= g
  }
  return out
}

/** 目标有声均方根 (约 -18 dBFS) */
export const TARGET_RMS = 0.12

/**
 * 每块的增益: 把有声均方根拉到 TARGET_RMS, 限制在 0.5–2.5 倍;
 * 与上一块的增益折中, 避免块间音量跳变; 最后保证峰值不过 0.98 (不削波)。
 */
export function chunkGain(stats: Pick<SpeechStats, 'peak' | 'activeRms'>, prevGain: number | null): number {
  let g = stats.activeRms > 0 ? TARGET_RMS / stats.activeRms : 1
  g = Math.min(2.5, Math.max(0.5, g))
  if (prevGain) g = prevGain + (g - prevGain) * 0.5
  if (stats.peak * g > 0.98) g = 0.98 / stats.peak
  return g
}
