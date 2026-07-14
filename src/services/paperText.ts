/**
 * 论文 PDF 段落提取: 基于 pdf.js 文本项坐标聚类。
 *  - 双栏版式识别 (学术论文常见): 左列 / 右列 / 跨栏块
 *  - 行聚类 → 段落切分 (行距突变 / 首行缩进), 连字符断词还原
 *  - 段落包围盒与主字号 (供版式对照原位铺回)
 *  - 公式占位符保护: 数学符号串 / 上下标替换为 {vN}, 译后原样还原
 *  - 过滤页眉页脚页码等噪声
 */

export interface PaperParagraph {
  /** 页内序号 (阅读顺序) */
  id: number
  /** 翻译输入文本 (公式等已替换为 {vN} 占位符) */
  text: string
  /** 占位符 → 原文片段 */
  placeholders?: Record<string, string>
  /** PDF 坐标系包围盒 (原点左下, y 为底边) */
  bbox?: { x: number; y: number; w: number; h: number }
  /** 主字号 (PDF 单位) */
  fontSize?: number
}

interface Seg {
  str: string
  h: number
  math: boolean
}

interface TextItem {
  x: number
  y: number
  w: number
  h: number
  str: string
}

interface Line {
  y: number
  h: number
  x: number
  endX: number
  segs: Seg[]
}

/** 数学符号 (希腊字母 / 运算符 / 集合关系符 …) */
const MATH_RE =
  /[∑∏∫∮∂∇√∞≈≃≅≠≡≤≥≪≫±∓×÷∘·∈∉⊂⊆⊃⊇∪∩∧∨¬⊕⊗⊥∥→←↔⇒⇐⇔↦∝∀∃∄∅ℓℏℝℤℕℚℂ𝔼αβγδεϵζηθϑικλμνξπϖρϱσςτυφϕχψωΓΔΘΛΞΠΣΥΦΨΩ]/

/** 数学符号密度足够高的短片段视为公式 */
function isMathStr(str: string) {
  const solid = str.replace(/\s/g, '')
  if (!solid) return false
  const hits = (str.match(new RegExp(MATH_RE.source, 'g')) ?? []).length
  return hits / solid.length >= 0.25 && solid.length <= 48
}

/** 文本项 → 行 (同列内按 y 聚类), 保留分段供公式检测 */
function buildLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Line[] = []
  for (const item of sorted) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - item.y) < Math.max(2.5, item.h * 0.5)) {
      // 同一行: 依据水平间距决定是否补空格
      const gap = item.x - last.endX
      last.segs.push({ str: (gap > item.h * 0.15 ? ' ' : '') + item.str, h: item.h, math: isMathStr(item.str) })
      last.endX = Math.max(last.endX, item.x + item.w)
      last.h = Math.max(last.h, item.h)
    } else {
      lines.push({
        y: item.y,
        h: item.h,
        x: item.x,
        endX: item.x + item.w,
        segs: [{ str: item.str, h: item.h, math: isMathStr(item.str) }],
      })
    }
  }
  // 行内字号明显偏小的短片段 (上下标) 也归入公式保护
  for (const line of lines) {
    const heights = line.segs.map(s => s.h).sort((a, b) => a - b)
    const median = heights[Math.floor(heights.length / 2)] || line.h
    for (const seg of line.segs) {
      if (!seg.math && seg.h < median * 0.72 && seg.str.trim().length <= 6 && seg.str.trim()) seg.math = true
    }
  }
  return lines
}

interface Assembled {
  text: string
  placeholders: Record<string, string>
  bbox: { x: number; y: number; w: number; h: number }
  fontSize: number
}

/** 一组行 → 段落文本 + 占位符 + 包围盒 */
function assemble(paraLines: Line[]): Assembled {
  let out = ''
  let pendingMath = ''
  let n = 0
  const placeholders: Record<string, string> = {}
  const flushMath = () => {
    const frag = pendingMath.trim()
    pendingMath = ''
    if (!frag) return
    n++
    placeholders[`v${n}`] = frag
    out += (out && !/[\s(]$/.test(out) ? ' ' : '') + `{v${n}}` + ' '
  }
  for (const line of paraLines) {
    for (const seg of line.segs) {
      if (seg.math) pendingMath += seg.str
      else {
        flushMath()
        out += seg.str
      }
    }
    flushMath()
    // 换行拼接: 连字符断词还原, 否则补空格
    if (out.endsWith('-')) out = out.slice(0, -1)
    else out += ' '
  }
  flushMath()

  const x = Math.min(...paraLines.map(l => l.x))
  const endX = Math.max(...paraLines.map(l => l.endX))
  const top = Math.max(...paraLines.map(l => l.y + l.h))
  const bottom = Math.min(...paraLines.map(l => l.y - l.h * 0.28))
  const heights = paraLines.map(l => l.h).sort((a, b) => a - b)
  return {
    text: out.replace(/\s+/g, ' ').trim(),
    placeholders,
    bbox: { x, y: bottom, w: endX - x, h: top - bottom },
    fontSize: heights[Math.floor(heights.length / 2)] || 10,
  }
}

/** 行 → 段落组: 行距突变或明显缩进开新段 */
function splitParagraphs(lines: Line[]): Line[][] {
  if (!lines.length) return []
  const leftEdge = Math.min(...lines.map(l => l.x))
  const groups: Line[][] = []
  let current: Line[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prev = lines[i - 1]
    if (prev) {
      const gap = prev.y - line.y
      const lineH = Math.max(prev.h, line.h, 8)
      const indented = line.x - leftEdge > lineH * 0.8 && prev.x - leftEdge < lineH * 0.4
      if (gap > lineH * 1.55 || indented) {
        if (current.length) groups.push(current)
        current = []
      }
    }
    current.push(line)
  }
  if (current.length) groups.push(current)
  return groups
}

/** 是否为噪声块 (页码 / 短杂项) */
const isNoise = (text: string) =>
  text.length < 3 || /^\d{1,4}$/.test(text) || /^(arxiv:|preprint|under review)/i.test(text.slice(0, 24))

/** 占位符还原: 把 {vN} 换回原文片段 (容忍模型输出的空格变体) */
export function restorePlaceholders(text: string, placeholders?: Record<string, string>) {
  if (!placeholders || !text) return text
  return text.replace(/\{\s*v\s*(\d+)\s*\}/gi, (m, d) => placeholders[`v${d}`] ?? m)
}

/**
 * 提取一页的段落 (阅读顺序)。
 * page: pdf.js PDFPageProxy
 */
export async function extractParagraphs(page: any): Promise<PaperParagraph[]> {
  const content = await page.getTextContent()
  const viewport = page.getViewport({ scale: 1 })
  const W = viewport.width

  const items: TextItem[] = (content.items as any[])
    .filter(i => i.str && i.str.trim())
    .map(i => ({
      x: i.transform[4],
      y: i.transform[5],
      w: i.width ?? 0,
      h: Math.abs(i.transform[3]) || i.height || 10,
      str: i.str as string,
    }))
  if (!items.length) return []

  // 三路分流: 左列 / 右列 / 跨栏
  const left: TextItem[] = []
  const right: TextItem[] = []
  const full: TextItem[] = []
  for (const item of items) {
    const endX = item.x + item.w
    if (endX < W * 0.55 && item.x < W * 0.45) left.push(item)
    else if (item.x > W * 0.45) right.push(item)
    else full.push(item)
  }
  // 单栏文档 (左右某侧占比极低): 全部归一路
  const twoColumn = left.length > items.length * 0.2 && right.length > items.length * 0.2

  let groups: Line[][]
  if (twoColumn) {
    const fullLines = buildLines(full)
    const leftLines = buildLines(left)
    const rightLines = buildLines(right)
    const colTop = Math.max(leftLines[0]?.y ?? -Infinity, rightLines[0]?.y ?? -Infinity)
    // 跨栏块按位置分为列上方 (标题/摘要) 与列下方
    groups = [
      ...splitParagraphs(fullLines.filter(l => l.y >= colTop - 4)),
      ...splitParagraphs(leftLines),
      ...splitParagraphs(rightLines),
      ...splitParagraphs(fullLines.filter(l => l.y < colTop - 4)),
    ]
  } else {
    groups = splitParagraphs(buildLines(items))
  }

  return groups
    .map(assemble)
    .filter(a => !isNoise(a.text))
    .slice(0, 80)
    .map((a, id) => ({
      id,
      text: a.text,
      placeholders: Object.keys(a.placeholders).length ? a.placeholders : undefined,
      bbox: a.bbox,
      fontSize: a.fontSize,
    }))
}

/**
 * 宽松兜底提取: 严格算法失败或为空时使用。
 * 只按 y 排序拼行, 再按句号/长度切块 — 只要页面有文字就有结果 (无版式信息)。
 */
export async function extractParagraphsLoose(page: any): Promise<PaperParagraph[]> {
  const content = await page.getTextContent()
  const items = (content.items as any[])
    .filter(i => i.str && String(i.str).trim())
    .map(i => ({ y: i.transform?.[5] ?? 0, x: i.transform?.[4] ?? 0, str: String(i.str) }))
  if (!items.length) return []
  items.sort((a, b) => b.y - a.y || a.x - b.x)
  const text = items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return []
  // 优先按句子切, 聚合到 ~600 字符一块
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]+["')\]]?\s*/g) ?? [text]
  const chunks: string[] = []
  let cur = ''
  for (const sentence of sentences) {
    if (cur && cur.length + sentence.length > 600) {
      chunks.push(cur.trim())
      cur = ''
    }
    cur += sentence
  }
  if (cur.trim()) chunks.push(cur.trim())
  return chunks.slice(0, 60).map((t, id) => ({ id, text: t }))
}
