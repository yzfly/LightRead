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
  /** 私密: 只留在本机, 不参与多端同步 (书、进度、标注、书单归属、阅读记录都不发出, 别的设备的改动也不落地) */
  noSync?: boolean
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
  /** 划线风格: underline 下划线 / squiggly 波浪线; 缺省为色块高亮 (services/highlightStyle.ts) */
  style?: 'underline' | 'squiggly'
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
  /** 最后一次被用户修改 (添加 / 编辑) 的时间; 缺省视为 addedAt. 多端同步按它做 LWW */
  updatedAt?: number
  /** HTTP Basic 鉴权 (可选, 用于需要登录的书源如 calibre-web) */
  username?: string
  password?: string
}

/** 用户创建的书单。书籍归属关系单独存储，删除书单不会删除书籍。 */
export interface BooklistRec {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface BooklistItemRec {
  bookId: string
  addedAt: number
}

/**
 * 书单里还不在藏书中的书 (「待找」). 匹配到藏书后由 library.refresh 自动转成书单条目并删除本条.
 * 设计见 docs/booklists.md.
 */
export interface BooklistWantedRec {
  /** 全局 UUID, 多端同步时沿用 */
  id: string
  booklistId: string
  title: string
  author: string
  isbn?: string
  /** 首次出版年, 负数为公元前 */
  year?: number
  note?: string
  /** 外文原名 / 原作者 (如「理想国」↔ The Republic / Plato), 参与匹配与「搜原名」 */
  originalTitle?: string
  originalAuthor?: string
  addedAt: number
}

/**
 * 书库里的本地文件 (桌面 / 安卓): 同步上传时由原生层直接从磁盘读取, 书的内容不经过 WebView.
 * root 为自定义书库根目录 (空 = 应用数据目录), rel 为 `books/<文件名>` 或 `covers/<文件名>`.
 */
export interface LocalFileRef {
  readonly kind: 'local-file'
  root: string
  rel: string
  /** 读成 Blob (原生上传不可用时的退路) */
  blob(): Promise<Blob>
}

export const isLocalFileRef = (v: unknown): v is LocalFileRef =>
  !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'local-file'

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
  /** 书籍文件的本地路径引用 (仅文件系统后端); 不支持时为 undefined */
  getBookFileRef?(id: string): Promise<LocalFileRef | undefined>
  /** 桌面: CBR 由原生层转成 CBZ 并缓存在书库, 返回缓存内容; 不支持 / 失败时 undefined (调用方退回 JS 转换) */
  getComicCbz?(id: string): Promise<Blob | undefined>
  /** 桌面: 正文类 TXT 由原生层转成 EPUB 并缓存 (与前端 convertToEpub 逐字节一致), 返回缓存; 不支持 / 失败时 undefined */
  getTextEpub?(id: string): Promise<Blob | undefined>
  /** 桌面: 原生读已入库 EPUB 的元数据与封面 (与 foliate + flattenMeta 一致); 不支持 / 失败时 undefined */
  getEpubMeta?(id: string): Promise<{ title: string; author: string; description: string; language: string; cover?: Blob } | undefined>
  /** 补设封面 (导入后由原生缓存取封面、修复损坏封面时用); 空 Blob 不算封面, 直接忽略 */
  setCover?(id: string, cover: Blob): Promise<void>
  /** 去掉封面 (删除封面文件并清「有封面」标记), 用于书里取不到封面时修正损坏的记录 */
  clearCover?(id: string): Promise<void>
  /** 书籍文件的 SHA-256 (同步指纹). 桌面 / 安卓由原生层读盘计算, 书的内容不进 JS; 缺省时由同步层分块计算 */
  hashBookFile?(id: string): Promise<string>
  /**
   * 同步下载的暂存文件 (书库 books/ 下, 名字由 tag 决定). 与 SyncRemote.downloadFileTo 配合:
   * 书由原生层直接下载到这里, 校验通过后 addBookFromStaged 收为新书, 否则 discardStaged.
   */
  stageBookFile?(tag: string): Promise<LocalFileRef>
  /** 原生复制本地文件到暂存区, 不通过 JS 回传文件内容。 */
  stageBookFromPath?(path: string): Promise<LocalFileRef>
  addBookFromStaged?(meta: NewBookMeta, staged: LocalFileRef, cover?: Blob): Promise<string>
  discardStaged?(staged: LocalFileRef): Promise<void>
  /** 返回可直接用于 <img src> 的 URL (Object URL), 由调用方缓存; 无封面或封面不是可显示的图片 (空文件等) 返回 undefined */
  getCoverUrl(id: string): Promise<string | undefined>

  listBooklists(): Promise<BooklistRec[]>
  /** opts.id / opts.createdAt: 同步时沿用其他设备的书单 id 与创建时间 */
  createBooklist(name: string, opts?: { id?: string; createdAt?: number }): Promise<string>
  renameBooklist(id: string, name: string): Promise<void>
  deleteBooklist(id: string): Promise<void>
  listBooklistBookIds(booklistId: string): Promise<string[]>
  /** 书单条目 (含加入时间), 按加入时间升序 */
  listBooklistItems(booklistId: string): Promise<BooklistItemRec[]>
  /** opts.addedAt: 同步时沿用其他设备的加入时间 (多本时依次 +1ms) */
  addBooksToBooklist(booklistId: string, bookIds: string[], opts?: { addedAt?: number }): Promise<void>
  removeBooksFromBooklist(booklistId: string, bookIds: string[]): Promise<void>
  /** 所有书单的待找条目, 按加入时间升序 */
  listBooklistWanted(): Promise<BooklistWantedRec[]>
  /** 新增或整体改写 (同 id 覆盖); 所属书单的 updatedAt 一并更新 */
  putBooklistWanted(recs: BooklistWantedRec[]): Promise<void>
  deleteBooklistWanted(ids: string[]): Promise<void>

  listAnnotations(bookId: string): Promise<AnnotationRec[]>
  /** a.id: 同步时沿用其他设备的标注 id (已存在则覆盖) */
  addAnnotation(a: Omit<AnnotationRec, 'id'> & { id?: string }): Promise<string>
  updateAnnotation(id: string, patch: Partial<Omit<AnnotationRec, 'id' | 'bookId'>>): Promise<void>
  deleteAnnotation(id: string): Promise<void>

  listSources(): Promise<CatalogSourceRec[]>
  addSource(s: Omit<CatalogSourceRec, 'id'>): Promise<string>
  /** 整体改写自定义书源的可编辑字段 (builtin 不变); username / password 缺省或为空串时清除 */
  updateSource(id: string, s: Omit<CatalogSourceRec, 'id' | 'builtin'>): Promise<void>
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
