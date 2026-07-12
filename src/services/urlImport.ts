/**
 * URL 导入书籍: 粘贴直链下载入库。
 *  - 桌面端经 Rust HTTP (走「网络」配置的代理), Web 端直接 fetch
 *  - GitHub blob 页面链接自动转 raw 直链
 *  - 文件名与格式从 URL 路径 / Content-Disposition 推断
 */
import { fetchRemote } from './net'
import { detectFormat } from './format'
import { importFile, type ImportResult } from './importer'
import { t } from '../i18n'

/** GitHub 网页版文件链接 → raw 直链 */
export function normalizeBookUrl(raw: string): string {
  const url = raw.trim()
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`
  return url
}

/** 从 URL 路径与响应头推断文件名 */
function inferFileName(url: string, res: Response): string {
  const disposition = res.headers.get('content-disposition') ?? ''
  const dm = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  if (dm) {
    try {
      return decodeURIComponent(dm[1])
    } catch {
      return dm[1]
    }
  }
  try {
    const path = new URL(url).pathname
    const base = decodeURIComponent(path.split('/').pop() ?? '')
    if (base) return base
  } catch { /* 非法 URL 已在上游拦截 */ }
  return 'book'
}

export interface UrlImportProgress {
  /** 0-1, 无 content-length 时为 null */
  fraction: number | null
  receivedMB: string
}

export async function importFromUrl(
  rawUrl: string,
  onProgress: (p: UrlImportProgress) => void,
): Promise<ImportResult> {
  const url = normalizeBookUrl(rawUrl)
  const res = await fetchRemote(url, undefined, { headers: { accept: '*/*' } })

  const total = Number(res.headers.get('content-length') ?? 0)
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = res.body?.getReader?.()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      onProgress({
        fraction: total ? received / total : null,
        receivedMB: (received / 1048576).toFixed(1),
      })
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer())
    chunks.push(buf)
    received = buf.length
  }
  const data = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }

  const fileName = inferFileName(url, res)
  if (!detectFormat(fileName)) {
    throw new Error(t('library.urlUnsupported', { name: fileName }))
  }
  const file = new File([data as BlobPart], fileName)
  return importFile(file, t('library.urlSource'))
}
