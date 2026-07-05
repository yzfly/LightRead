/**
 * 文本类格式 (TXT / Markdown / HTML) 动态转换为内存中的 EPUB,
 * 复用 foliate-view 的分页、目录、进度、样式能力.
 */
import { zipSync, strToU8 } from 'fflate'
import { marked } from 'marked'

/** 中文网络小说与常见英文书的章节标题模式 */
const CHAPTER_RE =
  /^\s*(?:第\s*[0-9一二三四五六七八九十百千万零两〇]+\s*[章节卷回部集话]|(?:Chapter|CHAPTER|Part|PART)\s+[0-9IVXLC]+|序章|序言|楔子|前言|引子|后记|尾声|终章|番外(?:篇)?[0-9一二三四五六七八九十]*).{0,40}$/

/** TXT 常见 GBK 编码, 优先严格 UTF-8, 失败回退 GB18030 */
export async function decodeText(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('gb18030').decode(buf)
  }
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 任意 HTML 字符串 → 良构 XHTML body 内容 (EPUB 要求 XML 良构) */
function toWellFormedBody(html: string): { body: string; title?: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const title = doc.querySelector('title')?.textContent
    ?? doc.querySelector('h1, h2')?.textContent
    ?? undefined
  // 移除脚本与外部引用, 保证离线与安全
  doc.querySelectorAll('script, link, iframe, object, embed').forEach(el => el.remove())
  const body = new XMLSerializer().serializeToString(doc.body)
    .replace(/^<body[^>]*>/, '')
    .replace(/<\/body>$/, '')
  return { body, title: title?.trim() }
}

interface Chapter {
  title: string
  html: string
}

/** TXT 按章节标题切分; 无标题命中时按段落数均匀切块, 避免单章过大 */
function splitTxtChapters(text: string, fallbackTitle: string): Chapter[] {
  const lines = text.split(/\r\n?|\n/)
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
    const paras = lines.filter(l => l.trim())
    const CHUNK = 300
    for (let i = 0; i < paras.length; i += CHUNK) {
      chapters.push(finishTxt({
        title: chapters.length === 0 ? fallbackTitle : `${fallbackTitle} (${chapters.length + 1})`,
        lines: paras.slice(i, i + CHUNK),
      }))
    }
  }
  if (chapters.length === 0) chapters.push({ title: fallbackTitle, html: '<p>(空文件)</p>' })
  return chapters
}

function finishTxt(c: { title: string; lines: string[] }): Chapter {
  const paras = c.lines
    .map(l => l.trim())
    .filter(Boolean)
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

const CSS = `
html { font-family: inherit; line-height: 1.8; }
p { margin: 0 0 0.8em; text-indent: 2em; }
h1, h2, h3 { line-height: 1.4; }
img { max-width: 100%; }
pre { white-space: pre-wrap; background: #f5f6f7; padding: 0.8em; border-radius: 6px; }
`

function chapterXhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>${body}</body>
</html>`
}

/** 将文本类文件封装为 EPUB Blob */
export async function convertToEpub(
  blob: Blob,
  fileName: string,
  format: 'txt' | 'md' | 'html',
): Promise<{ epub: Blob; title: string }> {
  const baseName = fileName.replace(/\.[^.]+$/, '')
  const text = await decodeText(blob)

  let chapters: Chapter[]
  let title = baseName
  if (format === 'txt') {
    chapters = splitTxtChapters(text, baseName)
  } else if (format === 'md') {
    chapters = splitMdChapters(text, baseName)
    if (chapters.length && chapters[0].title !== baseName) title = chapters[0].title
  } else {
    const { body, title: htmlTitle } = toWellFormedBody(text)
    if (htmlTitle) title = htmlTitle
    chapters = [{ title, html: body || '<p>(空文件)</p>' }]
  }

  const manifest = chapters
    .map((_, i) => `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('\n    ')
  const spine = chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('\n    ')
  const navList = chapters
    .map((c, i) => `<li><a href="ch${i}.xhtml">${escapeXml(c.title)}</a></li>`)
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
    <item id="css" href="style.css" media-type="text/css"/>
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

  const files: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': [strToU8(container), { level: 6 }],
    'OEBPS/content.opf': [strToU8(opf), { level: 6 }],
    'OEBPS/nav.xhtml': [strToU8(nav), { level: 6 }],
    'OEBPS/style.css': [strToU8(CSS), { level: 6 }],
  }
  chapters.forEach((c, i) => {
    files[`OEBPS/ch${i}.xhtml`] = [strToU8(chapterXhtml(c.title, c.html)), { level: 6 }]
  })

  const zipped = zipSync(files)
  return { epub: new Blob([zipped.buffer as ArrayBuffer], { type: 'application/epub+zip' }), title }
}
