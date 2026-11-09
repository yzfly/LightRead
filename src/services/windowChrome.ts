/**
 * 窗口外观 (Windows 桌面): 无系统标题栏、四角圆角, 与 macOS 对齐; 原生侧见 src-tauri/src/window_chrome.rs。
 *
 * 在 <html> 上挂类, 样式见 styles/main.css「自绘窗口」:
 * - lr-chrome         自绘窗口 (components/WindowTitleBar.vue)。非阅读页按原型 B「侧栏到顶」(2026-11-08 用户选定):
 *                     没有标题条, 窗口按钮浮在右上角, 顶行 (--chrome-band) 的空白处拖动窗口、双击最大化;
 *                     阅读页保留一条标题栏 (阅读页自己的工具栏在其下)
 * - lr-chrome-round   页面自己裁圆角 (Windows 10; Windows 11 由系统画)
 * - lr-max / lr-fullscreen  最大化 / 全屏时去圆角; 全屏时标题栏也收起
 * macOS / Linux / 网页 / App 不做任何事。
 */
import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'

export const windowChrome = reactive({ custom: false, maximized: false, fullscreen: false })
let syncState: (() => Promise<void>) | null = null

function desktopTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !/Android|iPhone|iPad/i.test(navigator.userAgent)
}

/** 应用启动时调用一次; 端到端测试装好模拟 IPC 后经 window.__lrInitWindowChrome 再调一次 */
export async function initWindowChrome(): Promise<void> {
  if (typeof window !== 'undefined') (window as unknown as { __lrInitWindowChrome?: () => Promise<void> }).__lrInitWindowChrome = initWindowChrome
  if (!desktopTauri() || windowChrome.custom) return
  let info: { custom: boolean; nativeRound: boolean }
  try {
    info = await invoke('window_chrome')
  } catch {
    return
  }
  if (!info?.custom) return
  const root = document.documentElement
  root.classList.add('lr-chrome')
  root.classList.toggle('lr-chrome-round', !info.nativeRound)
  windowChrome.custom = true
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  const sync = async () => {
    const [max, full] = await Promise.all([win.isMaximized().catch(() => false), win.isFullscreen().catch(() => false)])
    windowChrome.maximized = max
    windowChrome.fullscreen = full
    root.classList.toggle('lr-max', max)
    root.classList.toggle('lr-fullscreen', full || !!document.fullscreenElement)
  }
  syncState = sync
  await sync()
  void win.onResized(() => void sync())
  // 顶行空白处 = 标题栏: 按下拖动窗口, 双击最大化 / 还原 (与 data-tauri-drag-region 的处理一致)
  document.addEventListener('mousedown', e => {
    if (e.button !== 0 || !inDragBand(e.target, e.clientY)) return
    e.preventDefault()
    void (e.detail === 2 ? win.toggleMaximize() : win.startDragging())
  })
  // 网页全屏 (阅读页的全屏按钮) 不一定改变窗口状态, 一并看 document.fullscreenElement
  document.addEventListener('fullscreenchange', () => root.classList.toggle('lr-fullscreen', windowChrome.fullscreen || !!document.fullscreenElement))
}

export async function windowAction(action: 'minimize' | 'toggleMaximize' | 'close'): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  await win[action]()
}

let maximizedBeforeFullscreen = false
/**
 * 窗口全屏 (阅读页的全屏按钮)。自绘窗口在最大化状态下直接全屏, 窗口铺满了屏幕, 网页却停在工作区大小,
 * 标题栏和任务栏都还在 (2026-11-08 Win10 第 2 轮); 所以先还原再全屏, 退出全屏时再最大化回去。
 */
export async function setWindowFullscreen(on: boolean): Promise<void> {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  if (on) {
    maximizedBeforeFullscreen = windowChrome.custom && (await win.isMaximized().catch(() => false))
    if (maximizedBeforeFullscreen) await win.unmaximize()
    await win.setFullscreen(true)
  } else {
    await win.setFullscreen(false)
    if (maximizedBeforeFullscreen) await win.maximize()
    maximizedBeforeFullscreen = false
  }
  await syncState?.()
}

/** 顶行里不能拿来拖窗口的东西: 可操作控件与书卡 */
const INTERACTIVE = [
  'a', 'button', 'input', 'textarea', 'select', 'label', 'summary', 'video', 'audio', 'canvas',
  '[role=button]', '[role=switch]', '[role=tab]', '[role=menu]', '[role=menuitem]', '[role=option]', '[role=dialog]',
  '[contenteditable]:not([contenteditable=false])', '[tabindex]:not([tabindex="-1"])', '.book-card', '.no-drag',
].join(',')

/**
 * 这一下按在顶行的空白处吗 (算作标题栏)。只认侧栏与非阅读页的主区, 弹窗、菜单、阅读页 (有自己的标题栏) 都不算;
 * 摸鱼 / 全屏时没有标题栏。导出给测试用。
 */
export function inDragBand(target: EventTarget | null, clientY: number): boolean {
  if (!windowChrome.custom || !(target instanceof Element)) return false
  const root = document.documentElement
  if (root.classList.contains('lr-stealth') || root.classList.contains('lr-fullscreen')) return false
  const band = parseFloat(getComputedStyle(root).getPropertyValue('--chrome-band')) || 48
  if (clientY >= band) return false
  if (!target.closest('.shell:not(.immersive) > .sidebar, .shell:not(.immersive) > .main')) return false
  return !target.closest(INTERACTIVE)
}
