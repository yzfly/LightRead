/**
 * PDFium 阅读引擎 (Chrome 同款渲染引擎的 WASM 版):
 *  - 页面位图渲染 (画质与 Chrome 一致)
 *  - 字符级几何文本模型: 行切分 / 坐标命中 / 选区矩形 / 双击取词
 *    —— 原生阅读器选择手感的来源: 选区不走 DOM, 全部按引擎给的字符坐标计算
 *  - 链接热区与内嵌目录
 *
 * pdf.js 仍负责翻译版式对照与 AI 文本提取; 本引擎初始化失败时阅读器整体回退 pdf.js。
 * 坐标约定: 除注明外均为 PDF 点 (page point), 左上原点。
 */
import { init, type WrappedPdfiumModule } from '@embedpdf/pdfium'
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url'
import { isMathChar, type TextItem } from './paperText'

let modPromise: Promise<WrappedPdfiumModule> | null = null

function pdfiumModule(): Promise<WrappedPdfiumModule> {
  if (!modPromise) {
    modPromise = (async () => {
      const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer()
      const mod = await init({ wasmBinary } as any)
      mod.PDFiumExt_Init()
      return mod
    })()
  }
  return modPromise
}

export interface PdmPage {
  w: number
  h: number
}

export interface TextLine {
  /** 字符区间 (含端点, 按内容序) */
  start: number
  end: number
  top: number
  bottom: number
  minX: number
  maxX: number
}

/** 字符级文本模型 */
export interface TextModel {
  count: number
  /** 每字符 Unicode 码点 */
  codes: Uint32Array
  /** 每字符盒 [x, y, w, h] × n */
  boxes: Float32Array
  /** 每字符字号 (PDF 单位) */
  sizes: Float32Array
  lines: TextLine[]
}

export interface PdmLink {
  x: number
  y: number
  w: number
  h: number
  url?: string
  destPage?: number
  /** 目标页内纵向偏移 (左上原点) */
  destY?: number
}

export interface PdmOutline {
  title: string
  page?: number
  y?: number
  children: PdmOutline[]
}

export interface SelRect {
  x: number
  y: number
  w: number
  h: number
}

const isNewline = (code: number) => code === 10 || code === 13

export class PdfiumDoc {
  pages: PdmPage[] = []
  private m: WrappedPdfiumModule
  private doc = 0
  private filePtr = 0
  private textCache = new Map<number, TextModel>()

  private constructor(m: WrappedPdfiumModule) {
    this.m = m
  }

  private get rt() {
    return this.m.pdfium as any
  }

  static async open(data: ArrayBuffer): Promise<PdfiumDoc> {
    const m = await pdfiumModule()
    const d = new PdfiumDoc(m)
    const bytes = new Uint8Array(data)
    // PDFium 要求文档存续期间源缓冲有效, filePtr 在 close 时才释放
    d.filePtr = m.pdfium.wasmExports.malloc(bytes.length)
    ;(m.pdfium as any).HEAPU8.set(bytes, d.filePtr)
    d.doc = m.FPDF_LoadMemDocument(d.filePtr, bytes.length, '')
    if (!d.doc) {
      m.pdfium.wasmExports.free(d.filePtr)
      throw new Error(`PDFium load failed (${m.FPDF_GetLastError?.() ?? 'unknown'})`)
    }
    const n = m.FPDF_GetPageCount(d.doc)
    for (let i = 0; i < n; i++) {
      const page = m.FPDF_LoadPage(d.doc, i)
      d.pages.push({ w: m.FPDF_GetPageWidthF(page), h: m.FPDF_GetPageHeightF(page) })
      m.FPDF_ClosePage(page)
    }
    return d
  }

  close() {
    if (this.doc) this.m.FPDF_CloseDocument(this.doc)
    if (this.filePtr) this.m.pdfium.wasmExports.free(this.filePtr)
    this.doc = 0
    this.filePtr = 0
    this.textCache.clear()
  }

  /** 渲染整页位图, scale = 输出像素 / PDF 点 */
  render(pageIdx: number, scale: number): ImageData {
    const m = this.m
    const pg = this.pages[pageIdx]
    const w = Math.max(1, Math.floor(pg.w * scale))
    const h = Math.max(1, Math.floor(pg.h * scale))
    const page = m.FPDF_LoadPage(this.doc, pageIdx)
    const bmp = m.FPDFBitmap_CreateEx(w, h, 4 /* BGRA */, 0, 0)
    m.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff)
    m.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 0x01 /* FPDF_ANNOT */)
    const buf = m.FPDFBitmap_GetBuffer(bmp)
    const stride = m.FPDFBitmap_GetStride(bmp)
    const out = new Uint8ClampedArray(w * h * 4)
    const out32 = new Uint32Array(out.buffer)
    // BGRA → RGBA (按 32 位字交换 R/B 通道)
    const heapBuf: ArrayBuffer = this.rt.HEAPU8.buffer
    for (let row = 0; row < h; row++) {
      const src32 = new Uint32Array(heapBuf, buf + row * stride, w)
      const dst = row * w
      for (let col = 0; col < w; col++) {
        const v = src32[col]
        out32[dst + col] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff)
      }
    }
    m.FPDFBitmap_Destroy(bmp)
    m.FPDF_ClosePage(page)
    return new ImageData(out, w, h)
  }

  /** 字符级文本模型 (按页缓存) */
  text(pageIdx: number): TextModel {
    const cached = this.textCache.get(pageIdx)
    if (cached) return cached
    const m = this.m
    const pg = this.pages[pageIdx]
    const page = m.FPDF_LoadPage(this.doc, pageIdx)
    const tp = m.FPDFText_LoadPage(page)
    const count = Math.max(0, m.FPDFText_CountChars(tp))
    const codes = new Uint32Array(count)
    const boxes = new Float32Array(count * 4)
    const sizes = new Float32Array(count)
    const dbl = m.pdfium.wasmExports.malloc(32)
    for (let i = 0; i < count; i++) {
      codes[i] = m.FPDFText_GetUnicode(tp, i)
      sizes[i] = m.FPDFText_GetFontSize(tp, i)
      if (m.FPDFText_GetCharBox(tp, i, dbl, dbl + 8, dbl + 16, dbl + 24)) {
        const left = this.rt.getValue(dbl, 'double')
        const right = this.rt.getValue(dbl + 8, 'double')
        const bottom = this.rt.getValue(dbl + 16, 'double')
        const top = this.rt.getValue(dbl + 24, 'double')
        boxes[i * 4] = left
        boxes[i * 4 + 1] = pg.h - top
        boxes[i * 4 + 2] = Math.max(0, right - left)
        boxes[i * 4 + 3] = Math.max(0, top - bottom)
      }
    }
    m.pdfium.wasmExports.free(dbl)
    m.FPDFText_ClosePage(tp)
    m.FPDF_ClosePage(page)
    const model: TextModel = { count, codes, boxes, sizes, lines: buildLines(codes, boxes) }
    this.textCache.set(pageIdx, model)
    return model
  }

  /** 文档元数据 (Title / Author 等) */
  meta(tag: string): string {
    const m = this.m
    const len = m.FPDF_GetMetaText(this.doc, tag, 0, 0)
    if (len <= 2) return ''
    const buf = m.pdfium.wasmExports.malloc(len)
    m.FPDF_GetMetaText(this.doc, tag, buf, len)
    const s = this.rt.UTF16ToString(buf)
    m.pdfium.wasmExports.free(buf)
    return s.trim()
  }

  /** 整页纯文本 (供 AI 上下文等) */
  pageText(pageIdx: number): string {
    const t = this.text(pageIdx)
    return rangeText(t, 0, t.count)
  }

  /** 链接热区: 内链带目标页/页内偏移, 外链带 URL */
  links(pageIdx: number): PdmLink[] {
    const m = this.m
    const rt = this.rt
    const page = m.FPDF_LoadPage(this.doc, pageIdx)
    const out: PdmLink[] = []
    const startPtr = m.pdfium.wasmExports.malloc(4)
    const linkPtr = m.pdfium.wasmExports.malloc(4)
    const rectPtr = m.pdfium.wasmExports.malloc(16)
    rt.setValue(startPtr, 0, 'i32')
    const pgH = this.pages[pageIdx].h
    while (m.FPDFLink_Enumerate(page, startPtr, linkPtr)) {
      const link = rt.getValue(linkPtr, 'i32')
      if (!link) break
      if (!m.FPDFLink_GetAnnotRect(link, rectPtr)) continue
      const left = rt.getValue(rectPtr, 'float')
      const top = rt.getValue(rectPtr + 4, 'float')
      const right = rt.getValue(rectPtr + 8, 'float')
      const bottom = rt.getValue(rectPtr + 12, 'float')
      const item: PdmLink = {
        x: Math.min(left, right),
        y: pgH - Math.max(top, bottom),
        w: Math.abs(right - left),
        h: Math.abs(top - bottom),
      }
      let dest = m.FPDFLink_GetDest(this.doc, link)
      if (!dest) {
        const action = m.FPDFLink_GetAction(link)
        if (action) {
          const type = m.FPDFAction_GetType(action)
          if (type === 1 /* GOTO */) {
            dest = m.FPDFAction_GetDest(this.doc, action)
          } else if (type === 3 /* URI */) {
            const len = m.FPDFAction_GetURIPath(this.doc, action, 0, 0)
            if (len > 0) {
              const buf = m.pdfium.wasmExports.malloc(len)
              m.FPDFAction_GetURIPath(this.doc, action, buf, len)
              item.url = rt.UTF8ToString(buf)
              m.pdfium.wasmExports.free(buf)
            }
          }
        }
      }
      if (dest) {
        const destIdx = m.FPDFDest_GetDestPageIndex(this.doc, dest)
        if (destIdx >= 0) {
          item.destPage = destIdx
          item.destY = this.destY(dest, destIdx)
        }
      }
      if (item.url || item.destPage != null) out.push(item)
    }
    m.pdfium.wasmExports.free(startPtr)
    m.pdfium.wasmExports.free(linkPtr)
    m.pdfium.wasmExports.free(rectPtr)
    m.FPDF_ClosePage(page)
    return out
  }

  private destY(dest: number, destPageIdx: number): number | undefined {
    const m = this.m
    const rt = this.rt
    const p = m.pdfium.wasmExports.malloc(4 * 3 + 4 * 3)
    const hasX = p
    const hasY = p + 4
    const hasZoom = p + 8
    const px = p + 12
    const py = p + 16
    const pz = p + 20
    let y: number | undefined
    if (m.FPDFDest_GetLocationInPage(dest, hasX, hasY, hasZoom, px, py, pz)) {
      if (rt.getValue(hasY, 'i32')) {
        const rawY = rt.getValue(py, 'float')
        const pgH = this.pages[destPageIdx]?.h ?? 0
        y = Math.max(0, pgH - rawY)
      }
    }
    m.pdfium.wasmExports.free(p)
    return y
  }

  /** 内嵌目录树 */
  outline(): PdmOutline[] {
    const walk = (parent: number): PdmOutline[] => {
      const m = this.m
      const out: PdmOutline[] = []
      let bm = m.FPDFBookmark_GetFirstChild(this.doc, parent)
      let guard = 0
      while (bm && guard++ < 1024) {
        const node: PdmOutline = { title: this.bookmarkTitle(bm), children: walk(bm) }
        let dest = m.FPDFBookmark_GetDest(this.doc, bm)
        if (!dest) {
          const action = m.FPDFBookmark_GetAction(bm)
          if (action && m.FPDFAction_GetType(action) === 1) dest = m.FPDFAction_GetDest(this.doc, action)
        }
        if (dest) {
          const idx = m.FPDFDest_GetDestPageIndex(this.doc, dest)
          if (idx >= 0) {
            node.page = idx
            node.y = this.destY(dest, idx)
          }
        }
        out.push(node)
        bm = m.FPDFBookmark_GetNextSibling(this.doc, bm)
      }
      return out
    }
    return walk(0)
  }

  private bookmarkTitle(bm: number): string {
    const m = this.m
    const len = m.FPDFBookmark_GetTitle(bm, 0, 0)
    if (len <= 2) return ''
    const buf = m.pdfium.wasmExports.malloc(len)
    m.FPDFBookmark_GetTitle(bm, buf, len)
    const s = this.rt.UTF16ToString(buf)
    m.pdfium.wasmExports.free(buf)
    return s
  }
}

/* ================= 几何文本模型: 行切分 / 命中 / 选区 ================= */

/**
 * 按内容序切行: 遇换行符断行, 否则要求与当前行竖向带重叠。
 * (论文双栏的内容序通常按栏走, 与阅读序一致)
 */
function buildLines(codes: Uint32Array, boxes: Float32Array): TextLine[] {
  const lines: TextLine[] = []
  let cur: TextLine | null = null
  for (let i = 0; i < codes.length; i++) {
    if (isNewline(codes[i])) {
      if (cur) cur.end = i
      cur = null
      continue
    }
    const y = boxes[i * 4 + 1]
    const h = boxes[i * 4 + 3]
    const x = boxes[i * 4]
    const w = boxes[i * 4 + 2]
    if (w <= 0 || h <= 0) {
      // 生成的空白字符没有几何, 归入当前行
      if (cur) cur.end = i
      continue
    }
    const overlap =
      cur && Math.min(cur.bottom, y + h) - Math.max(cur.top, y) > Math.min(h, cur.bottom - cur.top) * 0.45
    if (cur && overlap) {
      cur.end = i
      cur.top = Math.min(cur.top, y)
      cur.bottom = Math.max(cur.bottom, y + h)
      cur.minX = Math.min(cur.minX, x)
      cur.maxX = Math.max(cur.maxX, x + w)
    } else {
      cur = { start: i, end: i, top: y, bottom: y + h, minX: x, maxX: x + w }
      lines.push(cur)
    }
  }
  return lines
}

/**
 * 坐标 → 光标边界 (0..count; 边界 i 表示"第 i 个字符之前")。
 * 命中不到任何行时返回 -1。竖向带内多列时取横向最近的行。
 */
export function hitBoundary(model: TextModel, x: number, y: number): number {
  if (!model.lines.length) return -1
  let best: TextLine | null = null
  let bestCost = Infinity
  for (const ln of model.lines) {
    const vPad = Math.min(6, (ln.bottom - ln.top) * 0.6)
    const vDist = y < ln.top - vPad ? ln.top - vPad - y : y > ln.bottom + vPad ? y - ln.bottom - vPad : 0
    if (vDist > 14) continue
    const hDist = x < ln.minX ? ln.minX - x : x > ln.maxX ? x - ln.maxX : 0
    const cost = vDist * 4 + hDist
    if (cost < bestCost) {
      bestCost = cost
      best = ln
    }
  }
  if (!best) return -1
  // 行内按字符中线定边界
  for (let i = best.start; i <= best.end; i++) {
    const w = model.boxes[i * 4 + 2]
    if (w <= 0) continue
    const bx = model.boxes[i * 4]
    if (x < bx + w / 2) return i
  }
  return lastVisible(model, best) + 1
}

function lastVisible(model: TextModel, ln: TextLine): number {
  for (let i = ln.end; i >= ln.start; i--) {
    if (model.boxes[i * 4 + 2] > 0) return i
  }
  return ln.start
}

/** 选区 [a, b) → 按行合并的矩形 */
export function rangeRects(model: TextModel, a: number, b: number): SelRect[] {
  const out: SelRect[] = []
  for (const ln of model.lines) {
    if (ln.end < a || ln.start >= b) continue
    let x0 = Infinity
    let x1 = -Infinity
    for (let i = Math.max(ln.start, a); i <= Math.min(ln.end, b - 1); i++) {
      const w = model.boxes[i * 4 + 2]
      if (w <= 0) continue
      x0 = Math.min(x0, model.boxes[i * 4])
      x1 = Math.max(x1, model.boxes[i * 4] + w)
    }
    if (x1 > x0) out.push({ x: x0, y: ln.top, w: x1 - x0, h: ln.bottom - ln.top })
  }
  return out
}

/** 选区 [a, b) 文本 (压缩生成的 \r) */
export function rangeText(model: TextModel, a: number, b: number): string {
  let s = ''
  for (let i = Math.max(0, a); i < Math.min(model.count, b); i++) {
    const c = model.codes[i]
    if (c === 13) continue
    s += c === 10 ? '\n' : String.fromCodePoint(c)
  }
  return s
}

const isWordCode = (c: number) =>
  (c >= 48 && c <= 57) ||
  (c >= 65 && c <= 90) ||
  (c >= 97 && c <= 122) ||
  c === 95 ||
  c === 45 ||
  c > 0x2e00 // CJK 等宽字符双击按单字扩展亦可接受

/**
 * 字符流 → 文本项 runs (供段落提取管线, 对齐 pdf.js textContent item 语义):
 * 按行遍历, 行内在字号突变 / 数学字符边界 / 大间距处断 run。
 * 坐标: x 左缘, y 盒底 (转为 PDF 左下原点), h 用字号。
 */
export function textRuns(model: TextModel, pageH: number): TextItem[] {
  const out: TextItem[] = []
  for (const ln of model.lines) {
    let cur: (TextItem & { math: boolean; endX: number }) | null = null
    const push = () => {
      if (cur && cur.str.trim()) out.push({ x: cur.x, y: cur.y, w: cur.w, h: cur.h, str: cur.str })
      cur = null
    }
    for (let i = ln.start; i <= ln.end; i++) {
      const code = model.codes[i]
      if (isNewline(code)) continue
      const ch = String.fromCodePoint(code)
      const bx = model.boxes[i * 4]
      const by = model.boxes[i * 4 + 1]
      const bw = model.boxes[i * 4 + 2]
      const bh = model.boxes[i * 4 + 3]
      const isSpace = /\s/.test(ch)
      if (bw <= 0 && bh <= 0) {
        // 生成的空白字符: 归入当前 run, 不改几何
        if (cur) cur.str += ' '
        continue
      }
      const size = model.sizes[i] > 0 ? model.sizes[i] : bh || 10
      const math = isMathChar(ch)
      const needBreak =
        !cur ||
        bx - cur.endX > size * 0.5 ||
        (!isSpace && Math.abs(size - cur.h) > 0.6) ||
        (!isSpace && math !== cur.math)
      if (needBreak) {
        push()
        cur = { x: bx, y: pageH - (by + bh), w: 0, h: size, str: '', math, endX: bx }
      }
      cur!.str += ch
      cur!.endX = Math.max(cur!.endX, bx + bw)
      cur!.w = cur!.endX - cur!.x
      cur!.y = Math.min(cur!.y, pageH - (by + bh))
    }
    push()
  }
  return out
}

/** 双击取词: 边界处向两侧扩展 */
export function wordRange(model: TextModel, boundary: number): [number, number] | null {
  let i = Math.min(Math.max(boundary, 0), model.count - 1)
  if (!isWordCode(model.codes[i]) && i > 0 && isWordCode(model.codes[i - 1])) i--
  if (!isWordCode(model.codes[i])) return null
  let a = i
  let b = i + 1
  while (a > 0 && isWordCode(model.codes[a - 1])) a--
  while (b < model.count && isWordCode(model.codes[b])) b++
  return [a, b]
}
