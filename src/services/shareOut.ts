/**
 * 把书摘交出应用: 存文件、存相册、系统分享、复制图片. 各平台的差异集中在这里:
 *  - Android App: window.LightReadShare (src-tauri/android/MainActivity.kt) 存相册 / 拉起系统分享;
 *    Android 9 及以下存相册退回系统「另存为」
 *  - iOS App: 原生壳 (services/iosShell.ts) 存相册 / 系统分享面板, 接口与 Android 桥相同
 *  - 桌面: 系统另存为对话框; 复制图片走剪贴板
 *  - 网页: 浏览器下载; 支持时用 Web Share
 */
import { isTauri } from '../storage/types'
import { iosShell, isIosApp } from './iosShell'

/** 结果: ok / cancelled (仅 iOS, 用户关掉分享面板) / unsupported / denied / error; Android 同步返回, iOS 异步 */
interface NativeShareBridge {
  saveImage(base64: string, name: string): string | Promise<string>
  shareFile(base64: string, name: string, mime: string, title: string): string | Promise<string>
  shareText(text: string, subject: string, title: string): string | Promise<string>
}

const iosResult = (r: { result?: string }) => r.result ?? 'error'
const iosBridge: NativeShareBridge = {
  saveImage: async base64 => iosResult(await iosShell('saveImage', { base64 })),
  shareFile: async (base64, name) => iosResult(await iosShell('shareFile', { base64, name })),
  shareText: async text => iosResult(await iosShell('shareText', { text })),
}

function bridge(): NativeShareBridge | null {
  if (isIosApp()) return iosBridge
  return (globalThis as { LightReadShare?: NativeShareBridge }).LightReadShare ?? null
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function browserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.hidden = true
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 另存为; 用户取消返回 false */
export async function saveFileAs(blob: Blob, fileName: string, filter: { name: string; extensions: string[] }): Promise<boolean> {
  if (!isTauri()) {
    browserDownload(blob, fileName)
    return true
  }
  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const path = await save({ defaultPath: fileName, filters: [filter] })
  if (!path) return false
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
  return true
}

export type SaveImageResult = 'gallery' | 'file' | 'cancelled'

/** 存图片: Android / iOS 进相册, 其余平台另存为 */
export async function saveImage(blob: Blob, fileName: string): Promise<SaveImageResult> {
  const b = bridge()
  if (b) {
    const r = await b.saveImage(await blobToBase64(blob), fileName)
    if (r === 'ok') return 'gallery'
    if (r !== 'unsupported') throw new Error('save image failed')
  }
  return (await saveFileAs(blob, fileName, { name: 'PNG', extensions: ['png'] })) ? 'file' : 'cancelled'
}

/** 能否拉起系统分享面板 */
export function canShareFiles(): boolean {
  if (bridge()) return true
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  try {
    return !!nav.share && !!nav.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] })
  } catch {
    return false
  }
}

export function canShareText(): boolean {
  return !!bridge() || !!navigator.share
}

/** 分享文件 (卡片图片 / 导出的笔记文件); 返回 false 表示用户取消 */
export async function shareFile(blob: Blob, fileName: string, mime: string, title: string): Promise<boolean> {
  const b = bridge()
  if (b) {
    const r = await b.shareFile(await blobToBase64(blob), fileName, mime, title)
    if (r === 'cancelled') return false
    if (r !== 'ok') throw new Error('share failed')
    return true
  }
  try {
    await navigator.share({ files: [new File([blob], fileName, { type: mime })], title })
    return true
  } catch (e: any) {
    if (e?.name === 'AbortError') return false
    throw e
  }
}

export async function shareText(text: string, subject: string, title: string): Promise<boolean> {
  const b = bridge()
  if (b) {
    const r = await b.shareText(text, subject, title)
    if (r === 'cancelled') return false
    if (r !== 'ok') throw new Error('share failed')
    return true
  }
  try {
    await navigator.share({ text, title: subject })
    return true
  } catch (e: any) {
    if (e?.name === 'AbortError') return false
    throw e
  }
}

/** 复制图片到剪贴板 (桌面 / 网页); 不支持时抛错, 由调用方提示改用保存 */
export async function copyImage(blob: Blob): Promise<void> {
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
  if (!Item || !navigator.clipboard?.write) throw new Error('clipboard image unsupported')
  await navigator.clipboard.write([new Item({ 'image/png': blob })])
}

/** 复制文本; Android WebView 偶有 clipboard API 不可用, 退回 execCommand */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch (e) {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    if (!ok) throw e
  }
}

/** 有原生分享桥 (存相册 / 系统分享面板) 的 App: Android 与 iOS */
export function isAndroidApp(): boolean {
  return !!bridge()
}
