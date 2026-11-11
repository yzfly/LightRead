/**
 * iOS App 的原生壳 (src-tauri/plugins/ios-shell, Swift), 与 Android 的 MainActivity.kt 对应。
 * 网页只经这里调用; 其他平台 isIosApp() 为 false, 不会发出调用。
 * 平台取构建期常量: iPad 的 WKWebView 默认自称 Macintosh, 不能靠 userAgent 判断。
 */
export const isIosApp = () =>
  typeof __APP_PLATFORM__ !== 'undefined' && __APP_PLATFORM__ === 'ios'
  && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export type IosShellCommand =
  | 'setBarsDark' | 'setImmersive' | 'setKeepScreenOn' | 'setSelectionMenu'
  | 'saveImage' | 'shareFile' | 'shareText' | 'haptic'

export async function iosShell<T = Record<string, unknown>>(command: IosShellCommand, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>('ios_shell', { command, args })
}

/** 只改系统外观的调用: 失败不影响阅读, 不向上抛 */
export function iosShellQuiet(command: IosShellCommand, args: Record<string, unknown> = {}) {
  if (!isIosApp()) return
  void iosShell(command, args).catch(() => { /* 旧原生壳或系统拒绝 */ })
}
