/**
 * 桌面端存储实现 (Tauri 2):
 *  - 书籍与封面以原始文件形式存放在应用数据目录 books/ covers/ 下
 *  - 元数据用 SQLite 索引 (tauri-plugin-sql)
 */
import type {
  AnnotationRec, BooklistRec, BookMeta, CatalogSourceRec, LibraryStorage, NewBookMeta,
} from './types'
import { BUILTIN_SOURCES, getLibraryRoot, newId } from './types'

type SqlDatabase = {
  execute(sql: string, values?: unknown[]): Promise<unknown>
  select<T>(sql: string, values?: unknown[]): Promise<T>
}

interface BookRow {
  id: string
  title: string
  author: string
  format: string
  file_name: string
  description: string | null
  language: string | null
  tags: string
  added_at: number
  last_read_at: number | null
  location: string | null
  progress: number | null
  source: string | null
  has_cover: number
  reading_seconds: number | null
  pinned_at: number | null
  kind: string | null
}

const rowToMeta = (r: BookRow): BookMeta => ({
  id: r.id,
  title: r.title,
  author: r.author,
  format: r.format as BookMeta['format'],
  fileName: r.file_name,
  description: r.description ?? undefined,
  language: r.language ?? undefined,
  tags: JSON.parse(r.tags || '[]'),
  addedAt: r.added_at,
  lastReadAt: r.last_read_at ?? undefined,
  location: r.location ?? undefined,
  progress: r.progress ?? undefined,
  source: r.source ?? undefined,
  hasCover: !!r.has_cover,
  readingSeconds: r.reading_seconds ?? 0,
  pinnedAt: r.pinned_at ?? undefined,
  kind: r.kind === 'paper' ? 'paper' : 'book',
})

const META_COLUMNS: Record<string, string> = {
  title: 'title',
  author: 'author',
  fileName: 'file_name',
  description: 'description',
  language: 'language',
  lastReadAt: 'last_read_at',
  location: 'location',
  progress: 'progress',
  source: 'source',
  readingSeconds: 'reading_seconds',
  pinnedAt: 'pinned_at',
  kind: 'kind',
}

export class TauriStorage implements LibraryStorage {
  readonly kind = 'filesystem' as const
  private db!: SqlDatabase
  private fs!: typeof import('@tauri-apps/plugin-fs')
  /** 自定义书库根目录, 空为默认应用数据目录 */
  private root = ''
  private coverUrls = new Map<string, string>()

  /** 相对路径 → fs 插件的 (path, options); 自定义根目录时用绝对路径 */
  private loc(rel: string): [string, { baseDir?: number }] {
    return this.root
      ? [`${this.root}/${rel}`, {}]
      : [rel, { baseDir: this.fs.BaseDirectory.AppData }]
  }

  async init() {
    const [{ default: Database }, fs] = await Promise.all([
      import('@tauri-apps/plugin-sql'),
      import('@tauri-apps/plugin-fs'),
    ])
    this.fs = fs
    this.root = getLibraryRoot().replace(/\/+$/, '')
    this.db = await Database.load(
      this.root ? `sqlite:${this.root}/lightread.db` : 'sqlite:lightread.db')

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS books (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        format TEXT NOT NULL,
        file_name TEXT NOT NULL,
        description TEXT,
        language TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        added_at INTEGER NOT NULL,
        last_read_at INTEGER,
        location TEXT,
        progress REAL,
        source TEXT,
        has_cover INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        cfi TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        note TEXT,
        color TEXT NOT NULL DEFAULT 'yellow',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_annotations_book ON annotations(book_id);
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        builtin INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booklists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booklist_items (
        booklist_id TEXT NOT NULL,
        book_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (booklist_id, book_id)
      );
      CREATE INDEX IF NOT EXISTS idx_booklist_items_booklist
        ON booklist_items(booklist_id);
      CREATE INDEX IF NOT EXISTS idx_booklist_items_book
        ON booklist_items(book_id);
    `)

    for (const dir of ['books', 'covers']) {
      const [path, opts] = this.loc(dir)
      if (!(await this.fs.exists(path, opts))) {
        await this.fs.mkdir(path, { ...opts, recursive: true })
      }
    }

    // 列迁移: 旧库补充新增字段
    for (const ddl of [
      "ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'opds'",
      'ALTER TABLE sources ADD COLUMN username TEXT',
      'ALTER TABLE sources ADD COLUMN password TEXT',
      "ALTER TABLE annotations ADD COLUMN kind TEXT NOT NULL DEFAULT 'highlight'",
      'ALTER TABLE books ADD COLUMN reading_seconds INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE books ADD COLUMN pinned_at INTEGER',
      "ALTER TABLE books ADD COLUMN kind TEXT NOT NULL DEFAULT 'book'",
    ]) {
      await this.db.execute(ddl).catch(() => { /* 列已存在 */ })
    }

    // 内置书源与代码中的清单同步 (处理内置源的增删调整)
    const builtinUrls = BUILTIN_SOURCES.map(s => s.url)
    const rows = await this.db.select<Array<{ id: string; url: string; builtin: number }>>(
      'SELECT id, url, builtin FROM sources')
    for (const row of rows) {
      if (row.builtin && !builtinUrls.includes(row.url)) {
        await this.db.execute('DELETE FROM sources WHERE id = $1', [row.id])
      }
    }
    const existingUrls = new Set(rows.map(r => r.url))
    for (const s of BUILTIN_SOURCES) {
      if (!existingUrls.has(s.url)) {
        await this.db.execute(
          'INSERT INTO sources (id, title, url, kind, builtin, added_at) VALUES ($1, $2, $3, $4, 1, $5)',
          [newId(), s.title, s.url, s.kind, Date.now()])
      }
    }
  }

  private bookPath = (id: string, fileName: string) => {
    const ext = fileName.toLowerCase().endsWith('.fb2.zip')
      ? 'fb2.zip'
      : fileName.split('.').pop() || 'bin'
    return `books/${id}.${ext}`
  }
  private coverPath = (id: string) => `covers/${id}.jpg`

  async listBooks() {
    const rows = await this.db.select<BookRow[]>(
      'SELECT * FROM books ORDER BY added_at DESC')
    return rows.map(rowToMeta)
  }

  async getBook(id: string) {
    const rows = await this.db.select<BookRow[]>(
      'SELECT * FROM books WHERE id = $1', [id])
    return rows[0] ? rowToMeta(rows[0]) : undefined
  }

  async addBook(meta: NewBookMeta, file: Blob, cover?: Blob) {
    const id = newId()
    {
      const [path, opts] = this.loc(this.bookPath(id, meta.fileName))
      await this.fs.writeFile(path, new Uint8Array(await file.arrayBuffer()), opts)
    }
    if (cover) {
      const [path, opts] = this.loc(this.coverPath(id))
      await this.fs.writeFile(path, new Uint8Array(await cover.arrayBuffer()), opts)
    }
    await this.db.execute(
      `INSERT INTO books (id, title, author, format, file_name, description, language,
        tags, added_at, last_read_at, location, progress, source, has_cover, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, meta.title, meta.author, meta.format, meta.fileName,
        meta.description ?? null, meta.language ?? null, JSON.stringify(meta.tags),
        meta.addedAt, meta.lastReadAt ?? null, meta.location ?? null,
        meta.progress ?? null, meta.source ?? null, cover ? 1 : 0,
        meta.kind === 'paper' ? 'paper' : 'book'])
    return id
  }

  async updateBook(id: string, patch: Partial<Omit<BookMeta, 'id'>>) {
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'tags') {
        sets.push(`tags = $${values.length + 1}`)
        values.push(JSON.stringify(value))
      } else if (key in META_COLUMNS) {
        sets.push(`${META_COLUMNS[key]} = $${values.length + 1}`)
        values.push(value ?? null)
      }
    }
    if (!sets.length) return
    values.push(id)
    await this.db.execute(
      `UPDATE books SET ${sets.join(', ')} WHERE id = $${values.length}`, values)
  }

  async deleteBook(id: string) {
    const meta = await this.getBook(id)
    await this.db.execute('DELETE FROM annotations WHERE book_id = $1', [id])
    await this.db.execute('DELETE FROM booklist_items WHERE book_id = $1', [id])
    await this.db.execute('DELETE FROM books WHERE id = $1', [id])
    if (meta) {
      const [bookPath, bookOpts] = this.loc(this.bookPath(id, meta.fileName))
      await this.fs.remove(bookPath, bookOpts).catch(() => { /* 文件缺失不阻塞删除 */ })
      if (meta.hasCover) {
        const [coverPath, coverOpts] = this.loc(this.coverPath(id))
        await this.fs.remove(coverPath, coverOpts).catch(() => { /* 同上 */ })
      }
    }
    const url = this.coverUrls.get(id)
    if (url) {
      URL.revokeObjectURL(url)
      this.coverUrls.delete(id)
    }
  }

  async getBookFile(id: string) {
    const meta = await this.getBook(id)
    if (!meta) throw new Error('书籍不存在')
    const [path, opts] = this.loc(this.bookPath(id, meta.fileName))
    const bytes = await this.fs.readFile(path, opts)
    return new Blob([bytes.buffer as ArrayBuffer])
  }

  async getCoverUrl(id: string) {
    const cached = this.coverUrls.get(id)
    if (cached) return cached
    const meta = await this.getBook(id)
    if (!meta?.hasCover) return undefined
    try {
      const [path, opts] = this.loc(this.coverPath(id))
      const bytes = await this.fs.readFile(path, opts)
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' }))
      this.coverUrls.set(id, url)
      return url
    } catch {
      return undefined
    }
  }

  async listBooklists() {
    const rows = await this.db.select<Array<{
      id: string
      name: string
      created_at: number
      updated_at: number
    }>>('SELECT * FROM booklists ORDER BY created_at DESC')
    return rows.map((row): BooklistRec => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  async createBooklist(name: string) {
    const id = newId()
    const now = Date.now()
    await this.db.execute(
      'INSERT INTO booklists (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)',
      [id, name, now, now])
    return id
  }

  async renameBooklist(id: string, name: string) {
    await this.db.execute(
      'UPDATE booklists SET name = $1, updated_at = $2 WHERE id = $3',
      [name, Date.now(), id])
  }

  async deleteBooklist(id: string) {
    await this.db.execute('DELETE FROM booklist_items WHERE booklist_id = $1', [id])
    await this.db.execute('DELETE FROM booklists WHERE id = $1', [id])
  }

  async listBooklistBookIds(booklistId: string) {
    const rows = await this.db.select<Array<{ book_id: string }>>(
      'SELECT book_id FROM booklist_items WHERE booklist_id = $1 ORDER BY added_at',
      [booklistId])
    return rows.map(row => row.book_id)
  }

  async addBooksToBooklist(booklistId: string, bookIds: string[]) {
    const uniqueIds = [...new Set(bookIds)]
    if (!uniqueIds.length) return
    const now = Date.now()
    for (const [index, bookId] of uniqueIds.entries()) {
      await this.db.execute(
        `INSERT OR IGNORE INTO booklist_items (booklist_id, book_id, added_at)
         VALUES ($1, $2, $3)`,
        [booklistId, bookId, now + index])
    }
    await this.db.execute(
      'UPDATE booklists SET updated_at = $1 WHERE id = $2', [now, booklistId])
  }

  async removeBooksFromBooklist(booklistId: string, bookIds: string[]) {
    const uniqueIds = [...new Set(bookIds)]
    if (!uniqueIds.length) return
    for (const bookId of uniqueIds) {
      await this.db.execute(
        'DELETE FROM booklist_items WHERE booklist_id = $1 AND book_id = $2',
        [booklistId, bookId])
    }
    await this.db.execute(
      'UPDATE booklists SET updated_at = $1 WHERE id = $2',
      [Date.now(), booklistId])
  }

  async listAnnotations(bookId: string) {
    const rows = await this.db.select<Array<{
      id: string; book_id: string; kind: string | null; cfi: string; text: string
      note: string | null; color: string; created_at: number
    }>>('SELECT * FROM annotations WHERE book_id = $1 ORDER BY created_at', [bookId])
    return rows.map(r => ({
      id: r.id, bookId: r.book_id,
      kind: (r.kind ?? 'highlight') as AnnotationRec['kind'],
      cfi: r.cfi, text: r.text,
      note: r.note ?? undefined, color: r.color, createdAt: r.created_at,
    }))
  }

  async addAnnotation(a: Omit<AnnotationRec, 'id'>) {
    const id = newId()
    await this.db.execute(
      `INSERT INTO annotations (id, book_id, kind, cfi, text, note, color, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, a.bookId, a.kind ?? 'highlight', a.cfi, a.text, a.note ?? null, a.color, a.createdAt])
    return id
  }

  async updateAnnotation(id: string, patch: Partial<Omit<AnnotationRec, 'id' | 'bookId'>>) {
    if (patch.note !== undefined) {
      await this.db.execute('UPDATE annotations SET note = $1 WHERE id = $2', [patch.note ?? null, id])
    }
    if (patch.color !== undefined) {
      await this.db.execute('UPDATE annotations SET color = $1 WHERE id = $2', [patch.color, id])
    }
  }

  async deleteAnnotation(id: string) {
    await this.db.execute('DELETE FROM annotations WHERE id = $1', [id])
  }

  async listSources() {
    const rows = await this.db.select<Array<{
      id: string; title: string; url: string; kind: string; builtin: number
      added_at: number; username: string | null; password: string | null
    }>>('SELECT * FROM sources ORDER BY added_at')
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      url: r.url,
      kind: (r.kind || 'opds') as CatalogSourceRec['kind'],
      builtin: !!r.builtin,
      addedAt: r.added_at,
      username: r.username ?? undefined,
      password: r.password ?? undefined,
    }))
  }

  async addSource(s: Omit<CatalogSourceRec, 'id'>) {
    const id = newId()
    await this.db.execute(
      `INSERT INTO sources (id, title, url, kind, builtin, added_at, username, password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, s.title, s.url, s.kind, s.builtin ? 1 : 0, s.addedAt,
        s.username ?? null, s.password ?? null])
    return id
  }

  async deleteSource(id: string) {
    await this.db.execute('DELETE FROM sources WHERE id = $1', [id])
  }
}


/** 目标文件夹是否已有轻阅书库 */
export async function hasLibraryAt(root: string): Promise<boolean> {
  const fs = await import('@tauri-apps/plugin-fs')
  return fs.exists(`${root.replace(/\/+$/, '')}/lightread.db`)
}

/**
 * 把当前书库复制到新文件夹 (db + 书籍 + 封面).
 * 完成后由调用方写入 libraryRoot 设置并整页重载.
 */
export async function migrateLibraryTo(
  newRoot: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const fs = await import('@tauri-apps/plugin-fs')
  const root = newRoot.replace(/\/+$/, '')
  const currentRoot = getLibraryRoot().replace(/\/+$/, '')
  const srcLoc = (rel: string): [string, { baseDir?: number }] =>
    currentRoot ? [`${currentRoot}/${rel}`, {}] : [rel, { baseDir: fs.BaseDirectory.AppData }]
  // SQLite 主库在 AppConfig (macOS 上与 AppData 同目录, 其他平台不同)
  const srcDbLoc = (rel: string): [string, { baseDir?: number }] =>
    currentRoot ? [`${currentRoot}/${rel}`, {}] : [rel, { baseDir: fs.BaseDirectory.AppConfig }]

  for (const dir of ['books', 'covers']) {
    if (!(await fs.exists(`${root}/${dir}`))) {
      await fs.mkdir(`${root}/${dir}`, { recursive: true })
    }
  }

  onProgress?.('复制索引数据库…')
  for (const dbFile of ['lightread.db', 'lightread.db-wal', 'lightread.db-shm']) {
    const [src, opts] = srcDbLoc(dbFile)
    if (await fs.exists(src, opts)) {
      const bytes = await fs.readFile(src, opts)
      await fs.writeFile(`${root}/${dbFile}`, bytes)
    }
  }

  for (const dir of ['books', 'covers']) {
    const [srcDir, opts] = srcLoc(dir)
    if (!(await fs.exists(srcDir, opts))) continue
    const entries = await fs.readDir(srcDir, opts)
    let done = 0
    for (const entry of entries) {
      if (!entry.isFile) continue
      onProgress?.(`复制 ${dir} (${++done}/${entries.length})…`)
      const [srcFile, srcOpts] = srcLoc(`${dir}/${entry.name}`)
      const bytes = await fs.readFile(srcFile, srcOpts)
      await fs.writeFile(`${root}/${dir}/${entry.name}`, bytes)
    }
  }
  onProgress?.('迁移完成')
}
