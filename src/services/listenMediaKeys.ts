/**
 * 系统媒体键 (耳机线控 / 键盘媒体键 / 锁屏) 在听书时该做什么, 桌面与 App 阅读页共用。
 *
 * 听书用 Web Audio 出声, 浏览器给页面的媒体会话不可靠: 播放 / 暂停键可能每次都发 'pause',
 * 所以暂停中再收到 'pause' 就当作继续。Windows 桌面版的会话改由原生层持有 (issue #25:
 * WebView2 在暂停时撤掉页面的会话, 见 src-tauri/src/media_controls.rs)。
 */
export type ListenTtsState = 'stopped' | 'playing' | 'paused'
export type MediaKeyCommand = 'start' | 'pause' | 'resume' | 'none'

export function mediaKeyCommand(action: 'play' | 'pause', state: ListenTtsState): MediaKeyCommand {
  if (state === 'paused') return 'resume'
  if (action === 'pause') return state === 'playing' ? 'pause' : 'none'
  return state === 'stopped' ? 'start' : 'none'
}
