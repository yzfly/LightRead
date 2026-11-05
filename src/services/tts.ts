/**
 * 听书引擎: 基于系统语音 (Web Speech API), 离线可用.
 * 中文优先: 自动匹配中文音色, 音色列表中文置顶.
 * macOS 可在 系统设置 > 辅助功能 > 朗读内容 中下载更高质量音色.
 */

let voicesReady: Promise<SpeechSynthesisVoice[]> | null = null

/** 部分平台 getVoices 首次调用为空, 需等 voiceschanged */
export function getVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!voicesReady) {
    voicesReady = new Promise(resolve => {
      const load = () => speechSynthesis.getVoices()
      const now = load()
      if (now.length) return resolve(now)
      const timer = setTimeout(() => resolve(load()), 1500)
      speechSynthesis.addEventListener('voiceschanged', () => {
        clearTimeout(timer)
        resolve(load())
      }, { once: true })
    })
  }
  return voicesReady
}

/** 中文置顶排序 (zh-CN > zh-TW/HK > 其他), 供音色下拉 */
export async function listVoicesSorted(): Promise<SpeechSynthesisVoice[]> {
  const voices = await getVoices()
  const weight = (v: SpeechSynthesisVoice) =>
    v.lang.startsWith('zh-CN') || v.lang.startsWith('zh_CN') ? 0
      : v.lang.startsWith('zh') ? 1
        : v.lang.startsWith('en') ? 2 : 3
  return [...voices].sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name))
}

/** 按用户选择或文本语言自动挑选音色 */
export async function pickVoice(
  preferredName: string,
  sampleText: string,
): Promise<SpeechSynthesisVoice | undefined> {
  const voices = await getVoices()
  if (preferredName) {
    const chosen = voices.find(v => v.name === preferredName)
    if (chosen) return chosen
  }
  const isChinese = /[一-鿿]/.test(sampleText)
  const lang = isChinese ? 'zh' : 'en'
  return voices.find(v => v.lang.replace('_', '-').startsWith(`${lang}-CN`))
    ?? voices.find(v => v.lang.startsWith(lang))
    ?? voices[0]
}

export interface SpeakOptions {
  voice?: SpeechSynthesisVoice
  rate: number
}

/** 朗读一段文本, 结束 / 出错 / 被取消时 resolve */
export function speak(text: string, opts: SpeakOptions): Promise<'end' | 'cancelled'> {
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text)
    if (opts.voice) {
      utterance.voice = opts.voice
      utterance.lang = opts.voice.lang
    }
    utterance.rate = opts.rate
    utterance.onend = () => resolve('end')
    utterance.onerror = e =>
      resolve(e.error === 'canceled' || e.error === 'interrupted' ? 'cancelled' : 'end')
    speechSynthesis.speak(utterance)
  })
}

export function stopSpeaking() {
  speechSynthesis.cancel()
}

export function pauseSpeaking() {
  speechSynthesis.pause()
}

export function resumeSpeaking() {
  speechSynthesis.resume()
}

/** foliate TTS 产出的 SSML → 纯文本 */
export function ssmlToText(ssml: string): string {
  const doc = new DOMParser().parseFromString(ssml, 'application/xml')
  return (doc.documentElement?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

// ================= 引擎调度 =================
import { useSettings } from '../stores/settings'
import { toast } from './toast'
import { t } from '../i18n'
import {
  edgeAvailable, edgePause, edgeResume, edgeStop, edgeSynthesize, playAudio,
} from './edgeTts'
import { isLocalCrashError, localPack, localTtsAvailable, localTtsSynthesize, localTtsWarmup } from './localTts'
import { cloudErrorCode, cloudSignature, cloudSynthesize, isTransientCloudError } from './cloudTts.ts'
import { sapiPlatform, sapiSynthesize } from './sapiTts.ts'

/** 神经引擎失败后本次会话回退系统语音, 避免每段都等超时 */
let neuralFailed = false
// 停止期间后台合成可能仍在运行；完成后不得重新开始播放。
let speechGeneration = 0
export const resetEdgeFailure = () => { neuralFailed = false }

/**
 * 离线合成切块: 先按句切, 再把短句合并到 maxLen 以内; 超长句按逗号/空白再切, 最后硬切.
 * 整段一次合成要等全部推理完才有声音, 切块后第一句合成完即可播放, 其余句子边播边合成.
 */
export function splitSpeechText(text: string, maxLen = 80): string[] {
  const sentences: string[] = []
  let buf = ''
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    buf += ch
    const next = chars[i + 1]
    const terminal = /[。！？!?…；;\n]/.test(ch) || (ch === '.' && (next === undefined || /\s/.test(next)))
    if (!terminal) continue
    // 吞掉紧随的同类标点、右引号/括号和空白, 让它们留在本句末尾
    while (i + 1 < chars.length && /[。！？!?…；;.\s"'”’」』）)\]]/.test(chars[i + 1])) buf += chars[++i]
    sentences.push(buf)
    buf = ''
  }
  if (buf) sentences.push(buf)

  const pieces: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= maxLen) { pieces.push(sentence); continue }
    let rest = sentence
    while (rest.length > maxLen) {
      const head = rest.slice(0, maxLen)
      let cut = -1
      for (const re of [/[，,、：:）)]/g, /\s/g]) {
        for (const m of head.matchAll(re)) if (m.index! + 1 >= maxLen * 0.3) cut = m.index! + 1
        if (cut > 0) break
      }
      if (cut <= 0) cut = maxLen
      pieces.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    if (rest) pieces.push(rest)
  }

  // 首块合并上限减半: 开始/跳转后尽快出声, 后续块在播放期间合成
  const chunks: string[] = []
  for (const piece of pieces) {
    const last = chunks.length - 1
    const limit = last === 0 ? Math.ceil(maxLen / 2) : maxLen
    if (last >= 0 && chunks[last].length + piece.length <= limit) chunks[last] += piece
    else chunks.push(piece)
  }
  return chunks.map(c => c.trim()).filter(c => /[\p{L}\p{N}]/u.test(c))
}

export interface NeuralEngine {
  kind: 'edge' | 'local' | 'cloud' | 'sapi'
  synth: (text: string) => Promise<Blob>
  /** 离线引擎: 单线程推理, 合成请求串行排队并按句切块 */
  local: boolean
  /** 失败后值得重试一次 (网络抖动、限流) */
  retryable?: (error: unknown) => boolean
}

/** 当前设置下的神经合成器 (edge 在线 / local 离线); 不可用或本次会话已失败返回 null (用系统语音) */
export function neuralEngine(): NeuralEngine | null {
  const settings = useSettings()
  if (neuralFailed) return null
  if (settings.ttsEngine === 'edge' && edgeAvailable()) {
    return { kind: 'edge', local: false, synth: text => edgeSynthesize(text, settings.edgeVoice, settings.ttsRate) }
  }
  if (settings.ttsEngine === 'cloud' && edgeAvailable()) {
    return {
      kind: 'cloud',
      local: false,
      retryable: isTransientCloudError,
      synth: text => cloudSynthesize(settings, text, settings.ttsRate),
    }
  }
  if (settings.ttsEngine === 'sapi' && edgeAvailable() && sapiPlatform()) {
    return { kind: 'sapi', local: true, synth: text => sapiSynthesize(text, settings.sapiVoice, settings.ttsRate) }
  }
  if (settings.ttsEngine === 'local' && localTtsAvailable()) {
    return {
      kind: 'local',
      local: true,
      synth: async text => {
        await warmLocal()
        return localTtsSynthesize(text, settings.localVoiceId, settings.ttsRate)
      },
    }
  }
  return null
}

// ---- 离线模型加载提示 ----
/** 加载超过该时长才提示, 已加载的模型不闪提示 */
export const LOCAL_LOADING_HINT_MS = 600
let localWarm: Promise<void> | null = null

/** 确保离线模型已加载 (首次 10–20s); 加载较慢时显示「正在加载语音模型」并在完成后撤下 */
function warmLocal(): Promise<void> {
  if (!localWarm) {
    localWarm = (async () => {
      let dismiss: (() => void) | undefined
      const timer = setTimeout(() => {
        dismiss = toast(t('tts.localLoading'), 'info', 60_000)
      }, LOCAL_LOADING_HINT_MS)
      try {
        await localTtsWarmup()
      } catch (e) {
        localWarm = null
        throw e
      } finally {
        clearTimeout(timer)
        dismiss?.()
      }
    })()
  }
  return localWarm
}

/** 神经引擎出错: 本次会话改用系统语音 (resetEdgeFailure 后恢复), 提示一次 */
export function reportNeuralFailure(error: unknown) {
  console.error(error)
  if (neuralFailed) return
  neuralFailed = true
  const cloudCode = cloudErrorCode(error)
  if (cloudCode) {
    toast(t(`tts.cloudError.${cloudCode}`), 'error', 6000)
    return
  }
  if (isLocalCrashError(error)) {
    localPack.crashed = true
    toast(t('tts.localCrashedPaused'), 'error', 8000)
    return
  }
  toast(t('tts.neuralUnavailable'), 'error', 4000)
}

/** 语音包被删除/重装后调用, 下次合成重新提示加载 */
export function forgetLocalModel() {
  localWarm = null
}

/** 打开听书面板时预加载离线模型, 点「开始」时就不必再等; 失败静默 (未安装等) */
export function warmUpSpeech() {
  const settings = useSettings()
  if (neuralFailed || settings.ttsEngine !== 'local' || !localTtsAvailable() || localPack.crashed) return
  warmLocal().catch(() => { /* 开始朗读时再报错 */ })
}

// ---- 合成队列 / 预取缓存 ----
// 离线推理在 Rust 侧共用一个引擎 (单把锁), 并发请求只会抢锁且顺序不定.
// 这里在前端串行排队: 当前段的句子优先于预取的后续段, 先请求的先合成;
// 停止时丢弃尚未开始的请求, 不让过期预取占住引擎.
class SpeechCancelled extends Error {}

interface SynthJob {
  priority: number
  seq: number
  start: () => void
  cancel: () => void
}

interface CacheEntry {
  promise: Promise<Blob>
  /** 仍在排队 (未开始) 的任务; 被当前段再次请求时提升优先级 */
  job?: SynthJob
}

const queue: SynthJob[] = []
let activeJob: SynthJob | null = null
let jobSeq = 0
let pumpScheduled = false

function pump() {
  if (activeJob || !queue.length) return
  let best = 0
  for (let i = 1; i < queue.length; i++) {
    const a = queue[i]
    const b = queue[best]
    if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i
  }
  const [job] = queue.splice(best, 1)
  activeJob = job
  job.start()
}

/** 同一轮同步代码里的请求先全部入队再挑选, 预取与当前段的调用顺序不影响合成顺序 */
function schedulePump() {
  if (pumpScheduled) return
  pumpScheduled = true
  queueMicrotask(() => {
    pumpScheduled = false
    pump()
  })
}

function enqueue(engine: NeuralEngine, text: string, priority: number): CacheEntry {
  const entry = {} as CacheEntry
  entry.promise = new Promise<Blob>((resolve, reject) => {
    const job: SynthJob = {
      priority,
      seq: jobSeq++,
      start() {
        entry.job = undefined
        engine.synth(text).then(resolve, reject).finally(() => {
          if (activeJob === job) activeJob = null
          schedulePump()
        })
      },
      cancel() {
        entry.job = undefined
        reject(new SpeechCancelled())
      },
    }
    entry.job = job
    queue.push(job)
  })
  schedulePump()
  return entry
}

const synthCache = new Map<string, CacheEntry>()
const MAX_CACHE = 32
const cacheKey = (text: string) => {
  const s = useSettings()
  return `${s.ttsEngine}|${s.edgeVoice}|${s.localVoiceId}|${s.ttsRate}|${s.ttsEngine === 'cloud' ? cloudSignature(s) : ''}|${s.ttsEngine === 'sapi' ? s.sapiVoice : ''}|${text}`
}

/** 取 (或发起) 一块文本的合成; priority 越小越先合成 */
function requestSynth(engine: NeuralEngine, text: string, priority: number): CacheEntry {
  const key = cacheKey(text)
  let entry = synthCache.get(key)
  if (entry) {
    if (entry.job && entry.job.priority > priority) entry.job.priority = priority
    return entry
  }
  if (engine.local) {
    entry = enqueue(engine, text, priority)
  } else {
    // 在线引擎走网络, 可并发, 不排队
    entry = { promise: engine.synth(text) }
  }
  // 预取的结果可能没人 await (停止/跳转), 避免未处理的 rejection
  entry.promise.catch(() => {})
  synthCache.set(key, entry)
  if (synthCache.size > MAX_CACHE) {
    const first = synthCache.keys().next().value
    if (first !== undefined) synthCache.delete(first)
  }
  return entry
}

function speechParts(engine: NeuralEngine, text: string): string[] {
  if (engine.kind === 'cloud') return splitSpeechText(text, 400)
  return engine.local ? splitSpeechText(text) : [text]
}

/** 预取最多的切块数: 足够覆盖下一段开头, 又不至于为可能被跳过的段落占满引擎 */
const PREFETCH_PARTS = 2

/**
 * 预取后续段落的合成结果 (消除段间停顿).
 * distance 为与当前段的距离 (1 = 下一段), 距离越远越晚合成, 始终排在当前段之后.
 */
export function prefetchSpeech(text: string, distance = 1) {
  const engine = neuralEngine()
  if (!engine || !text) return
  for (const part of speechParts(engine, text).slice(0, PREFETCH_PARTS)) {
    requestSynth(engine, part, Math.max(1, distance))
  }
}

// ---- 暂停: 切块之间 (没有正在播放的音频) 也要停住 ----
let paused = false
let resumeWaiters: (() => void)[] = []
function waitWhileSpeechPaused(): Promise<void> {
  if (!paused) return Promise.resolve()
  return new Promise(resolve => resumeWaiters.push(resolve))
}
function releasePause() {
  paused = false
  const waiters = resumeWaiters
  resumeWaiters = []
  for (const resolve of waiters) resolve()
}

/** 按设置选择引擎朗读一段文本; 神经引擎失败自动回退系统语音 */
export async function speakText(text: string): Promise<'end' | 'cancelled'> {
  const generation = speechGeneration
  const settings = useSettings()
  const engine = neuralEngine()
  let remaining = text
  if (engine) {
    // 同步发起本段全部切块的合成 (优先级 0), 第一块到手即播放, 其余边播边合成
    const parts = speechParts(engine, text)
    const entries = parts.map(part => requestSynth(engine, part, 0))
    let index = 0
    try {
      for (; index < parts.length; index++) {
        const blob = await entries[index].promise
        synthCache.delete(cacheKey(parts[index]))
        if (generation !== speechGeneration) return 'cancelled'
        await waitWhileSpeechPaused()
        if (generation !== speechGeneration) return 'cancelled'
        const result = await playAudio(blob)
        if (result === 'cancelled' || generation !== speechGeneration) return 'cancelled'
      }
      return 'end'
    } catch (e) {
      if (generation !== speechGeneration || e instanceof SpeechCancelled) return 'cancelled'
      reportNeuralFailure(e)
      // 只用系统语音补读尚未播放的部分
      remaining = parts.slice(index).join(' ') || text
    }
  }
  const voice = await pickVoice(settings.ttsVoice, remaining)
  if (generation !== speechGeneration) return 'cancelled'
  return speak(remaining, { voice: voice as SpeechSynthesisVoice, rate: settings.ttsRate })
}

export function pauseSpeech() {
  paused = true
  edgePause()
  pauseSpeaking()
}

export function resumeSpeech() {
  releasePause()
  edgeResume()
  resumeSpeaking()
}

export function stopSpeech() {
  speechGeneration++
  edgeStop()
  stopSpeaking()
  // 未开始的合成直接丢弃; 正在推理的一块无法中断, 让新会话不必排在它后面 (Rust 侧锁会串行)
  for (const job of queue.splice(0)) job.cancel()
  activeJob = null
  synthCache.clear()
  releasePause()
}
