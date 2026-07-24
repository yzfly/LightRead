import { appDataDir, join } from '@tauri-apps/api/path'
import type { BookMeta } from '../storage'
import { getLibraryRoot, isTauri } from '../storage'

function safePdfName(name: string): string {
  const trimmed = name.trim() || 'document.pdf'
  return trimmed.toLowerCase().endsWith('.pdf') ? trimmed : `${trimmed}.pdf`
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = safePdfName(fileName)
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Web 端走浏览器下载；桌面端使用系统另存为对话框。 */
export async function savePdfAs(blob: Blob, fileName: string): Promise<boolean> {
  if (!isTauri()) {
    downloadBlob(blob, fileName)
    return true
  }
  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])
  const path = await save({
    defaultPath: safePdfName(fileName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (!path) return false
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
  return true
}

/**
 * 交给浏览器/系统 PDF 插件发起打印。iframe 方式不会把阅读器工具栏带进
 * 打印内容，同时仍可使用 Chrome/Edge 原生的页码范围、单双面等打印选项。
 */
export function printPdf(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const frame = document.createElement('iframe')
    let settled = false
    const cleanup = () => {
      frame.remove()
      URL.revokeObjectURL(url)
    }
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve()
      // 打印对话框可能异步读取文档，延迟释放对象地址。
      setTimeout(cleanup, 60_000)
    }
    frame.style.position = 'fixed'
    frame.style.width = '1px'
    frame.style.height = '1px'
    frame.style.right = '0'
    frame.style.bottom = '0'
    frame.style.opacity = '0'
    frame.setAttribute('aria-hidden', 'true')
    frame.onload = () => {
      try {
        frame.contentWindow?.focus()
        frame.contentWindow?.print()
        finish()
      } catch (error) {
        finish(error)
      }
    }
    frame.onerror = () => finish(new Error('PDF print frame failed to load'))
    frame.src = url
    document.body.append(frame)
  })
}

function storedExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith('.fb2.zip')
    ? 'fb2.zip'
    : fileName.split('.').pop() || 'bin'
}

/** 桌面端在 Finder / Explorer / 文件管理器中定位应用实际保存的 PDF。 */
export async function revealStoredBook(meta: BookMeta): Promise<void> {
  if (!isTauri()) throw new Error('desktop only')
  const [{ revealItemInDir }, root] = await Promise.all([
    import('@tauri-apps/plugin-opener'),
    Promise.resolve(getLibraryRoot()),
  ])
  const base = root || await appDataDir()
  const path = await join(base, 'books', `${meta.id}.${storedExtension(meta.fileName)}`)
  await revealItemInDir(path)
}
