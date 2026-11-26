/**
 * Windows 桌面版的系统媒体控制由原生层持有 (src-tauri/src/media_controls.rs, issue #25):
 * 阅读页上报听书状态与书名章节, 耳机线控 / 键盘媒体键 / 音量浮窗的按键以事件传回。
 * 其他平台继续用 navigator.mediaSession。
 */
import type { ListenTtsState } from './listenMediaKeys'

export type MediaControlsAction = 'play' | 'pause' | 'stop' | 'nexttrack' | 'previoustrack'

export interface MediaControlsInfo {
  state: ListenTtsState
  title: string
  artist: string
  album: string
}

export function nativeMediaControls(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Windows NT/.test(navigator.userAgent)
}

let lastSent = ''

/** 每句都会调用; 只有状态或标题变了才发给原生层 */
export async function syncMediaControls(info: MediaControlsInfo): Promise<void> {
  if (!nativeMediaControls()) return
  const key = JSON.stringify(info)
  if (key === lastSent) return
  lastSent = key
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('media_controls_update', { info }).catch(() => { lastSent = '' })
}

export async function onMediaControlsButton(cb: (action: MediaControlsAction) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<MediaControlsAction>('media-controls-button', e => cb(e.payload))
}
