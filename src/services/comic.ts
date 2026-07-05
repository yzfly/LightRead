/** CBR (RAR 漫画包) → CBZ 转换: unrar wasm 解包图片, fflate 重打包 zip */
import { zipSync } from 'fflate'

const IMAGE_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i

let wasmBinary: ArrayBuffer | null = null

export async function cbrToCbz(blob: Blob): Promise<Blob> {
  const { createExtractorFromData } = await import('node-unrar-js/esm')
  if (!wasmBinary) {
    const wasmUrl = (await import('node-unrar-js/esm/js/unrar.wasm?url')).default
    wasmBinary = await (await fetch(wasmUrl)).arrayBuffer()
  }
  const extractor = await createExtractorFromData({
    data: await blob.arrayBuffer(),
    wasmBinary,
  })
  const { files } = extractor.extract()

  const entries: Record<string, [Uint8Array, { level: 0 }]> = {}
  let count = 0
  for (const file of files) {
    if (file.fileHeader.flags.directory || !file.extraction) continue
    if (!IMAGE_RE.test(file.fileHeader.name)) continue
    // 压缩包内路径拍平避免特殊字符问题, 保留原名以维持阅读顺序
    const name = file.fileHeader.name.replace(/\\/g, '/')
    entries[name] = [file.extraction, { level: 0 }]
    count++
  }
  if (!count) throw new Error('RAR 包中没有找到图片 (或文件已加密)')
  const zipped = zipSync(entries)
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/vnd.comicbook+zip' })
}
