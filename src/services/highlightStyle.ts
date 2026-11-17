/**
 * 划线风格 (issue #21): 色块高亮 / 下划线 / 波浪线。
 * 标注只多存一个 style 字段, 缺省即高亮 (旧数据、旧版本同步过来的记录都按高亮画)。
 * 线条比色块细, 用同色系更深的一档, 浅色底和夜间底上都看得清。
 * 不依赖其他模块 (存储层也用它), 色块颜色由调用方传入 (readerTheme.HIGHLIGHT_COLORS)。
 */

export const HIGHLIGHT_STYLES = ['highlight', 'underline', 'squiggly'] as const
export type HighlightStyle = typeof HIGHLIGHT_STYLES[number]

/** 线条用色: 与 HIGHLIGHT_COLORS 同名, 饱和一些 */
export const HIGHLIGHT_LINE_COLORS: Record<string, string> = {
  yellow: '#e0a100',
  green: '#2e9e57',
  blue: '#3b7fe6',
  red: '#e0484d',
}

export function normalizeHighlightStyle(style: unknown): HighlightStyle {
  return HIGHLIGHT_STYLES.includes(style as HighlightStyle) ? style as HighlightStyle : 'highlight'
}

/** 存储 / 同步用: 高亮是缺省值, 不写字段 (旧记录与旧客户端的数据保持原样) */
export function storedHighlightStyle(style: unknown): Exclude<HighlightStyle, 'highlight'> | undefined {
  const s = normalizeHighlightStyle(style)
  return s === 'highlight' ? undefined : s
}

export interface HighlightDrawSpec {
  kind: HighlightStyle
  options: Record<string, unknown>
}

/** 画一条标注要用的 Overlayer 方法与参数 (纯函数, 便于测试) */
export function highlightDrawSpec(fills: Record<string, string>, color: string, style: unknown, writingMode?: string): HighlightDrawSpec {
  const kind = normalizeHighlightStyle(style)
  if (kind === 'highlight') return { kind, options: { color: fills[color] ?? color } }
  const line = HIGHLIGHT_LINE_COLORS[color] ?? fills[color] ?? color
  const vertical = writingMode === 'vertical-rl' || writingMode === 'vertical-lr'
  return kind === 'underline'
    ? { kind, options: { color: line, width: 2, padding: vertical ? 3 : 2, writingMode } }
    : { kind, options: { color: line, width: 1.5, padding: vertical ? 3 : 2.5, writingMode } }
}

type OverlayerLike = Record<HighlightStyle, (rects: unknown, options?: Record<string, unknown>) => unknown>

/** foliate 的 draw-annotation 事件里调用: 按标注的颜色与风格绘制 */
export function drawHighlight(
  Overlayer: OverlayerLike,
  fills: Record<string, string>,
  detail: { draw: (fn: unknown, opts: Record<string, unknown>) => void; annotation: { color: string; style?: unknown }; doc?: Document },
) {
  const { draw, annotation, doc } = detail
  let writingMode: string | undefined
  try {
    writingMode = doc?.body && doc.defaultView ? doc.defaultView.getComputedStyle(doc.body).writingMode : undefined
  } catch { /* 文档已卸载 */ }
  const spec = highlightDrawSpec(fills, annotation.color, annotation.style, writingMode)
  draw(Overlayer[spec.kind], spec.options)
}
