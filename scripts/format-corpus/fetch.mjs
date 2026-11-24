// 格式兼容语料: 按 manifest.json 下载 / 生成到本机缓存, 逐个核对 SHA-256。
//   node scripts/format-corpus/fetch.mjs          下载缺的文件; 摘要不符就失败
//   node scripts/format-corpus/fetch.mjs --pin    新加的条目: 下载后把摘要写回 manifest (提交前人工看过)
// 缓存目录 LIGHTREAD_CORPUS_DIR, 默认 ~/.cache/lightread-format-corpus。书不进 git。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'

export const MANIFEST_PATH = new URL('./manifest.json', import.meta.url)
export const CORPUS_DIR = process.env.LIGHTREAD_CORPUS_DIR || join(homedir(), '.cache', 'lightread-format-corpus')
export const loadManifest = () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function download(url) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (LightRead format corpus)' }, redirect: 'follow', signal: AbortSignal.timeout(180_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return new Uint8Array(await res.arrayBuffer())
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, attempt * 3000))
    }
  }
  throw new Error(`${url}: ${lastError.message}`)
}

// TextDecoder 能解 GBK / Big5 但不能编码: 遍历双字节码位反查出编码表
const encoderCache = new Map()
function legacyEncoder(label) {
  if (encoderCache.has(label)) return encoderCache.get(label)
  const decoder = new TextDecoder(label)
  const table = new Map()
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      const char = decoder.decode(new Uint8Array([lead, trail]))
      if (char.length === 1 && char !== '�' && !table.has(char)) table.set(char, [lead, trail])
    }
  }
  const encode = text => {
    const out = []
    for (const char of text) {
      const code = char.codePointAt(0)
      if (code < 0x80) out.push(code)
      else {
        // 编码表里没有的生僻字照转换工具的做法换成「?」, 真实的 GBK / Big5 书也是这样来的
        const bytes = table.get(char)
        if (bytes) out.push(...bytes)
        else out.push(0x3f)
      }
    }
    return new Uint8Array(out)
  }
  encoderCache.set(label, encode)
  return encode
}

const utf8 = bytes => new TextDecoder().decode(bytes).replace(/^﻿/, '')
const FIXED_MTIME = new Date('2026-01-01T00:00:00Z')

/** 由已下载的原件派生出常见的「野生」变体: 编码、改名、FB2 */
const DERIVE = {
  copy: src => src,
  gbk: src => legacyEncoder('gbk')(utf8(src)),
  big5: src => legacyEncoder('big5')(utf8(src)),
  'utf16le-bom': src => {
    const text = '﻿' + utf8(src)
    const out = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8 }
    return out
  },
  fb2: (src, entry) => strToU8(textToFb2(utf8(src), entry.derive)),
  fbz: (src, entry) => zipSync({ [entry.derive.inner]: [strToU8(textToFb2(utf8(src), entry.derive)), { mtime: FIXED_MTIME }] }, { mtime: FIXED_MTIME }),
  'md-notes': (src, entry) => strToU8(`# ${entry.derive.heading}\n\n${utf8(src).split(/\n{2,}/).slice(0, 40).join('\n\n')}\n`),
}

const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Gutenberg 纯文本 → FictionBook 2: 按章节标题切 <section>, 正文按空行分段 */
function textToFb2(text, { title, author, chapter }) {
  const start = text.indexOf('*** START OF')
  const end = text.indexOf('*** END OF')
  const body = text.slice(text.indexOf('\n', start) + 1, end > 0 ? end : undefined)
  const heading = new RegExp(chapter, 'm')
  const parts = body.split(new RegExp(`(?=${chapter})`, 'm')).filter(part => heading.test(part))
  const sections = parts.map(part => {
    const [first, ...rest] = part.trim().split(/\n{2,}/)
    const paras = rest.map(p => `<p>${xml(p.replace(/\s*\n\s*/g, ' ').trim())}</p>`).join('')
    return `<section><title><p>${xml(first.replace(/\s*\n\s*/g, ' '))}</p></title>${paras}</section>`
  }).join('\n')
  const [first, ...last] = author.split(' ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>child_tale</genre><author><first-name>${xml(first)}</first-name><last-name>${xml(last.join(' '))}</last-name></author><book-title>${xml(title)}</book-title><lang>en</lang></title-info>
<document-info><author><nickname>LightRead corpus</nickname></author><date>2026-01-01</date><id>lightread-corpus-${xml(title)}</id><version>1.0</version></document-info></description>
<body><title><p>${xml(title)}</p></title>
${sections}
</body></FictionBook>
`
}

export function entryPath(entry) { return join(CORPUS_DIR, entry.file) }

async function materialize(entry, byId) {
  if (entry.url) return download(entry.url)
  const source = byId.get(entry.derive.from)
  const src = readFileSync(entryPath(source))
  const op = DERIVE[entry.derive.op]
  if (!op) throw new Error(`未知派生方式 ${entry.derive.op}`)
  return op(src, entry)
}

export async function fetchCorpus({ pin = false, log = console.log } = {}) {
  const manifest = loadManifest()
  const byId = new Map(manifest.books.map(entry => [entry.id, entry]))
  let changed = false
  // 先下载原件, 再派生 (派生依赖原件)
  const ordered = [...manifest.books.filter(e => e.url), ...manifest.books.filter(e => !e.url)]
  const failures = []
  for (const entry of ordered) {
    const path = entryPath(entry)
    if (existsSync(path) && entry.sha256 && sha256(readFileSync(path)) === entry.sha256) continue
    try {
      const bytes = await materialize(entry, byId)
      const digest = sha256(bytes)
      if (entry.sha256 && entry.sha256 !== digest) throw new Error(`SHA-256 不符: 期望 ${entry.sha256}, 实得 ${digest} (源文件变了? 核对后再 --pin)`)
      if (!entry.sha256) {
        if (!pin) throw new Error('还没有固定摘要, 用 --pin 下载并写回 manifest')
        entry.sha256 = digest
        entry.size = bytes.length
        changed = true
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path + '.part', bytes)
      renameSync(path + '.part', path)
      log(`✓ ${entry.id} (${(bytes.length / 1024).toFixed(0)} KB)`)
    } catch (error) {
      failures.push(`${entry.id}: ${error.message}`)
      log(`✗ ${entry.id}: ${error.message}`)
    }
  }
  if (changed) writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')
  if (failures.length) throw new Error(`语料准备失败 ${failures.length} 项:\n${failures.join('\n')}`)
  return manifest
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const manifest = await fetchCorpus({ pin: process.argv.includes('--pin') })
    console.log(`语料就绪: ${manifest.books.length} 本 → ${CORPUS_DIR}`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
