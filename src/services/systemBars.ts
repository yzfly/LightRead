// 系统栏适配。安卓依赖 MainActivity 注入的 window.LightReadInsets; iOS 走原生壳 (services/iosShell.ts);
// 其他平台两者都没有, 全部空操作。iOS 的安全区由 WKWebView 的 env(safe-area-inset-*) 直接给出, 不需要桥。
//
// 1. 安全区: edge-to-edge 下网页铺到状态栏 / 导航栏之下, 靠 env(safe-area-inset-*) 让位。
//    旧版 Android System WebView (如 Android 12 + Chromium 135) 不上报这些值, env() 恒为 0,
//    页面会顶到状态栏、底栏被手势条遮挡。这里取原生上报尺寸与 env() 的较大者写入 --lr-safe-*。
// 2. 系统栏图标深浅: 默认跟随手机系统, 应用选了与系统不同的外观 (或阅读页用夜间正文) 时
//    图标会与背景同色看不清, 按页面实际深浅通知原生端切换。

import { iosShellQuiet, isIosApp } from './iosShell'

type Side = 'top' | 'right' | 'bottom' | 'left'
const SIDES: Side[] = ['top', 'right', 'bottom', 'left']

interface AndroidBridge {
  get(): string
  setBarsDark(dark: boolean): void
  /** 1.7.0 起: 沉浸阅读隐藏系统栏 / 常亮 (旧版原生壳没有, 调用前判断) */
  setImmersive?(on: boolean): void
  setKeepScreenOn?(on: boolean): void
  /** 2.5 起: 拦截音量键交给网页翻页 (旧版原生壳没有) */
  setVolumeKeys?(on: boolean): void
  /** 2.6 起: 关掉 WebView 的浮动选字菜单 (阅读页用自己的划线工具条) */
  setSelectionMenu?(on: boolean): void
}

function bridge(): AndroidBridge | undefined {
  return (window as unknown as { LightReadInsets?: AndroidBridge }).LightReadInsets
}

export function installAndroidSafeArea() {
  const b = bridge()
  if (!b) return

  const apply = () => {
    let insets: Partial<Record<Side, number>>
    try {
      insets = JSON.parse(b.get())
    } catch {
      return
    }
    const style = document.documentElement.style
    for (const side of SIDES) {
      const px = Math.max(0, Number(insets[side]) || 0)
      style.setProperty(`--lr-safe-${side}`, `max(env(safe-area-inset-${side}), ${px}px)`)
    }
  }

  // 旋转屏幕、切换手势 / 三键导航时原生端会再次调用
  ;(window as unknown as { __lightreadApplyInsets?: () => void }).__lightreadApplyInsets = apply
  apply()
}

let appDark = false
/** 页面级覆盖 (阅读页正文主题), null 表示跟随应用外观 */
let pageDark: boolean | null = null

function syncBars() {
  bridge()?.setBarsDark(pageDark ?? appDark)
  iosShellQuiet('setBarsDark', { on: pageDark ?? appDark })
}

/** 应用外观 (浅色 / 深色) 变化时调用 */
export function setAppBarsDark(dark: boolean) {
  appDark = dark
  syncBars()
}

/** 沉浸式页面按自身背景指定系统栏深浅; 离开页面时传 null 恢复跟随应用外观 */
export function setPageBarsDark(dark: boolean | null) {
  pageDark = dark
  syncBars()
}

/** 沉浸阅读: 安卓隐藏状态栏与导航栏 (边缘滑动临时呼出), iOS 隐藏状态栏并让主屏幕指示条淡出; 其他平台空操作 */
export function setSystemBarsHidden(hidden: boolean) {
  iosShellQuiet('setImmersive', { on: hidden })
  try { bridge()?.setImmersive?.(hidden) } catch { /* 旧原生壳 */ }
}

/**
 * 阅读时屏幕常亮。安卓走原生 FLAG_KEEP_SCREEN_ON, iOS 走 isIdleTimerDisabled; 网页 / 桌面用 Screen Wake Lock API (支持时)。
 */
let wakeLock: { release(): Promise<void> } | null = null
export async function setKeepScreenOn(on: boolean) {
  if (isIosApp()) {
    iosShellQuiet('setKeepScreenOn', { on })
    return
  }
  const b = bridge()
  if (b?.setKeepScreenOn) {
    try { b.setKeepScreenOn(on) } catch { /* 忽略 */ }
    return
  }
  try {
    if (on && !wakeLock) wakeLock = await (navigator as any).wakeLock?.request('screen') ?? null
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null }
  } catch { wakeLock = null }
}

/** 原生壳能否把音量键交给网页 (只有安卓 App, 且需要新版 MainActivity) */
export function volumeKeysSupported(): boolean {
  return typeof bridge()?.setVolumeKeys === 'function'
}

export type VolumeKey = 'prev' | 'next'

/**
 * 音量键翻页: 传入处理函数时原生端拦截音量键 (上 = 上一页, 下 = 下一页) 并回调,
 * 传 null 时交还系统调音量。离开阅读页、听书播放、打开面板时都要传 null。
 */
export function setVolumeKeyHandler(handler: ((key: VolumeKey) => void) | null) {
  const w = window as unknown as { __lightreadVolumeKey?: (key: VolumeKey) => void }
  if (handler) w.__lightreadVolumeKey = handler
  else delete w.__lightreadVolumeKey
  try { bridge()?.setVolumeKeys?.(!!handler) } catch { /* 旧原生壳 */ }
}

/**
 * 阅读页传 false: 系统选字菜单 (复制 / 全选 / 网页搜索…) 不再和划线工具条一起弹出;
 * 输入框获得焦点时、离开阅读页时传 true, 保留粘贴等系统菜单。只有安卓 / iOS App 生效.
 */
export function setNativeSelectionMenu(on: boolean) {
  iosShellQuiet('setSelectionMenu', { on })
  try { bridge()?.setSelectionMenu?.(on) } catch { /* 旧原生壳 */ }
}
