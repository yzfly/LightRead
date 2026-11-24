/**
 * 文本类格式 (TXT / Markdown / HTML) 动态转换为内存中的 EPUB,
 * 复用 foliate-view 的分页、目录、进度、样式能力.
 */
import { zipSync, strToU8 } from 'fflate'
import { marked } from 'marked'
import { CHAPTER_RE } from './smartToc'
import { looksHardWrapped, packSections, toParagraphs } from './txtParagraphs'
import { CODE_CSS, codeChapters, textViewForBook } from './plainText'

/** 简繁写法相同的高频汉字: 用对了编码, 这些字会大量出现; 用错了解出来几乎都是生僻字和符号 */
const COMMON_HAN = new Set('的一是不了人在有我他中大上也之而以其子曰天下可于所此心又得出去自己日月山水小生如知道行年同手今已者十三五百千里外好老看王主乎')
const LEGACY_SAMPLE_BYTES = 64 * 1024

function commonHanCount(text: string): number {
  let count = 0
  for (const char of text) if (COMMON_HAN.has(char)) count++
  return count
}

/** 不是 UTF-8 的中文 TXT: 大陆多是 GBK (GB18030 兼容), 港台多是 Big5; 取开头一段两种都解一遍, 看哪种更像中文 */
export function legacyChineseEncoding(bytes: Uint8Array): 'gb18030' | 'big5' {
  const sample = bytes.subarray(0, LEGACY_SAMPLE_BYTES)
  const big5 = commonHanCount(new TextDecoder('big5').decode(sample))
  const gb = commonHanCount(new TextDecoder('gb18030').decode(sample))
  return big5 > gb ? 'big5' : 'gb18030'
}

/** TXT 解码: 带 BOM 的 UTF-16 按 BOM; 否则严格 UTF-8, 失败再在 GB18030 与 Big5 里挑 (与 Rust txt_epub::decode_text 一致) */
export async function decodeText(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const head = new Uint8Array(buf, 0, Math.min(2, buf.byteLength))
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf)
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(buf)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder(legacyChineseEncoding(new Uint8Array(buf))).decode(buf)
  }
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 任意 HTML 字符串 → 良构 XHTML body 内容 (EPUB 要求 XML 良构); 页面自带的 <style> 单独取出 */
function toWellFormedBody(html: string, options: { keepStyles?: boolean; headingIds?: boolean } = {}): {
  body: string
  title?: string
  css: string
  headings: Heading[]
} {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const title = doc.querySelector('title')?.textContent
    ?? doc.querySelector('h1, h2')?.textContent
    ?? undefined
  // 移除脚本与外部引用, 保证离线与安全
  doc.querySelectorAll('script, link, iframe, object, embed, noscript, base').forEach(el => el.remove())
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
    }
  }
  // 表格包一层横滑容器 (窄屏下表格不挤压, 整表左右滑)
  doc.body.querySelectorAll('table').forEach(table => {
    if (table.parentElement?.classList.contains('table-wrap')) return
    const wrap = doc.createElement('div')
    wrap.className = 'table-wrap'
    table.replaceWith(wrap)
    wrap.append(table)
  })
  const styles = Array.from(doc.querySelectorAll('style'))
  const css = options.keepStyles ? styles.map(el => el.textContent ?? '').join('\n') : ''
  styles.forEach(el => el.remove())
  // 目录: 文中 h1–h3 打锚点 (HTML 页面常把正文包在 div 里, 不按顶层标题切章)
  const headings: Heading[] = []
  if (options.headingIds) {
    doc.body.querySelectorAll('h1, h2, h3').forEach((el, i) => {
      const text = el.textContent?.replace(/\s+/g, ' ').trim()
      if (!text) return
      if (!el.id) el.id = `h${i}`
      headings.push({ id: el.id, title: text, level: Number(el.tagName[1]) })
    })
  }
  const body = new XMLSerializer().serializeToString(doc.body)
    .replace(/^<body[^>]*>/, '')
    .replace(/<\/body>$/, '')
  return { body, title: title?.trim(), css, headings }
}

interface Heading {
  id: string
  title: string
  level: number
}

interface Chapter {
  title: string
  html: string
  /** 章内锚点目录 (HTML 页面的 h1–h3) */
  headings?: Heading[]
}

/** TXT 按章节标题切分; 无标题命中时按段落数均匀切块, 避免单章过大 */
function splitTxtChapters(text: string, fallbackTitle: string): Chapter[] {
  const lines = text.split(/\r\n?|\n/)
  // 整本判定一次: 固定列宽硬换行的 TXT 合并段内断行
  const wrapped = looksHardWrapped(lines)
  const finishTxt = (c: { title: string; lines: string[] }) => finishTxtChapter(c, wrapped)
  const chapters: Chapter[] = []
  let current: { title: string; lines: string[] } | null = null
  let preface: string[] = []

  for (const line of lines) {
    if (CHAPTER_RE.test(line)) {
      if (current) chapters.push(finishTxt(current))
      else if (preface.some(l => l.trim())) chapters.push(finishTxt({ title: '开篇', lines: preface }))
      current = { title: line.trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    } else {
      preface.push(line)
    }
  }
  if (current) chapters.push(finishTxt(current))

  if (chapters.length === 0) {
    // 无章节结构: 每 300 段切一块
    const paras = toParagraphs(lines, wrapped)
    const CHUNK = 300
    for (let i = 0; i < paras.length; i += CHUNK) {
      chapters.push(finishTxtChapter({
        title: chapters.length === 0 ? fallbackTitle : `${fallbackTitle} (${chapters.length + 1})`,
        lines: paras.slice(i, i + CHUNK),
      }, false))
    }
  }
  if (chapters.length === 0) chapters.push({ title: fallbackTitle, html: '<p>(空文件)</p>' })
  return chapters
}

function finishTxtChapter(c: { title: string; lines: string[] }, wrapped: boolean): Chapter {
  const paras = toParagraphs(c.lines, wrapped)
    .map(l => `<p>${escapeXml(l)}</p>`)
    .join('\n')
  return {
    title: c.title,
    html: `<h2>${escapeXml(c.title)}</h2>\n${paras}`,
  }
}

/** Markdown 按一级/二级标题切分章节 */
function splitMdChapters(md: string, fallbackTitle: string): Chapter[] {
  const html = marked.parse(md, { async: false }) as string
  const { body } = toWellFormedBody(html)
  // 借助 DOM 按 h1/h2 切分
  const doc = new DOMParser().parseFromString(`<div id="root">${body}</div>`, 'text/html')
  const root = doc.getElementById('root')!
  const chapters: Chapter[] = []
  let current: { title: string; nodes: string[] } | null = null
  const flush = () => {
    if (current && current.nodes.length)
      chapters.push({ title: current.title, html: current.nodes.join('\n') })
  }
  for (const node of Array.from(root.children)) {
    const isHeading = node.tagName === 'H1' || node.tagName === 'H2'
    if (isHeading) {
      flush()
      current = { title: node.textContent?.trim() || fallbackTitle, nodes: [] }
    }
    if (!current) current = { title: fallbackTitle, nodes: [] }
    current.nodes.push(new XMLSerializer().serializeToString(node))
  }
  flush()
  if (chapters.length === 0) chapters.push({ title: fallbackTitle, html: body || '<p>(空文件)</p>' })
  return chapters
}

/** TXT (小说): 首行缩进, 每章另起一页 */
const TXT_CSS = `
html { font-family: inherit; line-height: 1.8; }
/* 一个分节装多章: 翻页模式每章另起一页, 滚动模式章间留白 */
.chapter + .chapter { break-before: column; margin-top: 3em; }
p { margin: 0 0 0.8em; text-indent: 2em; }
h1, h2, h3 { line-height: 1.4; }
img { max-width: 100%; }
pre { white-space: pre-wrap; background: #f5f6f7; padding: 0.8em; border-radius: 6px; }
${CODE_CSS}`

/**
 * Markdown / HTML: 按文档预览排版 (近似 VSCode / GitHub 预览), 章节连续不分页.
 * 颜色全用半透明灰叠在正文色上, 浅色 / 夜间 / 羊皮纸主题都可读.
 */
const DOC_CSS = `
html { font-family: inherit; line-height: 1.7; }
p { margin: 0 0 1em; text-indent: 0; }
h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.4em 0 0.6em; font-weight: 600; }
h1 { font-size: 1.9em; padding-bottom: 0.3em; border-bottom: 1px solid rgba(127, 127, 127, 0.3); }
h2 { font-size: 1.5em; padding-bottom: 0.25em; border-bottom: 1px solid rgba(127, 127, 127, 0.3); }
h3 { font-size: 1.25em; }
h4 { font-size: 1.05em; }
.chapter:first-child > :first-child { margin-top: 0; }
a { text-decoration: underline; text-underline-offset: 2px; }
img, svg, video { max-width: 100%; height: auto; }
ul, ol { padding-left: 1.8em; margin: 0 0 1em; }
li > ul, li > ol { margin: 0.2em 0 0; }
li + li { margin-top: 0.25em; }
li > input[type="checkbox"] { margin: 0 0.4em 0 -1.3em; vertical-align: middle; }
ul:has(> li > input[type="checkbox"]) { list-style: none; }
blockquote { margin: 0 0 1em; padding: 0.2em 1em; border-left: 4px solid rgba(127, 127, 127, 0.4); opacity: 0.85; }
blockquote > :last-child { margin-bottom: 0; }
hr { border: 0; border-top: 1px solid rgba(127, 127, 127, 0.35); margin: 1.6em 0; }
code, kbd, samp, pre {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace;
  font-size: 0.88em;
}
:not(pre) > code {
  padding: 0.15em 0.4em; border-radius: 4px; background: rgba(127, 127, 127, 0.15);
  /* 长标识符可断开: 否则整段被挤到下一行, 两端对齐把上一行字距拉得很开 */
  word-break: break-all;
}
/* 正文里的长链接 / 长单词不撑出栏宽 */
p, li, td, th, dd, blockquote { overflow-wrap: break-word; }
a { overflow-wrap: anywhere; }
kbd { padding: 0.1em 0.4em; border: 1px solid rgba(127, 127, 127, 0.45); border-bottom-width: 2px; border-radius: 4px; }
pre {
  margin: 0 0 1em; padding: 0.9em 1em; border-radius: 6px; background: rgba(127, 127, 127, 0.12);
  white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; tab-size: 4;
}
pre code { font-size: 1em; padding: 0; background: none; }
/* 窄屏: 表格包在可横滑的容器里 (生成时包好); 单元格中文按词不按字折行, 表头不折行,
   否则手机上会挤成一字一行 (表格单元格上的 min-width 浏览器不认) */
.table-wrap {
  margin: 0 0 1em; max-width: 100%; overflow-x: auto;
  -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain;
}
table { border-collapse: collapse; }
th, td {
  border: 1px solid rgba(127, 127, 127, 0.35); padding: 0.4em 0.75em; text-align: left; vertical-align: top;
  word-break: keep-all; overflow-wrap: break-word;
}
th { white-space: nowrap; }
th { font-weight: 600; background: rgba(127, 127, 127, 0.1); }
th[align="center"], td[align="center"] { text-align: center; }
th[align="right"], td[align="right"] { text-align: right; }
tr:nth-child(2n) td { background: rgba(127, 127, 127, 0.05); }
dt { font-weight: 600; }
dd { margin: 0 0 0.6em 1.5em; }
mark { padding: 0 0.15em; }
details { margin: 0 0 1em; }
.chapter * { max-width: 100% !important; box-sizing: border-box; }
/* 表格本身按内容撑开, 由外层 .table-wrap 横滑 */
.chapter table { max-width: none !important; }
.chapter img, .chapter svg, .chapter video, .chapter canvas, .chapter iframe { height: auto; }
summary { cursor: pointer; }
`

/** 内存 EPUB 的版式版本; 变化会让旧的阅读位置 CFI 失效 (阅读页据此改按进度比例恢复) */
export const TEXT_EPUB_LAYOUT = '3'

function chapterXhtml(title: string, body: string, pageCss: boolean): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(title)}</title><link rel="stylesheet" href="style.css"/>${pageCss ? '<link rel="stylesheet" href="page.css"/>' : ''}</head>
<body>${body}</body>
</html>`
}

/** 标题列表 → 嵌套的 nav <li> (h1 > h2 > h3, 跳级时挂到最近的上级) */
export function navTree(headings: Heading[], hrefOf: (id: string) => string): string {
  type Node = Heading & { children: Node[] }
  const root: Node = { id: '', title: '', level: 0, children: [] }
  const stack: Node[] = [root]
  for (const h of headings) {
    while (stack[stack.length - 1].level >= h.level) stack.pop()
    const node: Node = { ...h, children: [] }
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  const render = (nodes: Node[]): string => nodes
    .map(n => `<li><a href="${hrefOf(n.id)}">${escapeXml(n.title)}</a>${n.children.length ? `<ol>${render(n.children)}</ol>` : ''}</li>`)
    .join('')
  return render(root.children)
}

/** 将文本类文件封装为 EPUB Blob (txt 里的代码类文件按代码视图排版, 见 plainText.ts) */
/**
 * 文本类书籍的书名。Markdown 用文件名: 笔记、文档的第一个标题多是「概述」「简介」「Day 1」这类小标题,
 * 拿来当书名会让一堆 MD 在书架上认不出来 (2026-11-23 读者反馈)。源码 / 配置保留扩展名
 * (package.json 不该显示成 package); HTML 有 <title> 用 <title>。
 */
export function textBookTitle(fileName: string, format: 'txt' | 'md' | 'html', htmlTitle?: string): string {
  const name = fileName.split(/[\\/]/).pop() || fileName
  const baseName = name.replace(/\.[^.]+$/, '') || name
  if (format === 'txt' && textViewForBook(fileName) === 'code') return name
  if (format === 'html' && htmlTitle?.trim()) return htmlTitle.trim()
  return baseName
}

export async function convertToEpub(
  blob: Blob,
  fileName: string,
  format: 'txt' | 'md' | 'html',
): Promise<{ epub: Blob; title: string }> {
  const baseName = fileName.replace(/\.[^.]+$/, '')
  const text = await decodeText(blob)

  let chapters: Chapter[]
  let title = textBookTitle(fileName, format)
  let pageCss = ''
  if (format === 'txt' && textViewForBook(fileName) === 'code') {
    chapters = codeChapters(text, fileName)
  } else if (format === 'txt') {
    chapters = splitTxtChapters(text, baseName)
  } else if (format === 'md') {
    chapters = splitMdChapters(text, baseName)
  } else {
    // HTML: 整页一章, 保留页面自带样式, 目录取文中标题
    const { body, title: htmlTitle, css, headings } = toWellFormedBody(text, { keepStyles: true, headingIds: true })
    title = textBookTitle(fileName, format, htmlTitle)
    pageCss = css
    chapters = [{ title, html: body || '<p>(空文件)</p>', headings }]
  }
  const css = format === 'txt' ? TXT_CSS : DOC_CSS

  // 章 → 分节: 目录项指向分节内的章锚点 (foliate 按片段判定当前章节)
  const sections = packSections(chapters.map((c, i) => ({ ...c, id: `c${i}` })))
  const hrefOf = new Map<string, string>()
  sections.forEach((sec, j) => sec.forEach(c => hrefOf.set(c.id, `s${j}.xhtml#${c.id}`)))
  const manifest = sections
    .map((_, j) => `<item id="s${j}" href="s${j}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n    ')
  const spine = sections.map((_, j) => `<itemref idref="s${j}"/>`).join('\n    ')
  const navList = chapters
    .map((c, i) => {
      const href = hrefOf.get(`c${i}`)!
      // 有章内标题时目录直接列标题 (HTML 页面); 否则一章一项
      if (c.headings?.length) {
        const file = href.split('#')[0]
        return navTree(c.headings, id => `${file}#${id}`)
      }
      return `<li><a href="${href}">${escapeXml(c.title)}</a></li>`
    })
    .join('\n      ')

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:lights:${encodeURIComponent(baseName)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">1970-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>${pageCss ? '\n    <item id="page-css" href="page.css" media-type="text/css"/>' : ''}
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc"><h1>目录</h1>
    <ol>
      ${navList}
    </ol>
  </nav>
</body>
</html>`

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

  // EPUB 只在内存里交给 foliate, 不落盘: 用 store (不压缩), 省掉每次开书的
  // deflate 和 foliate 读每一章时的 inflate (2MB 的 TXT 约省 200ms+ 主线程)
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/style.css': strToU8(css),
  }
  if (pageCss) files['OEBPS/page.css'] = strToU8(pageCss)
  sections.forEach((sec, j) => {
    const body = sec.map(c => `<section class="chapter" id="${c.id}">\n${c.html}\n</section>`).join('\n')
    files[`OEBPS/s${j}.xhtml`] = strToU8(chapterXhtml(sec[0].title, body, !!pageCss))
  })

  const zipped = zipSync(files, { level: 0 })
  return { epub: new Blob([zipped.buffer as ArrayBuffer], { type: 'application/epub+zip' }), title }
}
