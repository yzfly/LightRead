/**
 * 论文 PDF 段落提取: 基于 pdf.js 文本项坐标聚类。
 *  - 双栏版式识别 (学术论文常见): 左列 / 右列 / 跨栏块
 *  - 行聚类 → 段落切分 (行距突变 / 首行缩进), 连字符断词还原
 *  - 过滤页眉页脚页码等噪声
 */

export interface PaperParagraph {
  /** 页内序号 (阅读顺序) */
  id: number
  text: string
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
  text: string
}

/** 文本项 → 行 (同列内按 y 聚类) */
function buildLines(items: TextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Line[] = []
  for (const item of sorted) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - item.y) < Math.max(2.5, item.h * 0.5)) {
      // 同一行: 依据水平间距决定是否补空格
      const gap = item.x - last.endX
      last.text += (gap > item.h * 0.15 ? ' ' : '') + item.str
      last.endX = Math.max(last.endX, item.x + item.w)
    } else {
      lines.push({ y: item.y, h: item.h, x: item.x, endX: item.x + item.w, text: item.str })
    }
  }
  return lines
}

/** 行 → 段落: 行距突变或明显缩进开新段; 连字符断词拼回 */
function buildParagraphs(lines: Line[]): string[] {
  if (!lines.length) return []
  const leftEdge = Math.min(...lines.map(l => l.x))
  const paras: string[] = []
  let current = ''
  const push = () => {
    const text = current.replace(/\s+/g, ' ').trim()
    if (text) paras.push(text)
    current = ''
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const prev = lines[i - 1]
    if (prev) {
      const gap = prev.y - line.y
      const lineH = Math.max(prev.h, line.h, 8)
      const indented = line.x - leftEdge > lineH * 0.8 && prev.x - leftEdge < lineH * 0.4
      if (gap > lineH * 1.55 || indented) push()
    }
    if (current.endsWith('-')) {
      current = current.slice(0, -1) + line.text // 连字符断词
    } else {
      current += (current ? ' ' : '') + line.text
    }
  }
  push()
  return paras
}

/** 是否为噪声块 (页码 / 短杂项) */
const isNoise = (text: string) =>
  text.length < 3 || /^\d{1,4}$/.test(text) || /^(arxiv:|preprint|under review)/i.test(text.slice(0, 24))

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

  let ordered: string[]
  if (twoColumn) {
    const fullLines = buildLines(full)
    const leftLines = buildLines(left)
    const rightLines = buildLines(right)
    const colTop = Math.max(
      leftLines[0]?.y ?? -Infinity,
      rightLines[0]?.y ?? -Infinity,
    )
    // 跨栏块按位置分为列上方 (标题/摘要) 与列下方
    const fullAbove = buildParagraphs(fullLines.filter(l => l.y >= colTop - 4))
    const fullBelow = buildParagraphs(fullLines.filter(l => l.y < colTop - 4))
    ordered = [
      ...fullAbove,
      ...buildParagraphs(leftLines),
      ...buildParagraphs(rightLines),
      ...fullBelow,
    ]
  } else {
    ordered = buildParagraphs(buildLines(items))
  }

  return ordered
    .filter(text => !isNoise(text))
    .slice(0, 80)
    .map((text, id) => ({ id, text }))
}

/**
 * 宽松兜底提取: 严格算法失败或为空时使用。
 * 只按 y 排序拼行, 再按句号/长度切块 — 只要页面有文字就有结果。
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
