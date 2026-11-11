/**
 * PDF 页面渲染 Worker: 打开一次 PDF, 之后按页栅格化, 把位图交回主线程。
 * 消息: load(bytes) → render(req)* → close; 每条带 id, 回复同 id。
 * 一个 Worker 一份 MuPDF 实例: 崩溃 (wasm trap) 后整个 Worker 由主线程结束, 不会污染下一本书。
 */
import { rasterPage, type RasterRequest } from './raster.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
let mupdf: any = null
let doc: any = null

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer)

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data ?? {}
  const { id, type } = msg
  try {
    if (type === 'load') {
      mupdf ??= (await import('mupdf')).default
      doc?.destroy?.()
      doc = mupdf.Document.openDocument(new Uint8Array(msg.bytes as ArrayBuffer), 'application/pdf')
      post({ id, type: 'ok' })
    } else if (type === 'render') {
      if (!doc) throw new Error('pdf not loaded')
      const view = rasterPage(mupdf, doc, msg.req as RasterRequest)
      try {
        const { width, height } = view
        // 拷出 wasm 堆 (视图在 release 后失效); ImageBitmap 可零拷贝转移, 主线程一次 drawImage 上屏
        const pixels = new Uint8ClampedArray(view.pixels)
        if (typeof createImageBitmap === 'function') {
          try {
            const bitmap = await createImageBitmap(new ImageData(pixels, width, height))
            post({ id, type: 'ok', bitmap, width, height }, [bitmap])
            return
          } catch { /* 旧 WebView 的 Worker 里没有 ImageData / createImageBitmap: 退回原始像素 */ }
        }
        post({ id, type: 'ok', pixels: pixels.buffer, width, height }, [pixels.buffer])
      } finally {
        view.release()
      }
    } else if (type === 'close') {
      try {
        doc?.destroy?.()
      } catch { /* 崩溃后的实例 */ }
      doc = null
      post({ id, type: 'ok' })
    }
  } catch (err: any) {
    post({ id, type: 'error', message: String(err?.message ?? err) })
  }
}
