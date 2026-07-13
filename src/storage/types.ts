/** 存储抽象层: Web 走 IndexedDB, 桌面 (Tauri) 走文件系统 + SQLite 索引 */

export type BookFormat =
  | 'epub' | 'mobi' | 'azw3' | 'azw' | 'fb2' | 'fbz'
  | 'cbz' | 'cbr' | 'djvu' | 'pdf' | 'txt' | 'html' | 'md'

export interface BookMeta {
  id: string
  title: string
  author: string
  format: BookFormat
  fileName: string
  description?: string
  language?: string
  tags: string[]
  addedAt: number
  lastReadAt?: number
  /** 阅读位置: EPUB 系为 CFI, PDF 为页码字符串 */
  location?: string
  /** 0-1 阅读进度, 书架展示用 */
  progress?: number
  /** 来源: 本地导入 / OPDS 书源名 */
  source?: string
  hasCover: boolean
  /** 累计阅读时长 (秒) */
  readingSeconds?: number
  /** 置顶时间戳, 0/缺省为未置顶; 越新越靠前 */
  pinnedAt?: number
  /** 归属: 藏书 (缺省) / 论文 */
  kind?: 'book' | 'paper'
}

export type NewBookMeta = Omit<BookMeta, 'id' | 'hasCover'>

export interface AnnotationRec {
  id: string
  bookId: string
  /** highlight: 划线高亮 (默认); bookmark: 书签 */
  kind?: 'highlight' | 'bookmark'
  /** EPUB CFI */
  cfi: string
  text: string
  /** 想法 / 笔记 */
  note?: string
  color: string
  createdAt: number
}

export interface CatalogSourceRec {
  id: string
  title: string
  url: string
  /** opds: 标准 OPDS 目录; arxiv: arXiv API 适配器 */
  kind: 'opds' | 'arxiv'
  builtin: boolean
  addedAt: number
  /** HTTP Basic 鉴权 (可选, 用于需要登录的书源如 calibre-web) */
  username?: string
  password?: string
}

export interface LibraryStorage {
  /** 后端名称, 设置页展示 */
  readonly kind: 'indexeddb' | 'filesystem'
  init(): Promise<void>

  listBooks(): Promise<BookMeta[]>
  getBook(id: string): Promise<BookMeta | undefined>
  addBook(meta: NewBookMeta, file: Blob, cover?: Blob): Promise<string>
  updateBook(id: string, patch: Partial<Omit<BookMeta, 'id'>>): Promise<void>
  deleteBook(id: string): Promise<void>
  getBookFile(id: string): Promise<Blob>
  /** 返回可直接用于 <img src> 的 URL (Object URL), 由调用方缓存, 无封面返回 undefined */
  getCoverUrl(id: string): Promise<string | undefined>

  listAnnotations(bookId: string): Promise<AnnotationRec[]>
  addAnnotation(a: Omit<AnnotationRec, 'id'>): Promise<string>
  updateAnnotation(id: string, patch: Partial<Omit<AnnotationRec, 'id' | 'bookId'>>): Promise<void>
  deleteAnnotation(id: string): Promise<void>

  listSources(): Promise<CatalogSourceRec[]>
  addSource(s: Omit<CatalogSourceRec, 'id'>): Promise<string>
  deleteSource(id: string): Promise<void>
}

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** 用户自定义的书库根目录 (桌面端); 空为默认应用数据目录.
 *  存储初始化早于 pinia 使用, 直接读 localStorage. */
export function getLibraryRoot(): string {
  try {
    const raw = localStorage.getItem('lightread-settings')
    return raw ? (JSON.parse(raw).libraryRoot ?? '') : ''
  } catch {
    return ''
  }
}

export const newId = () => crypto.randomUUID()

/** 内置书源, 启动时与库中记录同步 (以 url 为准增删) */
export const BUILTIN_SOURCES: Array<Pick<CatalogSourceRec, 'title' | 'url' | 'kind'>> = [
  { title: '古登堡计划 (Project Gutenberg)', url: 'https://www.gutenberg.org/ebooks.opds/', kind: 'opds' },
  { title: 'arXiv 论文', url: 'https://export.arxiv.org/api/query', kind: 'arxiv' },
]
