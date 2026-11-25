/**
 * 系统媒体键 (耳机线控 / 键盘媒体键 / 锁屏) 在听书时该做什么, 桌面与 App 阅读页共用。
 *
 * 听书用 Web Audio 出声, Chromium / WebView2 看不到媒体元素在播, 认为页面没在播放,
 * 于是播放 / 暂停键每次都发 'pause' (issue #25): 暂停中再收到 'pause' 就当作继续。
 */
export type ListenTtsState = 'stopped' | 'playing' | 'paused'
export type MediaKeyCommand = 'start' | 'pause' | 'resume' | 'none'

export function mediaKeyCommand(action: 'play' | 'pause', state: ListenTtsState): MediaKeyCommand {
  if (state === 'paused') return 'resume'
  if (action === 'pause') return state === 'playing' ? 'pause' : 'none'
  return state === 'stopped' ? 'start' : 'none'
}
