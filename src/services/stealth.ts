/**
 * 摸鱼模式 (桌面阅读器): 在工作电脑上看书时, 尽量降低轻阅的存在感。
 *
 * - 窗口: 去掉标题栏 / 边框 / 阴影, 可选置顶与标题伪装, 老板键 (全局快捷键) 一键藏起窗口,
 *   都由原生命令完成 (src-tauri/src/stealth.rs);
 * - 页面: 阅读区背景按设定透明度透出后面的桌面或文档 (主窗口以透明窗口创建, 平时页面背景不透明),
 *   隐去工具栏、页眉页脚和翻页按钮, 只剩正文; 文字可调淡。
 *
 * 这里是纯函数 + 原生命令的薄封装, 阅读页负责界面状态。
 */
import type { StealthPrefs } from '../stores/settings'

export const STEALTH_BG_MIN = 0.2
export const STEALTH_TEXT_MIN = 0.4

/** 只有桌面安装版有窗口控制; 网页版与 App 不提供 */
export function stealthSupported(): boolean {
  // 与 storage/types 的 isTauri 相同; 这里内联, 纯函数测试不必加载存储层
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !/Android|iPhone|iPad/i.test(globalThis.navigator?.userAgent ?? '')
}

export function clampOpacity(v: unknown, min: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1
  return Math.round(Math.min(1, Math.max(min, n)) * 100) / 100
}

/** 十六进制色 → 带透明度的 rgba; 不是十六进制时原样返回 (不透明) */
export function stealthBackground(hex: string, opacity: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1]
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${clampOpacity(opacity, STEALTH_BG_MIN)})`
}

/**
 * PDF 摸鱼「只留墨迹」: feColorMatrix 的矩阵。输出颜色固定为墨色, 透明度 = 原透明度 - 亮度,
 * 白纸完全透明, 黑字完全不透明, 灰字介于两者之间; 彩图变成墨色剪影 (摸鱼时反而更不显眼)。
 */
export function stealthInkMatrix(ink: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(ink.trim())
  const n = m ? parseInt(m[1], 16) : 0x1f2329
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => +(v / 255).toFixed(4))
  return [
    `0 0 0 0 ${c[0]}`,
    `0 0 0 0 ${c[1]}`,
    `0 0 0 0 ${c[2]}`,
    // 透明度 = 原透明度 - 亮度: 白纸 1-1=0, 黑字 1-0=1; 画布上没画到的透明像素 (RGB 也是 0) 0-0=0,
    // 不能用常数 1, 否则透明处会变成墨块 (2026-11-08 Win10: PDF 页间与页边出现深色大块)
    '-0.2126 -0.7152 -0.0722 1 0',
  ].join(' ')
}

/** PDF 摸鱼的纸色与墨色: 跟随应用外观 (浅色白纸黑字, 深色深纸浅字) */
export function stealthPdfColors(theme: 'light' | 'dark') {
  return theme === 'dark' ? { paper: '#1f2125', ink: '#d6d6d6' } : { paper: '#ffffff', ink: '#1f2329' }
}

const isMac = () => /Mac/i.test(globalThis.navigator?.platform ?? '') || /Mac OS X/.test(globalThis.navigator?.userAgent ?? '')

/** 修饰键在快捷键字符串里的写法 (与 tauri-plugin-global-shortcut 的解析一致) */
const MODS = ['Ctrl', 'Alt', 'Shift', 'Super'] as const

/**
 * 录制老板键: 从按键事件得到 "Ctrl+Alt+Z" 这样的字符串。
 * 至少一个修饰键 + 一个普通键; 只按了修饰键、或没有修饰键时返回 null (避免抢走普通打字的键)。
 */
export function shortcutFromEvent(e: { key: string; code?: string; keyCode?: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const code = e.code ?? ''
  let key = ''
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code
  // 远程桌面 / 自动化工具 / 部分输入法送来的按键没有 code, 按虚拟键码认字母、数字与 F 键
  else if (!code && (e.keyCode ?? 0) >= 65 && (e.keyCode ?? 0) <= 90) key = String.fromCharCode(e.keyCode!)
  else if (!code && (e.keyCode ?? 0) >= 48 && (e.keyCode ?? 0) <= 57) key = String.fromCharCode(e.keyCode!)
  else if (!code && (e.keyCode ?? 0) >= 112 && (e.keyCode ?? 0) <= 135) key = `F${e.keyCode! - 111}`
  else if (['Space', 'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Escape', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete'].includes(code)) key = code
  if (!key) return null
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
  // F 键可以单独用; 其他键必须带修饰键, 且不能只有 Shift (Shift+字母就是打大写字母)
  if (!/^F\d+$/.test(key) && (mods.length === 0 || (mods.length === 1 && mods[0] === 'Shift'))) return null
  return [...mods, key].join('+')
}

/** 显示用: macOS 用 ⌃⌥⇧⌘ 符号, 其他平台保持 Ctrl+Alt+Z */
export function bossKeyLabel(key: string, mac = isMac()): string {
  if (!key) return ''
  const parts = key.split('+').filter(Boolean)
  if (!mac) return parts.map(p => (p === 'Super' ? 'Win' : p)).join('+')
  const sym: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Super: '⌘' }
  return parts.map(p => sym[p] ?? p).join('')
}

/** 快捷键字符串是否是本模块能生成的格式 (设置被手改 / 同步来的脏值时不拿去注册) */
export function isValidBossKey(key: string): boolean {
  const parts = key.split('+')
  const last = parts.pop() ?? ''
  if (!parts.every(p => (MODS as readonly string[]).includes(p))) return false
  if (new Set(parts).size !== parts.length) return false
  return /^([A-Z0-9]|F\d{1,2}|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Escape|Home|End|PageUp|PageDown|Insert|Delete)$/.test(last)
    && (parts.length > 0 || /^F\d+$/.test(last))
}

export interface StealthResult {
  bossKey: boolean
  bossKeyError?: string | null
}

export interface StealthBounds { x: number; y: number; w: number; h: number }

/** 保存的窗口位置是否像样 (设置被手改 / 旧版本时不拿去用) */
export function validBounds(b: unknown): StealthBounds | null {
  if (!b || typeof b !== 'object') return null
  const { x, y, w, h } = b as Record<string, unknown>
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v)
  if (!int(x) || !int(y) || !int(w) || !int(h)) return null
  if ((w as number) < 200 || (h as number) < 120 || (w as number) > 20000 || (h as number) > 20000) return null
  return { x: x as number, y: y as number, w: w as number, h: h as number }
}

/** 传给原生层的窗口选项 */
export function nativeOptions(prefs: StealthPrefs, defaultTitle: string) {
  return {
    title: prefs.disguise ? (prefs.disguiseTitle.trim() || defaultTitle) : null,
    alwaysOnTop: !!prefs.alwaysOnTop,
    bossKey: prefs.bossKey && isValidBossKey(prefs.bossKey) ? prefs.bossKey : null,
    skipTaskbar: !!prefs.skipTaskbar,
    hideFromCapture: !!prefs.hideFromCapture,
    bounds: validBounds(prefs.bounds),
  }
}

/** 进入 (或在摸鱼模式中更新) 窗口状态 */
export async function enterStealthWindow(prefs: StealthPrefs, defaultTitle: string): Promise<StealthResult> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<StealthResult>('stealth_enter', { options: nativeOptions(prefs, defaultTitle) })
}

/** 退出摸鱼; 返回摸鱼时的窗口位置大小 (下次进入时套用) */
export async function exitStealthWindow(): Promise<StealthBounds | null> {
  const { invoke } = await import('@tauri-apps/api/core')
  return validBounds(await invoke('stealth_exit'))
}

/** 老板键藏起 / 恢复窗口时通知页面 (藏起时暂停听书与背景音) */
export async function onBossKey(cb: (hidden: boolean) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<{ hidden: boolean }>('stealth-boss', e => cb(!!e.payload?.hidden))
}
