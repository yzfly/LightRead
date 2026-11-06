/**
 * 诊断日志。桌面与 App 写入原生滚动日志文件 (src-tauri/src/diagnostics.rs), 网页版只留内存缓冲。
 * 只在本机保存, 用户主动导出才会离开设备; 没有任何自动上传。
 */
import { strToU8, zipSync } from 'fflate'
import { isTauri } from '../storage/types'
import {
  RingBuffer, bundleName, feedbackUrl, formatLine, makeLine, redact,
  type DiagnosticsEnv, type LogLevel, type LogLine,
} from './diagnosticsCore'

// 不从 updater 引入: PDF 服务也用这里, 不把更新器和界面依赖带进去
const CURRENT_VERSION = __APP_VERSION__

const buffer = new RingBuffer<LogLine>(1500)
let pending: LogLine[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let installed = false
let reentrant = false

async function flush() {
  flushTimer = null
  if (!pending.length || !isTauri()) {
    pending = []
    return
  }
  const lines = pending
  pending = []
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('diagnostics_append', { lines: lines.map(l => ({ level: l.level, area: l.area, message: l.message })) })
  } catch { /* 写日志失败不能影响功能, 也不能再记录一遍 */ }
}

/** 记一条日志。urgent: 马上交给原生层, 用于可能让 WebView 崩溃的操作之前 */
export function logEvent(level: LogLevel, area: string, ...parts: unknown[]) {
  if (reentrant) return
  reentrant = true
  try {
    const line = makeLine(level, area, parts)
    buffer.push(line)
    pending.push(line)
    if (level === 'error') void flush()
    else if (!flushTimer) flushTimer = setTimeout(flush, 800)
  } finally {
    reentrant = false
  }
}

/** 接管未捕获错误与 console.warn / error; 原有输出不变 */
export function installDiagnostics() {
  if (installed) return
  installed = true
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      logEvent(level, 'console', ...args)
    }
  }
  window.addEventListener('error', event => {
    logEvent('error', 'window', event.error ?? event.message, `${event.filename}:${event.lineno}:${event.colno}`)
  })
  window.addEventListener('unhandledrejection', event => {
    logEvent('error', 'promise', event.reason)
  })
  logEvent('info', 'app', `start v${CURRENT_VERSION}`, navigator.userAgent)
}

function platformLabel(): string {
  const ua = navigator.userAgent
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown'
  return `${os} ${isTauri() ? 'App' : 'Web'}`
}

interface NativeInfo {
  os: string
  arch: string
  webview?: string | null
  totalMemoryMb?: number | null
  freeMemoryMb?: number | null
}

async function nativeInfo(): Promise<NativeInfo | null> {
  if (!isTauri()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<NativeInfo>('diagnostics_system_info')
  } catch {
    return null
  }
}

export async function diagnosticsEnv(): Promise<DiagnosticsEnv> {
  const info = await nativeInfo()
  return {
    version: CURRENT_VERSION,
    platform: platformLabel(),
    userAgent: navigator.userAgent,
    webview: info?.webview ?? undefined,
    memory: info?.totalMemoryMb ? `${info.freeMemoryMb ?? '?'} / ${info.totalMemoryMb} MB` : undefined,
  }
}

/** 打成 zip: 日志 (再脱敏一次) + 系统信息。不含书籍、划线、设置和密钥 */
export async function buildDiagnosticsBundle(): Promise<{ blob: Blob; fileName: string }> {
  await flush()
  const files: Record<string, Uint8Array> = {}
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const logs = await invoke<Array<{ name: string; text: string }>>('diagnostics_read_logs')
      for (const log of logs) files[`logs/${log.name}`] = strToU8(redact(log.text))
    } catch (e) {
      logEvent('warn', 'diagnostics', 'read logs failed', e)
    }
  }
  // 内存缓冲总是带上: 原生文件读失败或网页版时, 这是唯一来源
  files['logs/session.log'] = strToU8(buffer.toArray().map(formatLine).join('\n'))
  const nav = navigator as Navigator & { deviceMemory?: number }
  const perf = performance as Performance & { memory?: { jsHeapSizeLimit: number; usedJSHeapSize: number } }
  files['system.json'] = strToU8(JSON.stringify({
    version: CURRENT_VERSION,
    platform: platformLabel(),
    native: await nativeInfo(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
    cpus: navigator.hardwareConcurrency,
    deviceMemoryGb: nav.deviceMemory,
    jsHeap: perf.memory && { limit: perf.memory.jsHeapSizeLimit, used: perf.memory.usedJSHeapSize },
    exportedAt: new Date().toISOString(),
  }, null, 2))
  const blob = new Blob([zipSync(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' })
  return { blob, fileName: bundleName(CURRENT_VERSION) }
}

/** 导出诊断包; 用户取消返回 false */
export async function exportDiagnostics(): Promise<boolean> {
  const { blob, fileName } = await buildDiagnosticsBundle()
  const { isAndroidApp, saveFileAs, shareFile } = await import('./shareOut')
  if (isAndroidApp()) return shareFile(blob, fileName, 'application/zip', fileName)
  return saveFileAs(blob, fileName, { name: 'ZIP', extensions: ['zip'] })
}

let communityFocus = false

/** 报错页 → 设置页: 请求关于页打开后定位到读者群 */
export function requestCommunityFocus() {
  communityFocus = true
}

export function consumeCommunityFocus(): boolean {
  const pending = communityFocus
  communityFocus = false
  return pending
}

export async function openFeedback() {
  const { openDownload } = await import('./updater')
  await openDownload(feedbackUrl(await diagnosticsEnv()))
}
