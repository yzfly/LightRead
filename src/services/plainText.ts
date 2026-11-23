/**
 * 通用纯文本 (像 VSCode 那样打开任意文本文件): 源码 / 配置 / 日志 / 数据文件,
 * 以及没有扩展名的 README / LICENSE / Dockerfile 等.
 *
 * 不新增书籍格式: 这些文件按 `txt` 入库, 打开时按文件名决定排版 ——
 * 代码类用等宽字体 + 行号 + 保留缩进, 散文类沿用 TXT 的分章分段.
 * 旧版客户端同步到这类书时仍能当普通 TXT 打开.
 *
 * 纯函数 (无 DOM), 契约见 scripts/test-plain-text.mjs.
 */

import { ACCEPT, detectFormat, FORMAT_LABELS } from './format.ts'
import type { BookFormat } from '../storage/types'

export type TextView = 'code' | 'prose'

/** 散文类: 按 TXT 分章分段 */
const PROSE_EXTS = new Set(['txt', 'text', 'rst', 'org', 'adoc', 'asciidoc', 'nfo', 'me', '1st'])

/** 代码 / 配置 / 数据类: 等宽 + 行号 */
const CODE_EXTS = new Set([
  // 数据与配置
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'geojson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config',
  'properties', 'env', 'xml', 'xsd', 'xsl', 'xslt', 'plist', 'opf', 'ncx', 'csv', 'tsv', 'psv', 'log', 'out',
  'diff', 'patch', 'lock', 'sum', 'mod', 'srt', 'vtt', 'ass', 'ssa', 'lrc', 'bib', 'ris', 'ics', 'vcf', 'sql',
  'graphql', 'gql', 'proto', 'prisma', 'tf', 'tfvars', 'hcl', 'nix', 'dhall', 'editorconfig', 'gitignore',
  'gitattributes', 'gitmodules', 'dockerignore', 'npmrc', 'nvmrc', 'mailmap', 'htaccess',
  // 标记与样式
  'tex', 'latex', 'sty', 'cls', 'bst', 'typ', 'css', 'scss', 'sass', 'less', 'styl', 'svg', 'vue', 'svelte',
  'astro', 'jsx', 'tsx', 'pug', 'jade', 'haml', 'hbs', 'handlebars', 'mustache', 'ejs', 'erb', 'njk', 'liquid',
  'twig', 'jinja', 'j2', 'tmpl', 'tpl', 'wxml', 'wxss',
  // 编程语言
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'py', 'pyi', 'pyw', 'ipynb', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'sc', 'groovy', 'gradle', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'ino', 'm', 'mm', 'cs', 'fs',
  'fsx', 'vb', 'swift', 'dart', 'rb', 'rake', 'gemspec', 'php', 'pl', 'pm', 'lua', 'r', 'jl', 'hs', 'lhs', 'elm',
  'ml', 'mli', 're', 'res', 'clj', 'cljs', 'cljc', 'edn', 'lisp', 'lsp', 'el', 'scm', 'rkt', 'ss', 'erl', 'hrl',
  'ex', 'exs', 'eex', 'heex', 'zig', 'nim', 'v', 'sv', 'vhd', 'vhdl', 'd', 'cr', 'pas', 'pp', 'f', 'f90', 'for',
  'asm', 's', 'wat', 'sol', 'move', 'cairo', 'vim', 'awk', 'sed', 'sh', 'bash', 'zsh', 'fish', 'ksh', 'csh',
  'ps1', 'psm1', 'bat', 'cmd', 'mk', 'mak', 'make', 'cmake', 'bzl', 'bazel', 'gn', 'gni', 'ninja', 'meson',
  'glsl', 'hlsl', 'wgsl', 'frag', 'vert', 'shader', 'cu', 'cuh', 'metal', 'applescript', 'ahk', 'coffee', 'ls',
  'purs', 'gleam', 'odin', 'mojo', 'ql', 'rego', 'cue', 'jsonnet', 'libsonnet', 'pkl', 'http', 'rest',
])

/** 没有扩展名 (或扩展名不说明问题) 的常见文本文件, 按小写全名匹配 */
const PROSE_NAMES = new Set([
  'readme', 'license', 'licence', 'copying', 'copyright', 'authors', 'contributors', 'changelog', 'changes',
  'history', 'news', 'notice', 'todo', 'thanks', 'install', 'credits', 'patents', 'maintainers', 'contributing',
])
const CODE_NAMES = new Set([
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'cmakelists.txt', 'rakefile', 'gemfile', 'podfile',
  'brewfile', 'procfile', 'vagrantfile', 'jenkinsfile', 'justfile', 'caddyfile', 'snakefile', 'pipfile',
  'build', 'workspace', 'owners', 'codeowners', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile',
  '.vimrc', '.inputrc', '.tmux.conf', '.env', '.prettierrc', '.eslintrc', '.babelrc', '.stylelintrc',
])

function splitName(fileName: string): { base: string; ext: string } {
  const base = (fileName.split(/[\\/]/).pop() ?? '').toLowerCase()
  const dot = base.lastIndexOf('.')
  // 点开头且只有一个点的 (.gitignore) 整体当扩展名
  const ext = dot >= 0 ? base.slice(dot + 1) : ''
  return { base, ext }
}

/** 按文件名判断是否为可读的纯文本, 以及用哪种排版; 认不出返回 null */
export function textViewOf(fileName: string): TextView | null {
  const { base, ext } = splitName(fileName)
  if (CODE_NAMES.has(base)) return 'code'
  if (PROSE_NAMES.has(base)) return 'prose'
  if (CODE_EXTS.has(ext)) return 'code'
  if (PROSE_EXTS.has(ext)) return 'prose'
  // LICENSE.MIT / README.zh-CN / Dockerfile.dev 之类: 看第一段
  const parts = base.split('.')
  const head = base.startsWith('.') ? '.' + parts[1] : parts[0]
  if (parts.length > (base.startsWith('.') ? 2 : 1)) {
    if (CODE_NAMES.has(head)) return 'code'
    if (PROSE_NAMES.has(head)) return 'prose'
  }
  // .env.local / .eslintrc.cjs 之类点文件已由扩展名覆盖; 其余点文件 (.foorc) 多是配置
  if (/^\.[\w-]+rc$/.test(base)) return 'code'
  return null
}

/** 存成 txt 的书打开时的排版: 只有明确的代码类文件名才用代码视图 */
export function textViewForBook(fileName: string): TextView {
  return textViewOf(fileName) === 'code' ? 'code' : 'prose'
}

/** 书卡角标: 代码 / 无扩展名文件显示扩展名或文件名 (如 JSON / PY / Dockerfile), 太长则返回空 */
export function plainTextLabel(fileName: string): string {
  const { base, ext } = splitName(fileName)
  if (!textViewOf(fileName)) return ''
  if (ext && ext !== base.replace(/^\./, '') && ext.length <= 6) return ext.toUpperCase()
  const raw = (fileName.split(/[\\/]/).pop() ?? '')
  return raw.length <= 10 ? raw : ''
}

/**
 * 内容嗅探: 扩展名不认识时, 看开头 64KB 是否像文本.
 * 有 NUL 字节或控制字符占比超过 1% 即视为二进制; UTF-16 BOM 视为文本.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 64 * 1024)
  if (n === 0) return true
  if (n >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return true
  let control = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    if (b === 0) return false
    // 允许 \t \n \v \f \r 和 ESC (日志里的 ANSI 颜色)
    if (b < 0x20 && !(b >= 0x09 && b <= 0x0d) && b !== 0x1b) control++
    else if (b === 0x7f) control++
  }
  return control / n <= 0.01
}

/** 去掉 ANSI 颜色等终端控制序列 (日志常见), 以及 XML 不允许的控制字符 */
export function cleanControlChars(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/** 压缩成一两行的 JSON 展开成缩进格式, 否则原样返回 */
export function prettyJsonIfMinified(text: string, fileName: string): string {
  const { ext } = splitName(fileName)
  if (!['json', 'geojson', 'ipynb'].includes(ext)) return text
  const lines = text.split('\n').length
  if (lines > 3 || text.length < 120) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface CodeChapter {
  title: string
  html: string
}

/** 每章行数: 大文件按行分块, 目录可按行号跳转 */
export const CODE_LINES_PER_CHAPTER = 1000

/**
 * 代码视图: 每行一个 <li>, 行号由有序列表的标记生成 (不进入正文, 朗读 / 复制 / 搜索都不会带上行号).
 * 分块时 <ol start> 续接行号.
 */
export function codeChapters(text: string, fileName: string, perChapter = CODE_LINES_PER_CHAPTER): CodeChapter[] {
  const displayName = fileName.split(/[\\/]/).pop() || fileName
  const body = cleanControlChars(prettyJsonIfMinified(text.replace(/^﻿/, ''), fileName))
  const lines = body.split(/\r\n?|\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const digits = String(lines.length).length
  const chapters: CodeChapter[] = []
  for (let i = 0; i < lines.length; i += perChapter) {
    const chunk = lines.slice(i, i + perChapter)
    const items = chunk.map(l => `<li>${escapeXml(l)}</li>`).join('\n')
    const end = i + chunk.length
    chapters.push({
      title: lines.length <= perChapter ? displayName : `${i + 1}–${end}`,
      html: `<ol class="code" start="${i + 1}" style="padding-left: ${digits + 2}ch">\n${items}\n</ol>`,
    })
  }
  return chapters
}

/** 代码视图的样式 (追加在内存 EPUB 的 style.css 里) */
export const CODE_CSS = `
ol.code {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", monospace;
  font-size: 0.86em;
  tab-size: 4;
  -moz-tab-size: 4;
}
ol.code > li {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: normal;
  line-height: 1.6 !important;
  text-align: left !important;
  text-indent: 0;
  -webkit-hyphens: manual !important;
  hyphens: manual !important;
  min-height: 1.6em;
}
ol.code > li::marker {
  font-size: 0.85em;
  opacity: 0.4;
}
`

/**
 * 用户主动打开的文件 (选文件 / 拖入 / 系统打开 / 互传 / 链接): 书籍格式之外, 任意纯文本
 * (源码、配置、日志、README 等) 按 txt 入库, 打开时再按文件名选代码或散文排版.
 * 选文件夹、扫描书源等「找书」场景仍用 detectFormat, 免得把代码仓库整个扫进书架.
 */
export function detectReadableFormat(fileName: string): BookFormat | null {
  return detectFormat(fileName) ?? (textViewOf(fileName) ? 'txt' : null)
}

/** 文件选择框: 书籍扩展名 + 常见文本 MIME (其余文本文件可拖入或用系统「打开方式」) */
export const ACCEPT_READABLE = ACCEPT + ',text/*,application/json,application/xml,application/x-yaml,application/toml,application/javascript,application/x-sh'

/**
 * App 的文件选择框。Android 的选择器只认 MIME: wry 把 `.azw3` 这类扩展名查系统 MimeTypeMap, 查不到就丢掉,
 * 文件管理器又把 azw / azw3 报成 application/octet-stream 或 Kindle 的 MIME, 结果这些书在选择器里是灰的,
 * 读者只能改名成 .epub 才选得上 (2026-11-23 读者反馈)。这里把电子书的 MIME 列全, 再带上 octet-stream;
 * 多出来能选的其他文件由导入流程按扩展名和内容拒收。iOS 同理 (没有 UTI 的扩展名也选不上)。
 */
export const APP_BOOK_MIME_TYPES = [
  'application/epub+zip',
  'application/pdf',
  'application/x-mobipocket-ebook',
  'application/vnd.amazon.ebook',
  'application/vnd.amazon.mobi8-ebook',
  'application/x-mobi8-ebook',
  'application/x-fictionbook+xml',
  'application/x-fb2',
  'application/vnd.comicbook+zip',
  'application/vnd.comicbook-rar',
  'application/x-cbz',
  'application/x-cbr',
  'image/vnd.djvu',
  'image/x-djvu',
  'application/zip',
  'text/markdown',
  'text/x-markdown',
  'application/octet-stream',
] as const
export const ACCEPT_APP = ACCEPT_READABLE + ',' + APP_BOOK_MIME_TYPES.join(',')

/** 书卡上的格式角标: 代码 / 配置类 txt 显示真实扩展名 (JSON / PY / Dockerfile …) */
export function formatLabelOf(book: { format: BookFormat; fileName?: string }): string {
  if (book.format === 'txt' && book.fileName && !/\.txt$/i.test(book.fileName)) {
    return plainTextLabel(book.fileName) || FORMAT_LABELS.txt
  }
  return FORMAT_LABELS[book.format]
}
