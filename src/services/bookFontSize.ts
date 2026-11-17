/**
 * 书里写死的绝对字号改成相对字号, 让「字号」设置对所有 EPUB 生效 (issue #22)。
 *
 * 阅读字号写在 iframe 的 html 上 (readerTheme.getReaderCSS)。书的 CSS 若用 px / pt / 关键字
 * 给 body、p 或类名定字号 (出版社 EPUB 常见), 正文不再继承 html, 调字号就毫无变化。
 * 这里在 foliate 加载样式表时把绝对字号按浏览器默认 16px 换算成 rem: 书里 16px / 12pt 的
 * 正文正好等于设置的字号, 标题、注释等的大小比例保持书里的设计。
 * em / % / rem / larger 等相对写法原样保留。
 */

/** 1 个单位等于多少 px (CSS 绝对单位) */
const UNIT_PX: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
}

/** 绝对字号关键字 (CSS Fonts 4 的推荐值, medium = 16px) */
const KEYWORD_PX: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
}

const BASE_PX = 16

function rem(px: number): string {
  return `${Number((px / BASE_PX).toFixed(4))}rem`
}

const NUMBER = String.raw`(\d*\.?\d+)`
const UNITS = Object.keys(UNIT_PX).join('|')
const KEYWORDS = Object.keys(KEYWORD_PX).join('|')

// font-size: 12pt / font-size:small  (值后必须是分隔符, 免得把 calc() 里的一部分或 smaller 误改)
const FONT_SIZE_RE = new RegExp(String.raw`(font-size\s*:\s*)(?:${NUMBER}(${UNITS})|(${KEYWORDS}))(?=\s*(?:!|;|\}|"|'|$))`, 'gi')
// font: italic bold 12pt/1.4 Georgia  (简写里第一个绝对长度就是字号)
const FONT_SHORTHAND_RE = new RegExp(String.raw`((?:^|[\s{;"'])font\s*:[^;}"']*?)(?:${NUMBER}(${UNITS})|\b(${KEYWORDS})\b)(?=[\s/])`, 'gi')

/** 把一段 CSS (样式表或 style 属性) 里的绝对字号改写为 rem */
export function relativizeFontSizes(css: string): string {
  if (!css || !/font/i.test(css)) return css
  const convert = (num: string | undefined, unit: string | undefined, keyword: string | undefined) => {
    if (keyword) return rem(KEYWORD_PX[keyword.toLowerCase()])
    const px = parseFloat(num!) * UNIT_PX[unit!.toLowerCase()]
    return Number.isFinite(px) ? rem(px) : `${num}${unit}`
  }
  return css
    .replace(FONT_SIZE_RE, (_, prop, num, unit, keyword) => prop + convert(num, unit, keyword))
    .replace(FONT_SHORTHAND_RE, (_, head, num, unit, keyword) => head + convert(num, unit, keyword))
}

/** (X)HTML 只改 <style> 元素和 style 属性, 不碰正文 (技术书正文里也会出现 "font-size: 12px") */
export function relativizeHtmlFontSizes(html: string): string {
  if (!html || !/font/i.test(html)) return html
  return html
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, body, close) => open + relativizeFontSizes(body) + close)
    .replace(/(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (_, attr, dq, sq) =>
      dq !== undefined ? `${attr}"${relativizeFontSizes(dq)}"` : `${attr}'${relativizeFontSizes(sq)}'`)
}

const HTML_TYPES = new Set(['application/xhtml+xml', 'text/html', 'image/svg+xml'])

/** foliate 资源加载钩子用: 按媒体类型改写, 其他类型原样返回 */
export function relativizeBookResource(type: string, data: unknown): unknown {
  if (typeof data !== 'string') return data
  if (type === 'text/css') return relativizeFontSizes(data)
  if (HTML_TYPES.has(type)) return relativizeHtmlFontSizes(data)
  return data
}
