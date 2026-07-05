/** Web 端存储实现: IndexedDB (Dexie), 书籍与封面以 Blob 存库 */
import Dexie, { type Table } from 'dexie'
import type {
  AnnotationRec, BookMeta, CatalogSourceRec, LibraryStorage, NewBookMeta,
} from './types'
import { BUILTIN_SOURCES, newId } from './types'

interface BookRow extends BookMeta {
  /** Safari 的 IndexedDB 存 Blob 会报错, 统一存 ArrayBuffer */
  file: ArrayBuffer
  cover?: ArrayBuffer
}

/** 兼容旧数据 (Chromium 时期可能存的是 Blob) */
const toBlob = (data: ArrayBuffer | Blob, type?: string): Blob =>
  data instanceof Blob ? data : new Blob([data], type ? { type } : undefined)

class LightReadDB extends Dexie {
  books!: Table<BookRow, string>
  annotations!: Table<AnnotationRec, string>
  sources!: Table<CatalogSourceRec, string>

  constructor() {
    super('lightread')
    this.version(1).stores({
      books: 'id, title, author, format, addedAt, lastReadAt',
      annotations: 'id, bookId, createdAt',
      sources: 'id, url, addedAt',
    })
  }
}

const stripBlobs = ({ file, cover, ...meta }: BookRow): BookMeta => meta

export class DexieStorage implements LibraryStorage {
  readonly kind = 'indexeddb' as const
  private db = new LightReadDB()
  private coverUrls = new Map<string, string>()

  async init() {
    // 内置书源与代码中的清单同步 (处理内置源的增删调整)
    const builtinUrls = new Set(BUILTIN_SOURCES.map(s => s.url))
    const existing = await this.db.sources.toArray()
    for (const s of existing) {
      if (s.builtin && !builtinUrls.has(s.url)) await this.db.sources.delete(s.id)
    }
    const existingUrls = new Set(existing.map(s => s.url))
    for (const s of BUILTIN_SOURCES) {
      if (!existingUrls.has(s.url)) {
        await this.db.sources.add({ ...s, id: newId(), builtin: true, addedAt: Date.now() })
      }
    }
  }

  async listBooks() {
    const rows = await this.db.books.orderBy('addedAt').reverse().toArray()
    return rows.map(stripBlobs)
  }

  async getBook(id: string) {
    const row = await this.db.books.get(id)
    return row ? stripBlobs(row) : undefined
  }

  async addBook(meta: NewBookMeta, file: Blob, cover?: Blob) {
    const id = newId()
    await this.db.books.add({
      ...meta,
      id,
      hasCover: !!cover,
      file: await file.arrayBuffer(),
      cover: cover ? await cover.arrayBuffer() : undefined,
    })
    return id
  }

  async updateBook(id: string, patch: Partial<Omit<BookMeta, 'id'>>) {
    await this.db.books.update(id, patch)
  }

  async deleteBook(id: string) {
    await this.db.transaction('rw', this.db.books, this.db.annotations, async () => {
      await this.db.books.delete(id)
      await this.db.annotations.where('bookId').equals(id).delete()
    })
    const url = this.coverUrls.get(id)
    if (url) {
      URL.revokeObjectURL(url)
      this.coverUrls.delete(id)
    }
  }

  async getBookFile(id: string) {
    const row = await this.db.books.get(id)
    if (!row) throw new Error('书籍不存在')
    return toBlob(row.file)
  }

  async getCoverUrl(id: string) {
    const cached = this.coverUrls.get(id)
    if (cached) return cached
    const row = await this.db.books.get(id)
    if (!row?.cover) return undefined
    const url = URL.createObjectURL(toBlob(row.cover, 'image/jpeg'))
    this.coverUrls.set(id, url)
    return url
  }

  async listAnnotations(bookId: string) {
    return this.db.annotations.where('bookId').equals(bookId).sortBy('createdAt')
  }

  async addAnnotation(a: Omit<AnnotationRec, 'id'>) {
    const id = newId()
    await this.db.annotations.add({ ...a, id })
    return id
  }

  async updateAnnotation(id: string, patch: Partial<Omit<AnnotationRec, 'id' | 'bookId'>>) {
    await this.db.annotations.update(id, patch)
  }

  async deleteAnnotation(id: string) {
    await this.db.annotations.delete(id)
  }

  async listSources() {
    return this.db.sources.orderBy('addedAt').toArray()
  }

  async addSource(s: Omit<CatalogSourceRec, 'id'>) {
    const id = newId()
    await this.db.sources.add({ ...s, id })
    return id
  }

  async deleteSource(id: string) {
    await this.db.sources.delete(id)
  }
}
