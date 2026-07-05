/** 本地离线神经语音 (sherpa-onnx + Kokoro v1.1-zh), 桌面版专属 */
import { isTauri } from '../storage/types'
import { useSettings } from '../stores/settings'

export const localTtsAvailable = () => isTauri()

export interface LocalTtsStatus {
  installed: boolean
  path: string
}

export interface DownloadProgress {
  downloaded: number
  total: number
  phase: 'downloading' | 'extracting' | 'done'
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export function localTtsStatus(): Promise<LocalTtsStatus> {
  return invoke('local_tts_status')
}

/** 下载语音包 (~310MB), 进度回调; 走设置中的网络代理 */
export async function localTtsDownload(
  onProgress: (p: DownloadProgress) => void,
): Promise<void> {
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<DownloadProgress>('local-tts-progress', e => onProgress(e.payload))
  try {
    const proxy = useSettings().httpProxy.trim()
    await invoke('local_tts_download', { proxy: proxy || null })
  } finally {
    unlisten()
  }
}

export function localTtsRemove(): Promise<void> {
  return invoke('local_tts_remove')
}

export async function localTtsSynthesize(text: string, sid: number, speed: number): Promise<Blob> {
  const bytes = await invoke<ArrayBuffer>('local_tts_synthesize', { text, sid, speed })
  return new Blob([bytes], { type: 'audio/wav' })
}
