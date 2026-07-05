/** 藏书备份: 打包为 zip (manifest.json + 书籍文件 + 封面), 可跨端恢复 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { getStorage, type AnnotationRec, type BookMeta, type CatalogSourceRec } from '../storage'

interface Manifest {
  app: 'lightread'
  version: 1
  exportedAt: number
  books: Array<BookMeta & { fileEntry: string; coverEntry?: string }>
  annotations: AnnotationRec[]
  sources: CatalogSourceRec[]
}

export async function exportBackup(onProgress?: (msg: string) => void): Promise<Blob> {
  const storage = await getStorage()
  const books = await storage.listBooks()
  const entries: Record<string, Uint8Array> = {}
  const manifest: Manifest = {
    app: 'lightread',
    version: 1,
    exportedAt: Date.now(),
    books: [],
    annotations: [],
    sources: (await storage.listSources()).filter(s => !s.builtin),
  }

  for (const [i, book] of books.entries()) {
    onProgress?.(`打包 ${book.title} (${i + 1}/${books.length})`)
    const fileEntry = `files/${book.id}/${book.fileName}`
    const file = await storage.getBookFile(book.id)
    entries[fileEntry] = new Uint8Array(await file.arrayBuffer())
    let coverEntry: string | undefined
    const coverUrl = await storage.getCoverUrl(book.id)
    if (coverUrl) {
      const coverBlob = await (await fetch(coverUrl)).blob()
      coverEntry = `covers/${book.id}.jpg`
      entries[coverEntry] = new Uint8Array(await coverBlob.arrayBuffer())
    }
    manifest.books.push({ ...book, fileEntry, coverEntry })
    manifest.annotations.push(...(await storage.listAnnotations(book.id)))
  }

  onProgress?.('压缩中…')
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
  // 书籍本身已压缩过, 打包不再压缩, 速度优先
  const zipped = zipSync(entries, { level: 0 })
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
}

export async function importBackup(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<{ books: number; annotations: number; sources: number }> {
  const storage = await getStorage()
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const manifestRaw = entries['manifest.json']
  if (!manifestRaw) throw new Error('不是有效的轻阅备份文件 (缺少 manifest.json)')
  const manifest: Manifest = JSON.parse(strFromU8(manifestRaw))
  if (manifest.app !== 'lightread') throw new Error('不是轻阅的备份文件')

  const existing = await storage.listBooks()
  const existingKeys = new Set(existing.map(b => `${b.title}::${b.fileName}`))
  const idMap = new Map<string, string>()
  let bookCount = 0

  for (const [i, book] of manifest.books.entries()) {
    onProgress?.(`恢复 ${book.title} (${i + 1}/${manifest.books.length})`)
    if (existingKeys.has(`${book.title}::${book.fileName}`)) continue
    const data = entries[book.fileEntry]
    if (!data) continue
    const blob = new Blob([data.buffer as ArrayBuffer])
    const cover = book.coverEntry && entries[book.coverEntry]
      ? new Blob([entries[book.coverEntry].buffer as ArrayBuffer], { type: 'image/jpeg' })
      : undefined
    const { id: _oldId, hasCover: _hc, fileEntry: _fe, coverEntry: _ce, ...meta } = book
    const newId = await storage.addBook(meta, blob, cover)
    idMap.set(book.id, newId)
    bookCount++
  }

  let annoCount = 0
  for (const anno of manifest.annotations) {
    const newBookId = idMap.get(anno.bookId)
    if (!newBookId) continue
    const { id: _id, ...rest } = anno
    await storage.addAnnotation({ ...rest, bookId: newBookId })
    annoCount++
  }

  const existingSources = new Set((await storage.listSources()).map(s => s.url))
  let sourceCount = 0
  for (const source of manifest.sources) {
    if (existingSources.has(source.url)) continue
    const { id: _id, ...rest } = source
    // 兼容旧版备份 (无 kind 字段)
    await storage.addSource({ ...rest, kind: rest.kind ?? 'opds' })
    sourceCount++
  }

  return { books: bookCount, annotations: annoCount, sources: sourceCount }
}
