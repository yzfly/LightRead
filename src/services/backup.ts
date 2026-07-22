/**
 * LightRead 藏书交换包。
 *
 * v2 是带明确格式标识、版本和 SHA-256 完整性校验的 ZIP 容器；导入仍兼容
 * 早期的 v1 `lightread` 备份。规范见 docs/藏书交换格式.md。
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import {
  getStorage,
  type AnnotationRec,
  type BookFormat,
  type BookMeta,
  type CatalogSourceRec,
} from '../storage'

export const LIBRARY_ARCHIVE_FORMAT = 'org.lightread.library'
export const LIBRARY_ARCHIVE_VERSION = 2
export const LIBRARY_ARCHIVE_EXTENSION = '.lightread'

interface AssetDescriptor {
  path: string
  mediaType: string
  byteLength: number
  sha256: string
}

interface ManifestV2 {
  format: typeof LIBRARY_ARCHIVE_FORMAT
  version: typeof LIBRARY_ARCHIVE_VERSION
  exportedAt: string
  generator: {
    name: 'LightRead'
    version: string
  }
  books: Array<BookMeta & { content: AssetDescriptor; cover?: AssetDescriptor }>
  annotations: AnnotationRec[]
  /** 只导出公开书源信息，绝不包含 username/password。 */
  sources: Array<Omit<CatalogSourceRec, 'username' | 'password'>>
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
  version: 1 | 2
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

  if (value.format === LIBRARY_ARCHIVE_FORMAT) {
    if (value.version !== LIBRARY_ARCHIVE_VERSION) {
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
  const manifest: ManifestV2 = {
    format: LIBRARY_ARCHIVE_FORMAT,
    version: LIBRARY_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    generator: { name: 'LightRead', version: __APP_VERSION__ },
    books: [],
    annotations: [],
    sources: (await storage.listSources())
      .filter(source => !source.builtin)
      .map(({ username: _username, password: _password, ...source }) => source),
  }

  for (const [index, book] of books.entries()) {
    onProgress?.(`打包 ${book.title} (${index + 1}/${books.length})`)
    const contentPath = `books/${book.id}/content${contentSuffix(book.format)}`
    const file = await storage.getBookFile(book.id)
    const fileBytes = new Uint8Array(await file.arrayBuffer())
    entries[contentPath] = fileBytes
    const content = await describeAsset(contentPath, MEDIA_TYPES[book.format], fileBytes)

    let cover: AssetDescriptor | undefined
    const coverUrl = await storage.getCoverUrl(book.id)
    if (coverUrl) {
      const coverBlob = await (await fetch(coverUrl)).blob()
      const coverPath = `books/${book.id}/cover.jpg`
      const coverBytes = new Uint8Array(await coverBlob.arrayBuffer())
      entries[coverPath] = coverBytes
      cover = await describeAsset(coverPath, coverBlob.type || 'image/jpeg', coverBytes)
    }

    manifest.books.push({ ...book, hasCover: Boolean(cover), content, cover })
    manifest.annotations.push(...(await storage.listAnnotations(book.id)))
  }

  onProgress?.('压缩中…')
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  // 书籍文件通常已压缩，容器使用 store 模式，优先速度并避免无意义的重复压缩。
  const zipped = zipSync(entries, { level: 0 })
  return new Blob([zipped.buffer as ArrayBuffer], {
    type: 'application/vnd.lightread.library+zip',
  })
}

export async function importBackup(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<{ books: number; annotations: number; sources: number }> {
  const storage = await getStorage()
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const manifestRaw = entries['manifest.json']
  if (!manifestRaw) archiveError('缺少 manifest.json')
  const manifest = parseManifest(manifestRaw)

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
