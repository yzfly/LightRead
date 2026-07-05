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
import {
  edgeAvailable, edgePause, edgeResume, edgeStop, edgeSynthesize, playAudio,
} from './edgeTts'
import { localTtsAvailable, localTtsSynthesize } from './localTts'

/** 神经引擎失败后本次会话回退系统语音, 避免每段都等超时 */
let neuralFailed = false
export const resetEdgeFailure = () => { neuralFailed = false }

/** 当前设置下的神经合成器 (edge 在线 / local 离线); 不可用返回 null */
function neuralSynth(): ((text: string) => Promise<Blob>) | null {
  const settings = useSettings()
  if (neuralFailed) return null
  if (settings.ttsEngine === 'edge' && edgeAvailable()) {
    return text => edgeSynthesize(text, settings.edgeVoice, settings.ttsRate)
  }
  if (settings.ttsEngine === 'local' && localTtsAvailable()) {
    return text => localTtsSynthesize(text, settings.localVoiceId, settings.ttsRate)
  }
  return null
}

const prefetchCache = new Map<string, Promise<Blob>>()
const prefetchKey = (text: string) => {
  const s = useSettings()
  return `${s.ttsEngine}|${s.edgeVoice}|${s.localVoiceId}|${s.ttsRate}|${text}`
}

/** 预取下一段合成结果 (消除段间停顿) */
export function prefetchSpeech(text: string) {
  const synth = neuralSynth()
  if (!synth || !text) return
  const key = prefetchKey(text)
  if (!prefetchCache.has(key)) {
    prefetchCache.set(key, synth(text))
    if (prefetchCache.size > 4) {
      const first = prefetchCache.keys().next().value
      if (first) prefetchCache.delete(first)
    }
  }
}

/** 按设置选择引擎朗读一段文本; 神经引擎失败自动回退系统语音 */
export async function speakText(text: string): Promise<'end' | 'cancelled'> {
  const settings = useSettings()
  const synth = neuralSynth()
  if (synth) {
    try {
      const key = prefetchKey(text)
      const pending = prefetchCache.get(key)
      prefetchCache.delete(key)
      const blob = pending ? await pending : await synth(text)
      return await playAudio(blob)
    } catch (e) {
      console.error(e)
      neuralFailed = true
      toast('神经音色暂不可用, 已回退到系统语音', 'error', 4000)
    }
  }
  const voice = await pickVoice(settings.ttsVoice, text)
  return speak(text, { voice: voice as SpeechSynthesisVoice, rate: settings.ttsRate })
}

export function pauseSpeech() {
  edgePause()
  pauseSpeaking()
}

export function resumeSpeech() {
  edgeResume()
  resumeSpeaking()
}

export function stopSpeech() {
  edgeStop()
  stopSpeaking()
  prefetchCache.clear()
}
