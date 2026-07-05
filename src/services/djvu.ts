/** DjVu 支持: 基于 DjVu.js (https://djvu.js.org), 页面解码为 ImageData */

let DjVuLib: any = null

async function getDjVu() {
  if (!DjVuLib) {
    DjVuLib = (await import('../vendor/djvu.js')).default
  }
  return DjVuLib
}

export interface DjvuDoc {
  pageCount: number
  /** 1-based; 返回解码后的 ImageData 与 DPI */
  renderPage(num: number): Promise<{ imageData: ImageData; dpi: number }>
}

export async function openDjvu(blob: Blob): Promise<DjvuDoc> {
  const DjVu = await getDjVu()
  const doc = new DjVu.Document(await blob.arrayBuffer())
  const pageCount: number = doc.getPagesQuantity()
  return {
    pageCount,
    async renderPage(num: number) {
      const page = await doc.getPage(num)
      const imageData: ImageData = page.getImageData()
      const dpi: number = page.getDpi?.() ?? 300
      return { imageData, dpi }
    },
  }
}

/** 封面: 首页缩略 JPEG */
export async function djvuCover(blob: Blob): Promise<Blob | undefined> {
  try {
    const doc = await openDjvu(blob)
    const { imageData } = await doc.renderPage(1)
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 480 / imageData.height)
    canvas.width = Math.round(imageData.width * scale)
    canvas.height = Math.round(imageData.height * scale)
    const full = document.createElement('canvas')
    full.width = imageData.width
    full.height = imageData.height
    full.getContext('2d')!.putImageData(imageData, 0, 0)
    canvas.getContext('2d')!.drawImage(full, 0, 0, canvas.width, canvas.height)
    return await new Promise(resolve =>
      canvas.toBlob(b => resolve(b ?? undefined), 'image/jpeg', 0.8))
  } catch {
    return undefined
  }
}
