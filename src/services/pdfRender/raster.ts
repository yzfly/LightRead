/**
 * MuPDF 整页栅格化 (Worker 与主线程回退共用): 输出不透明白底 RGBA, 尺寸恰为 targetW × targetH。
 * 返回的像素是 wasm 堆上的视图, 调用方必须在 release() 之前用完或拷走。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface RasterRequest {
  /** 0 起的页序号 */
  page: number
  /** 目标位图尺寸 (设备像素) */
  targetW: number
  targetH: number
  /** 页面尺寸 (pt), 与 PDFium 给出的一致 */
  pageW: number
  pageH: number
}

export interface RasterView {
  pixels: Uint8ClampedArray
  width: number
  height: number
  release: () => void
}

export function rasterPage(mupdf: any, doc: any, req: RasterRequest): RasterView {
  let page: any = null
  let pixmap: any = null
  let device: any = null
  const release = () => {
    // MuPDF 崩溃后释放也可能再次 trap; 这里抛错会盖掉调用方的回退路径
    for (const item of [device, pixmap, page]) {
      try {
        item?.destroy?.()
      } catch { /* 实例已不可用, 不再使用 */ }
    }
    device = pixmap = page = null
  }
  try {
    page = doc.loadPage(req.page)
    // 用两个方向的精确目标比例，确保位图与 CSS×DPR 一一对应；页面原点非零时
    // 先平移到 (0,0)，位图 bbox 固定为目标尺寸，多出的亚像素直接被裁掉。
    const bounds: number[] = page.getBounds()
    const ctm = mupdf.Matrix.concat(
      mupdf.Matrix.translate(-bounds[0], -bounds[1]),
      mupdf.Matrix.scale(req.targetW / req.pageW, req.targetH / req.pageH),
    )
    // 直接栅格化成 RGBA, 像素可直接喂给 ImageData, 省掉逐字节 RGB→RGBA 的 JS 循环
    pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, req.targetW, req.targetH], true)
    pixmap.clear(255)
    device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
    page.run(device, ctm)
    device.close()
    const stride: number = pixmap.getStride()
    const width: number = pixmap.getWidth()
    const height: number = pixmap.getHeight()
    if (stride !== width * 4) throw new Error(`unexpected pixmap stride ${stride} for width ${width}`)
    return { pixels: pixmap.getPixels() as Uint8ClampedArray, width, height, release }
  } catch (e) {
    release()
    throw e
  }
}
