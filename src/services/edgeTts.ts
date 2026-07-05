/**
 * Edge TTS (在线神经网络音色): 微软 Edge "大声朗读" 云端服务.
 * 合成在 Rust 侧完成 (需要特定握手头), 此处负责调用与播放. 仅桌面版可用.
 */
import { isTauri } from '../storage/types'

export interface EdgeVoice {
  id: string
  label: string
}

/** 常用音色, 中文置顶 */
export const EDGE_VOICES: EdgeVoice[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声温暖 (推荐)' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声阳光' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男声磁性' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声活泼' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声新闻' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 少年音' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北话' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾腔' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语' },
  { id: 'en-US-AriaNeural', label: 'Aria · 英语女声' },
  { id: 'en-US-AndrewNeural', label: 'Andrew · 英语男声' },
  { id: 'ja-JP-NanamiNeural', label: 'Nanami · 日语' },
]

export const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoxiaoNeural'

export const edgeAvailable = () => isTauri()

let currentAudio: HTMLAudioElement | null = null

/** 合成一段文本为 mp3 Blob (Rust 侧完成) */
export async function edgeSynthesize(text: string, voice: string, rate: number): Promise<Blob> {
  const { invoke } = await import('@tauri-apps/api/core')
  const ratePercent = Math.round((rate - 1) * 100)
  const bytes = await invoke<ArrayBuffer>('edge_tts_synthesize', {
    text,
    voice: voice || DEFAULT_EDGE_VOICE,
    ratePercent,
  })
  return new Blob([bytes], { type: 'audio/mpeg' })
}

/** 播放 mp3 Blob, 结束 / 被取消时 resolve */
export function playAudio(blob: Blob): Promise<'end' | 'cancelled'> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    currentAudio = audio
    const done = (result: 'end' | 'cancelled') => {
      URL.revokeObjectURL(url)
      if (currentAudio === audio) currentAudio = null
      resolve(result)
    }
    audio.onended = () => done('end')
    audio.onerror = () => done(audio.dataset.cancelled ? 'cancelled' : 'end')
    audio.onpause = () => {
      // pause() 且被标记取消时立即结束
      if (audio.dataset.cancelled) done('cancelled')
    }
    audio.play().catch(() => done('end'))
  })
}

export function edgePause() {
  currentAudio?.pause()
}

export function edgeResume() {
  currentAudio?.play().catch(() => { /* 已结束 */ })
}

export function edgeStop() {
  if (currentAudio) {
    currentAudio.dataset.cancelled = '1'
    currentAudio.pause()
    currentAudio = null
  }
}
