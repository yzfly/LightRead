/**
 * LightRead 藏书交换包。
 *
 * 当前导出是符合 OKF v0.1 的开放知识包；导入仍兼容早期 JSON v1/v2 备份。
 * 开放 Profile 见 docs/library-okf-profile.md。
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { parseDocument, stringify } from 'yaml'
import {
  getStorage,
  type AnnotationRec,
  type BookFormat,
  type BookMeta,
  type CatalogSourceRec,
} from '../storage'

const LEGACY_JSON_FORMAT = 'org.lightread.library'
const LEGACY_JSON_VERSION = 2
export const LIBRARY_ARCHIVE_EXTENSION = '.okf.zip'
export const OKF_VERSION = '0.1'
export const LIBRARY_OKF_PROFILE =
  'https://github.com/yzfly/LightRead/blob/main/docs/library-okf-profile.md#profile-version-10'

interface AssetDescriptor {
  path: string
  mediaType: string
  byteLength: number
  sha256: string
}

interface RestorableAsset {
  path: string
  mediaType?: string
  byteLength?: number
  sha256?: string
}

interface RestorableBook {
  meta: BookMeta
  content: RestorableAsset
  cover?: RestorableAsset
}

interface RestorableManifest {
  version: 1 | 2 | 'okf-0.1'
  books: RestorableBook[]
  annotations: AnnotationRec[]
  sources: CatalogSourceRec[]
}

const BOOK_FORMATS = new Set<BookFormat>([
  'epub', 'mobi', 'azw3', 'azw', 'fb2', 'fbz',
  'cbz', 'cbr', 'djvu', 'pdf', 'txt', 'html', 'md',
])

const MEDIA_TYPES: Record<BookFormat, string> = {
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.mobi8-ebook',
  azw: 'application/vnd.amazon.ebook',
  fb2: 'application/x-fictionbook+xml',
  fbz: 'application/x-fictionbook+zip',
  cbz: 'application/vnd.comicbook+zip',
  cbr: 'application/vnd.comicbook-rar',
  djvu: 'image/vnd.djvu',
  pdf: 'application/pdf',
  txt: 'text/plain',
  html: 'text/html',
  md: 'text/markdown',
}

function contentSuffix(format: BookFormat): string {
  return format === 'fbz' ? '.fb2.zip' : `.${format}`
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function describeAsset(
  path: string,
  mediaType: string,
  bytes: Uint8Array,
): Promise<AssetDescriptor> {
  return {
    path,
    mediaType,
    byteLength: bytes.byteLength,
    sha256: await sha256(bytes),
  }
}

function archiveError(message: string): never {
  throw new Error(`藏书包无效: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string')
  return typeof value === 'string' && value ? [value] : []
}

function toIso(value?: number): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString()
}

function toTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function okfDocument(frontmatter: Record<string, unknown>, body: string): Uint8Array {
  const yaml = stringify(compactRecord(frontmatter), { lineWidth: 0 }).trimEnd()
  return strToU8(`---\n${yaml}\n---\n\n${body.trim()}\n`)
}

function readOkfDocument(
  bytes: Uint8Array,
  path: string,
  frontmatterOptional = false,
): { frontmatter: Record<string, unknown>; body: string } {
  const text = strFromU8(bytes).replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) {
    if (frontmatterOptional) return { frontmatter: {}, body: text }
    archiveError(`${path} 缺少 YAML frontmatter`)
  }
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) archiveError(`${path} 的 YAML frontmatter 未闭合`)
  const document = parseDocument(text.slice(4, end), { prettyErrors: false })
  if (document.errors.length) archiveError(`${path} 的 YAML frontmatter 无法解析`)
  const frontmatter = document.toJS({ maxAliasCount: 20 }) as unknown
  if (!isRecord(frontmatter)) archiveError(`${path} 的 YAML frontmatter 必须是对象`)
  return { frontmatter, body: text.slice(end + 5) }
}

function normalizeBundlePath(value: string): string {
  const clean = value.split(/[?#]/, 1)[0].replace(/^\/+/, '')
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) archiveError(`不支持外部资源 ${value}`)
  const parts: string[] = []
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) archiveError(`资源路径越界 ${value}`)
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  if (!parts.length) archiveError(`资源路径无效 ${value}`)
  return parts.join('/')
}

function resolveConceptResource(conceptPath: string, value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) archiveError(`不支持外部资源 ${value}`)
  if (value.startsWith('/')) return normalizeBundlePath(value)
  const directory = conceptPath.includes('/')
    ? conceptPath.slice(0, conceptPath.lastIndexOf('/') + 1)
    : ''
  return normalizeBundlePath(directory + value)
}

function formatFromPath(path: string): BookFormat | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.fb2.zip')) return 'fbz'
  const extension = lower.split('.').pop()
  return extension && BOOK_FORMATS.has(extension as BookFormat)
    ? extension as BookFormat
    : undefined
}

function assetToOkf(
  asset: AssetDescriptor,
  name: string,
  format?: BookFormat,
): Record<string, unknown> {
  return compactRecord({
    path: asset.path,
    name,
    format,
    media_type: asset.mediaType,
    byte_length: asset.byteLength,
    sha256: asset.sha256,
  })
}

function parseOkfAsset(
  value: unknown,
  conceptPath: string,
  label: string,
  fallbackResource?: string,
): RestorableAsset {
  const record = optionalRecord(value)
  const declaredPath = optionalString(record?.path)
  const path = declaredPath
    ? normalizeBundlePath(declaredPath)
    : fallbackResource
      ? resolveConceptResource(conceptPath, fallbackResource)
      : archiveError(`${label}.path 缺失`)
  const byteLength = optionalNumber(record?.byte_length ?? record?.byteLength)
  const digest = optionalString(record?.sha256)?.toLowerCase()
  if (digest && !/^[0-9a-f]{64}$/.test(digest)) archiveError(`${label}.sha256 无效`)
  return {
    path,
    mediaType: optionalString(record?.media_type ?? record?.mediaType),
    byteLength,
    sha256: digest,
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function markdownQuote(value: string): string {
  return value.split(/\r?\n/).map(line => `> ${line}`).join('\n')
}

function markdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1')
}

/** 只接受存储层明确支持的字段，避免把包中的任意键写入数据库。 */
function parseBookMeta(value: unknown, index: number): BookMeta {
  if (!isRecord(value)) archiveError(`books[${index}] 不是对象`)
  const requiredStrings = ['id', 'title', 'format', 'fileName'] as const
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string' || !value[key]) {
      archiveError(`books[${index}].${key} 缺失`)
    }
  }
  if (typeof value.author !== 'string') {
    archiveError(`books[${index}].author 缺失`)
  }
  if (!BOOK_FORMATS.has(value.format as BookFormat)) {
    archiveError(`books[${index}].format 不受支持`)
  }
  if (!Array.isArray(value.tags) || !value.tags.every(tag => typeof tag === 'string')) {
    archiveError(`books[${index}].tags 必须是字符串数组`)
  }
  if (typeof value.addedAt !== 'number' || !Number.isFinite(value.addedAt)) {
    archiveError(`books[${index}].addedAt 缺失`)
  }

  return {
    id: value.id as string,
    title: value.title as string,
    author: value.author as string,
    format: value.format as BookFormat,
    fileName: value.fileName as string,
    description: optionalString(value.description),
    language: optionalString(value.language),
    tags: [...value.tags] as string[],
    addedAt: value.addedAt,
    lastReadAt: optionalNumber(value.lastReadAt),
    location: optionalString(value.location),
    progress: optionalNumber(value.progress),
    source: optionalString(value.source),
    hasCover: Boolean(value.hasCover),
    readingSeconds: optionalNumber(value.readingSeconds),
    pinnedAt: optionalNumber(value.pinnedAt),
    kind: value.kind === 'paper' ? 'paper' : 'book',
  }
}

function parseAsset(value: unknown, label: string, checksummed: boolean): RestorableAsset {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path) {
    archiveError(`${label}.path 缺失`)
  }
  if (checksummed) {
    if (typeof value.mediaType !== 'string' || !value.mediaType) {
      archiveError(`${label}.mediaType 缺失`)
    }
    if (typeof value.byteLength !== 'number' || value.byteLength < 0) {
      archiveError(`${label}.byteLength 无效`)
    }
    if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) {
      archiveError(`${label}.sha256 无效`)
    }
  }
  return {
    path: value.path,
    mediaType: optionalString(value.mediaType),
    byteLength: optionalNumber(value.byteLength),
    sha256: optionalString(value.sha256)?.toLowerCase(),
  }
}

function parseAnnotations(value: unknown): AnnotationRec[] {
  if (!Array.isArray(value)) archiveError('annotations 必须是数组')
  return value.map((item, index) => {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.bookId !== 'string'
      || typeof item.cfi !== 'string'
      || typeof item.text !== 'string'
      || typeof item.color !== 'string'
      || typeof item.createdAt !== 'number') {
      archiveError(`annotations[${index}] 字段不完整`)
    }
    return {
      id: item.id,
      bookId: item.bookId,
      kind: item.kind === 'bookmark' ? 'bookmark' : 'highlight',
      cfi: item.cfi,
      text: item.text,
      note: optionalString(item.note),
      color: item.color,
      createdAt: item.createdAt,
    }
  })
}

function parseSources(value: unknown, allowCredentials: boolean): CatalogSourceRec[] {
  if (!Array.isArray(value)) archiveError('sources 必须是数组')
  return value.map((item, index) => {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || typeof item.title !== 'string'
      || typeof item.url !== 'string'
      || typeof item.addedAt !== 'number') {
      archiveError(`sources[${index}] 字段不完整`)
    }
    return {
      id: item.id,
      title: item.title,
      url: item.url,
      kind: item.kind === 'arxiv' ? 'arxiv' : 'opds',
      builtin: Boolean(item.builtin),
      addedAt: item.addedAt,
      // v1 可能含有凭据，为保持旧备份可恢复而继续接受；v2 永不生成它们。
      username: allowCredentials ? optionalString(item.username) : undefined,
      password: allowCredentials ? optionalString(item.password) : undefined,
    }
  })
}

function parseManifest(raw: Uint8Array): RestorableManifest {
  let value: unknown
  try {
    value = JSON.parse(strFromU8(raw))
  } catch {
    archiveError('manifest.json 不是有效 JSON')
  }
  if (!isRecord(value)) archiveError('manifest.json 顶层必须是对象')

  if (value.format === LEGACY_JSON_FORMAT) {
    if (value.version !== LEGACY_JSON_VERSION) {
      archiveError(`不支持的格式版本 ${String(value.version)}`)
    }
    if (!Array.isArray(value.books)) archiveError('books 必须是数组')
    const books = value.books.map((item, index) => {
      const meta = parseBookMeta(item, index)
      const record = item as Record<string, unknown>
      return {
        meta,
        content: parseAsset(record.content, `books[${index}].content`, true),
        cover: record.cover == null
          ? undefined
          : parseAsset(record.cover, `books[${index}].cover`, true),
      }
    })
    return {
      version: 2,
      books,
      annotations: parseAnnotations(value.annotations),
      sources: parseSources(value.sources, false),
    }
  }

  if (value.app === 'lightread' && value.version === 1) {
    if (!Array.isArray(value.books)) archiveError('books 必须是数组')
    const books = value.books.map((item, index) => {
      const meta = parseBookMeta(item, index)
      const record = item as Record<string, unknown>
      if (typeof record.fileEntry !== 'string' || !record.fileEntry) {
        archiveError(`books[${index}].fileEntry 缺失`)
      }
      return {
        meta,
        content: { path: record.fileEntry as string },
        cover: typeof record.coverEntry === 'string'
          ? { path: record.coverEntry, mediaType: 'image/jpeg' }
          : undefined,
      }
    })
    return {
      version: 1,
      books,
      annotations: parseAnnotations(value.annotations),
      sources: parseSources(value.sources, true),
    }
  }

  archiveError('不是 LightRead 藏书包')
}

/**
 * 导入开放 OKF bundle。LightRead Profile 字段可完整恢复；其他生产者只要提供
 * Book/Publication concept 和本地 file/resource，也能以通用元数据导入。
 */
function parseOkfBundle(entries: Record<string, Uint8Array>): RestorableManifest {
  const rootIndex = entries['index.md']
  if (rootIndex) {
    const { frontmatter } = readOkfDocument(rootIndex, 'index.md', true)
    const declared = optionalString(frontmatter.okf_version)
    if (declared && declared !== OKF_VERSION) {
      archiveError(`暂不支持 OKF ${declared}`)
    }
  }

  const books: RestorableBook[] = []
  const annotations: AnnotationRec[] = []
  const sources: CatalogSourceRec[] = []
  const conceptEntries = Object.entries(entries)
    .filter(([path]) => path.endsWith('.md'))
    .filter(([path]) => !['index.md', 'log.md'].includes(path.split('/').pop() ?? ''))

  for (const [conceptPath, bytes] of conceptEntries) {
    const { frontmatter } = readOkfDocument(bytes, conceptPath)
    const type = optionalString(frontmatter.type)
    if (!type) archiveError(`${conceptPath} 缺少 OKF 必需字段 type`)
    const entity = optionalString(frontmatter.entity)?.toLowerCase()
    const typeLower = type.toLowerCase()

    if (entity === 'catalog' || typeLower.includes('catalog')) {
      const resource = optionalString(frontmatter.url ?? frontmatter.resource)
      if (!resource) continue
      sources.push({
        id: optionalString(frontmatter.id) ?? conceptPath,
        title: optionalString(frontmatter.title) ?? resource,
        url: resource,
        kind: frontmatter.catalog_kind === 'arxiv' ? 'arxiv' : 'opds',
        builtin: false,
        addedAt: toTimestamp(frontmatter.added_at ?? frontmatter.timestamp, Date.now()),
      })
      continue
    }

    const fileRecord = optionalRecord(frontmatter.file)
    const looksLikeBook = entity === 'book'
      || ['book', 'publication', 'paper', 'article'].some(name => typeLower.includes(name))
      || Boolean(fileRecord)
    if (!looksLikeBook) continue

    const resource = optionalString(frontmatter.resource)
    const content = parseOkfAsset(fileRecord, conceptPath, `${conceptPath}.file`, resource)
    const declaredFormat = optionalString(fileRecord?.format)
    const format = declaredFormat && BOOK_FORMATS.has(declaredFormat as BookFormat)
      ? declaredFormat as BookFormat
      : formatFromPath(content.path)
    if (!format) archiveError(`${conceptPath} 的书籍格式不受支持`)
    const fileName = optionalString(fileRecord?.name)
      ?? content.path.split('/').pop()
      ?? `book.${format}`
    const title = optionalString(frontmatter.title)
      ?? fileName.replace(/\.[^.]+$/, '')
    const authors = stringList(frontmatter.authors ?? frontmatter.author)
    const reading = optionalRecord(frontmatter.reading_state) ?? {}
    const addedAt = toTimestamp(
      reading.added_at ?? frontmatter.timestamp,
      Date.now(),
    )
    const id = optionalString(frontmatter.id) ?? conceptPath
    const cover = frontmatter.cover == null
      ? undefined
      : parseOkfAsset(frontmatter.cover, conceptPath, `${conceptPath}.cover`)
    const collection = optionalString(frontmatter.collection)

    books.push({
      meta: {
        id,
        title,
        author: authors.join(', '),
        format,
        fileName,
        description: optionalString(frontmatter.description),
        language: optionalString(frontmatter.language),
        tags: stringList(frontmatter.tags),
        addedAt,
        lastReadAt: reading.last_read_at == null
          ? undefined
          : toTimestamp(reading.last_read_at, addedAt),
        location: optionalString(reading.location),
        progress: optionalNumber(reading.progress),
        source: optionalString(frontmatter.provenance),
        hasCover: Boolean(cover),
        readingSeconds: optionalNumber(reading.reading_seconds),
        pinnedAt: reading.pinned_at == null
          ? undefined
          : toTimestamp(reading.pinned_at, addedAt),
        kind: collection === 'papers' || typeLower.includes('paper') ? 'paper' : 'book',
      },
      content: {
        ...content,
        mediaType: content.mediaType ?? MEDIA_TYPES[format],
      },
      cover,
    })

    const conceptAnnotations = Array.isArray(frontmatter.annotations)
      ? frontmatter.annotations
      : []
    for (const [annotationIndex, value] of conceptAnnotations.entries()) {
      if (!isRecord(value)) continue
      annotations.push({
        id: optionalString(value.id) ?? `${id}:annotation:${annotationIndex}`,
        bookId: id,
        kind: value.type === 'bookmark' ? 'bookmark' : 'highlight',
        cfi: optionalString(value.location ?? value.cfi) ?? '',
        text: optionalString(value.text) ?? '',
        note: optionalString(value.note),
        color: optionalString(value.color) ?? 'yellow',
        createdAt: toTimestamp(value.created_at, addedAt),
      })
    }
  }

  return { version: 'okf-0.1', books, annotations, sources }
}

async function verifyAsset(
  entries: Record<string, Uint8Array>,
  asset: RestorableAsset,
  label: string,
): Promise<Uint8Array> {
  const bytes = entries[asset.path]
  if (!bytes) archiveError(`${label} 缺少文件 ${asset.path}`)
  if (asset.byteLength !== undefined && bytes.byteLength !== asset.byteLength) {
    archiveError(`${label} 长度不匹配`)
  }
  if (asset.sha256 && await sha256(bytes) !== asset.sha256) {
    archiveError(`${label} SHA-256 校验失败`)
  }
  return bytes
}

function annotationKey(annotation: Omit<AnnotationRec, 'id' | 'bookId'>): string {
  return JSON.stringify([
    annotation.kind ?? 'highlight', annotation.cfi, annotation.text,
    annotation.note ?? '', annotation.color, annotation.createdAt,
  ])
}

export async function exportBackup(onProgress?: (msg: string) => void): Promise<Blob> {
  const storage = await getStorage()
  const books = await storage.listBooks()
  const entries: Record<string, Uint8Array> = {}
  const bookIndex: string[] = []

  for (const [index, book] of books.entries()) {
    onProgress?.(`打包 ${book.title} (${index + 1}/${books.length})`)
    const contentPath = `assets/books/${book.id}/content${contentSuffix(book.format)}`
    const file = await storage.getBookFile(book.id)
    const fileBytes = new Uint8Array(await file.arrayBuffer())
    entries[contentPath] = fileBytes
    const content = await describeAsset(contentPath, MEDIA_TYPES[book.format], fileBytes)

    let cover: AssetDescriptor | undefined
    const coverUrl = await storage.getCoverUrl(book.id)
    if (coverUrl) {
      const coverBlob = await (await fetch(coverUrl)).blob()
      const coverPath = `assets/books/${book.id}/cover.jpg`
      const coverBytes = new Uint8Array(await coverBlob.arrayBuffer())
      entries[coverPath] = coverBytes
      cover = await describeAsset(coverPath, coverBlob.type || 'image/jpeg', coverBytes)
    }

    const annotations = await storage.listAnnotations(book.id)
    const timestamp = Math.max(book.addedAt, book.lastReadAt ?? 0, book.pinnedAt ?? 0)
    const frontmatter = compactRecord({
      type: book.kind === 'paper' ? 'Scholarly Paper' : 'Book',
      title: book.title,
      description: book.description ? oneLine(book.description) : undefined,
      resource: `../${contentPath}`,
      tags: book.tags,
      timestamp: toIso(timestamp),
      profile: LIBRARY_OKF_PROFILE,
      entity: 'book',
      id: book.id,
      authors: book.author ? [book.author] : [],
      language: book.language,
      collection: book.kind === 'paper' ? 'papers' : 'books',
      provenance: book.source,
      file: assetToOkf(content, book.fileName, book.format),
      cover: cover ? assetToOkf(cover, 'cover.jpg') : undefined,
      reading_state: compactRecord({
        added_at: toIso(book.addedAt),
        last_read_at: toIso(book.lastReadAt),
        location: book.location,
        progress: book.progress,
        reading_seconds: book.readingSeconds,
        pinned_at: toIso(book.pinnedAt),
      }),
      annotations: annotations.map(annotation => compactRecord({
        id: annotation.id,
        type: annotation.kind ?? 'highlight',
        location: annotation.cfi,
        text: annotation.text,
        note: annotation.note,
        color: annotation.color,
        created_at: toIso(annotation.createdAt),
      })),
    })

    const body: string[] = [
      '# Bibliographic metadata',
      '',
      `- **Title:** ${book.title}`,
      `- **Authors:** ${book.author || 'Unknown'}`,
      `- **Language:** ${book.language || 'Unspecified'}`,
      `- **Format:** ${book.format.toUpperCase()}`,
      `- **Collection:** ${book.kind === 'paper' ? 'Papers' : 'Books'}`,
    ]
    if (book.description) body.push('', '# Description', '', book.description)
    body.push(
      '',
      '# Reading state',
      '',
      `- **Progress:** ${Math.round((book.progress ?? 0) * 100)}%`,
      `- **Reading time:** ${book.readingSeconds ?? 0} seconds`,
    )
    if (annotations.length) {
      body.push('', '# Annotations')
      for (const annotation of annotations) {
        body.push(
          '',
          `## ${annotation.kind === 'bookmark' ? 'Bookmark' : 'Highlight'} · ${toIso(annotation.createdAt)}`,
        )
        if (annotation.text) body.push('', markdownQuote(annotation.text))
        if (annotation.note) body.push('', annotation.note)
      }
    }
    body.push('', '# Resources', '', `- [Original file](../${contentPath})`)
    if (cover) body.push(`- [Cover](../${cover.path})`)

    const conceptPath = `books/${book.id}.md`
    entries[conceptPath] = okfDocument(frontmatter, body.join('\n'))
    const summary = oneLine(book.description ?? `${book.author || 'Unknown author'} · ${book.format.toUpperCase()}`)
    bookIndex.push(`* [${markdownLabel(book.title)}](${book.id}.md) - ${summary}`)
  }

  entries['books/index.md'] = strToU8(`# Books\n\n${bookIndex.join('\n') || 'No books.'}\n`)

  const catalogIndex: string[] = []
  const sources = (await storage.listSources()).filter(source => !source.builtin)
  for (const source of sources) {
    const conceptPath = `catalogs/${source.id}.md`
    const frontmatter = compactRecord({
      type: source.kind === 'arxiv' ? 'Scholarly Catalog' : 'OPDS Catalog',
      title: source.title,
      description: `An open ${source.kind === 'arxiv' ? 'scholarly' : 'publication'} catalog.`,
      resource: source.url,
      tags: ['catalog', source.kind],
      timestamp: toIso(source.addedAt),
      profile: LIBRARY_OKF_PROFILE,
      entity: 'catalog',
      id: source.id,
      catalog_kind: source.kind,
      url: source.url,
      added_at: toIso(source.addedAt),
    })
    entries[conceptPath] = okfDocument(frontmatter, [
      '# Catalog',
      '',
      `- **Name:** ${source.title}`,
      `- **Protocol:** ${source.kind === 'arxiv' ? 'arXiv API' : 'OPDS'}`,
      `- **URL:** ${source.url}`,
    ].join('\n'))
    catalogIndex.push(`* [${markdownLabel(source.title)}](${source.id}.md) - ${source.url}`)
  }
  if (catalogIndex.length) {
    entries['catalogs/index.md'] = strToU8(`# Catalogs\n\n${catalogIndex.join('\n')}\n`)
  }

  onProgress?.('压缩中…')
  const rootSections = [
    '# Books',
    '',
    `* [Books](books/) - ${books.length} publication${books.length === 1 ? '' : 's'}`,
  ]
  if (sources.length) {
    rootSections.push('', '# Catalogs', '', `* [Catalogs](catalogs/) - ${sources.length} catalog${sources.length === 1 ? '' : 's'}`)
  }
  rootSections.push('', `Exported by LightRead ${__APP_VERSION__} at ${new Date().toISOString()}.`)
  entries['index.md'] = okfDocument({ okf_version: OKF_VERSION }, rootSections.join('\n'))
  // 书籍文件通常已压缩，容器使用 store 模式，优先速度并避免无意义的重复压缩。
  const zipped = zipSync(entries, { level: 0 })
  return new Blob([zipped.buffer as ArrayBuffer], {
    type: 'application/zip',
  })
}

export async function importBackup(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<{ books: number; annotations: number; sources: number }> {
  const storage = await getStorage()
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const manifest = entries['index.md']
    ? parseOkfBundle(entries)
    : entries['manifest.json']
      ? parseManifest(entries['manifest.json'])
      : archiveError('缺少 OKF index.md 或旧版 manifest.json')

  // 在写入任何数据前验证所有载荷，防止损坏的包只恢复一半。
  onProgress?.('校验藏书包…')
  const payloads: Array<{ content: Uint8Array; cover?: Uint8Array }> = []
  for (const [index, book] of manifest.books.entries()) {
    const content = await verifyAsset(entries, book.content, `books[${index}].content`)
    const cover = book.cover
      ? await verifyAsset(entries, book.cover, `books[${index}].cover`)
      : undefined
    payloads.push({ content, cover })
  }

  const existing = await storage.listBooks()
  const existingByKey = new Map(existing.map(book => [
    `${book.title}::${book.fileName}`,
    book.id,
  ]))
  const idMap = new Map<string, string>()
  let bookCount = 0

  for (const [index, book] of manifest.books.entries()) {
    onProgress?.(`恢复 ${book.meta.title} (${index + 1}/${manifest.books.length})`)
    const duplicateId = existingByKey.get(`${book.meta.title}::${book.meta.fileName}`)
    if (duplicateId) {
      idMap.set(book.meta.id, duplicateId)
      continue
    }

    const payload = payloads[index]
    const blob = new Blob([new Uint8Array(payload.content)], {
      type: book.content.mediaType || MEDIA_TYPES[book.meta.format],
    })
    const cover = payload.cover
      ? new Blob([new Uint8Array(payload.cover)], {
        type: book.cover?.mediaType || 'image/jpeg',
      })
      : undefined
    const { id: _oldId, hasCover: _hasCover, ...meta } = book.meta
    const newId = await storage.addBook(meta, blob, cover)
    idMap.set(book.meta.id, newId)
    existingByKey.set(`${book.meta.title}::${book.meta.fileName}`, newId)
    bookCount++
  }

  // 已存在的书也可补齐缺失标注；用内容指纹保证重复导入幂等。
  const annotationKeys = new Map<string, Set<string>>()
  let annotationCount = 0
  for (const annotation of manifest.annotations) {
    const newBookId = idMap.get(annotation.bookId)
    if (!newBookId) continue
    let known = annotationKeys.get(newBookId)
    if (!known) {
      known = new Set((await storage.listAnnotations(newBookId)).map(existingAnnotation =>
        annotationKey(existingAnnotation)))
      annotationKeys.set(newBookId, known)
    }
    const { id: _id, bookId: _bookId, ...rest } = annotation
    const key = annotationKey(rest)
    if (known.has(key)) continue
    await storage.addAnnotation({ ...rest, bookId: newBookId })
    known.add(key)
    annotationCount++
  }

  const existingSources = new Set((await storage.listSources()).map(source => source.url))
  let sourceCount = 0
  for (const source of manifest.sources) {
    if (source.builtin || existingSources.has(source.url)) continue
    const { id: _id, ...rest } = source
    await storage.addSource({ ...rest, kind: rest.kind ?? 'opds' })
    existingSources.add(source.url)
    sourceCount++
  }

  return { books: bookCount, annotations: annotationCount, sources: sourceCount }
}
