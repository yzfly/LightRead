/**
 * 多端同步协议类型. 规则见 docs/sync.md.
 * 本文件是 merge (纯函数) / engine (编排) / remote (后端) 三者之间的契约.
 */
import type { AnnotationRec, BooklistWantedRec, BookMeta, CatalogSourceRec, LocalFileRef } from '../../storage/types'

export const SYNC_FORMAT = 1

/** 时间戳 + 设备 id; 先比 t, 相等比 d 字典序 */
export interface Stamp {
  t: number
  d: string
}

/** LWW 寄存器; value 为 null 表示已删除 (墓碑) */
export interface Reg<T> {
  value: T | null
  stamp: Stamp
}

/** 书的可同步元数据 (不含进度与时长) */
export interface BookMetaVal {
  title: string
  author: string
  format: BookMeta['format']
  fileName: string
  description?: string
  language?: string
  tags: string[]
  addedAt: number
  kind: 'book' | 'paper'
  source?: string
  /** 0 表示未置顶 */
  pinnedAt: number
}

export interface ProgressVal {
  location?: string
  progress?: number
  lastReadAt?: number
}

export interface BookSyncRec {
  meta: Reg<BookMetaVal>
  progress: Reg<ProgressVal>
  /** G-Counter: deviceId → 该设备贡献的阅读秒数 */
  reading: Record<string, number>
  /** 书是否存在 (value=false 即删除) */
  alive: Reg<boolean>
}

export type AnnotationVal = Omit<AnnotationRec, 'id' | 'bookId'> & { bookHash: string }

export interface BooklistVal {
  name: string
  createdAt: number
}

export interface BooklistItemVal {
  booklistId: string
  bookHash: string
  addedAt: number
}

/** 书单的待找条目 (还不在藏书里的书), 见 docs/booklists.md */
export type BooklistWantedVal = Omit<BooklistWantedRec, 'id'>

/** 自定义书源 (私人书库 / 自建 OPDS) 的可同步内容; updatedAt 不在值里, 它是寄存器 stamp.t 的来源 */
export type SourceVal = Omit<CatalogSourceRec, 'id' | 'builtin' | 'updatedAt'>

export interface SyncDoc {
  format: typeof SYNC_FORMAT
  deviceId: string
  deviceName?: string
  /** 写入方的应用版本 */
  app?: string
  writtenAt: number
  /** 键: 书籍内容 SHA-256 */
  books: Record<string, BookSyncRec>
  /** 键: 标注 id */
  annotations: Record<string, Reg<AnnotationVal>>
  /** 键: 书单 id */
  booklists: Record<string, Reg<BooklistVal>>
  /** 键: `${booklistId}|${bookHash}` */
  booklistItems: Record<string, Reg<BooklistItemVal>>
  /** 键: 待找条目 id. 可选: 旧客户端写的文档没有此字段 */
  booklistWanted?: Record<string, Reg<BooklistWantedVal>>
  /**
   * 键: 书源地址的规范化形式 (merge.sourceKey: 去掉内嵌账号、#片段、末尾斜杠, 协议/主机小写);
   * 旧客户端写的是原样 url, 合并时按 sourceKey 归一. 仅自定义书源, 含账号密码.
   * stamp.t 为该书源最后一次被修改的时间 (CatalogSourceRec.updatedAt), 删除为同步时间.
   */
  sources: Record<string, Reg<SourceVal>>
  /**
   * 每日阅读记录. G-Counter: 设备 → 日期 (该设备本地时区的 YYYY-MM-DD) → 书的 hash →
   * 该设备当天在该书上贡献的秒数; 合并取每个叶子的较大值. 可选: 旧客户端写的文档没有此字段.
   */
  readingLog?: ReadingLogDoc
  /**
   * 应用设置 (见 settingsSync.ts 与 docs/sync.md「设置同步」). 键为设置路径 ('reader.fontSize'、'webdavUrl'),
   * 每项一个 LWW 寄存器, stamp.t 为该项最后一次被用户修改的时间; value 不会是 null (设置没有删除).
   * 可选: 旧客户端写的文档没有此字段. 密钥项只在发送方开启「同步密码与密钥」时出现, 缺席表示「不变」.
   */
  settings?: SettingsDoc
}

export type SettingsDoc = Record<string, Reg<unknown>>

export type ReadingLogDoc = Record<string, Record<string, Record<string, number>>>

/** 本地库的规范化快照 (engine 从 LibraryStorage 读出, merge 只做纯计算) */
export interface LocalBook {
  /** 本地 BookMeta.id */
  id: string
  meta: BookMetaVal
  progress: ProgressVal
  /** 本地累计阅读秒数 */
  readingSeconds: number
  hasCover: boolean
}

export interface LocalState {
  /** 键: 内容 hash; 同一 hash 多本时取 addedAt 最早的一本 */
  books: Record<string, LocalBook>
  /** 键: 标注 id; 只含所属书在 books 里的标注 */
  annotations: Record<string, AnnotationVal>
  booklists: Record<string, BooklistVal>
  /** 键: `${booklistId}|${bookHash}` */
  booklistItems: Record<string, BooklistItemVal>
  /** 键: 待找条目 id; 只含所属书单在 booklists 里的条目. 缺省视为空 */
  booklistWanted?: Record<string, BooklistWantedVal>
  /** 键: sourceKey(url); 不含内置书源; 同一键多条时取 addedAt 最早的一条 */
  sources: Record<string, SourceVal>
  /** 键同 sources: 该书源的修改时间 (updatedAt ?? addedAt). 缺省时按同步时间打 stamp、首次同步远端优先 */
  sourceTimes?: Record<string, number>
  /**
   * 本机内置书源的 sourceKey. 别的设备同步来的、与内置书源同地址的自定义书源不落地 (内置的已经有了),
   * 也不因「本地没有」被当成删除.
   */
  builtinSourceKeys?: string[]
}

/** 上次同步后保存的基线 */
export interface SyncBaseline {
  /** 最近一次同步的远端 (SyncRemote.id); 基线对哪些远端有效见 baseline.ts 的 remotes */
  remoteId: string
  doc: SyncDoc
  /** 上次同步结束时本地实际拥有文件的书 */
  presentHashes: string[]
  syncedAt: number
}

/** 把合并结果落到本地库的操作 (hash 需由 engine 映射回本地 book id) */
export type ApplyOp =
  | { op: 'addBook'; hash: string; meta: BookMetaVal; progress: ProgressVal; readingSeconds: number }
  | { op: 'deleteBook'; hash: string }
  | { op: 'updateBook'; hash: string; patch: Partial<Omit<BookMeta, 'id' | 'hasCover'>> }
  | { op: 'addAnnotation'; id: string; value: AnnotationVal }
  | { op: 'updateAnnotation'; id: string; patch: Partial<Pick<AnnotationRec, 'note' | 'color'>> }
  | { op: 'deleteAnnotation'; id: string }
  | { op: 'addBooklist'; id: string; value: BooklistVal }
  | { op: 'renameBooklist'; id: string; name: string }
  | { op: 'deleteBooklist'; id: string }
  | { op: 'addBooklistItem'; booklistId: string; hash: string }
  | { op: 'removeBooklistItem'; booklistId: string; hash: string }
  | { op: 'putWanted'; id: string; value: BooklistWantedVal }
  | { op: 'deleteWanted'; id: string }
  | { op: 'addSource'; key: string; value: SourceVal; updatedAt: number }
  | { op: 'updateSource'; key: string; value: SourceVal; updatedAt: number }
  | { op: 'deleteSource'; key: string }

/**
 * 同步后端. WebDAV 与 (第二步的) 轻阅账号各实现一份.
 * 文件名: `<hash>` 为书籍文件, `<hash>.cover` 为封面.
 */
export interface SyncRemote {
  readonly kind: 'webdav' | 'account'
  /** 远端标识 (如 WebDAV 地址 + 用户名), 用于判断基线是否属于当前远端 */
  readonly id: string
  /** 是否能存放书籍文件 */
  readonly supportsFiles: boolean
  /** 确保目录等就绪 */
  prepare(): Promise<void>
  /** 读取所有设备的 SyncDoc (含本机旧文件); 损坏的文件跳过 */
  listDocs(): Promise<SyncDoc[]>
  putDoc(doc: SyncDoc): Promise<void>
  /** 已上传的文件名集合 */
  listFiles(): Promise<Set<string>>
  /** data 为书库本地文件引用时, 能直接读盘的后端 (桌面 / 安卓的 WebDAV) 不把内容读进 JS */
  putFile(name: string, data: Blob | LocalFileRef): Promise<void>
  /** 不存在返回 null */
  getFile(name: string): Promise<Blob | null>
  /**
   * 直接下载到书库里的暂存文件 (内容不进 JS), 返回 SHA-256 与字节数; 不存在返回 null.
   * 只有能写本地文件的后端 (桌面 / 安卓的 WebDAV) 提供.
   */
  downloadFileTo?(name: string, dest: LocalFileRef): Promise<{ sha256: string; size: number } | null>
}

/** 本机一项设置的修改时间; d 为空表示本机改的 (写文档时换成本机 deviceId), 否则为同步来源设备 */
export interface SettingStamp {
  t: number
  d?: string
}

/** 本机可同步设置的快照: 路径 → 值 (按预设取基准值, 见 settingsSync.readSyncedSettings), 路径 → 修改时间 */
export interface LocalSettings {
  values: Record<string, unknown>
  stamps: Record<string, SettingStamp>
}

/** 把合并结果里比本机新的设置落地; changed=false 表示值相同、只更新修改时间 */
export interface SettingsApplyEntry {
  path: string
  value: unknown
  stamp: Stamp
  changed: boolean
}

/** engine 读写本机设置的接口 (应用里由 settingsTracker 基于 pinia store 实现; 测试用纯对象) */
export interface SettingsSyncPort {
  /** 是否把密钥项 (WebDAV 密码、AI API Key) 写进本机文档 */
  readonly includeSecrets: boolean
  read(): LocalSettings | Promise<LocalSettings>
  apply(entries: SettingsApplyEntry[]): void | Promise<void>
}

export interface SyncResult {
  /** 应用到本地的操作数 */
  applied: number
  downloadedBooks: number
  uploadedFiles: number
  /** 只有元数据、本地还没有文件的书 */
  pendingBooks: number
  devices: number
  /** 从别的设备落地的设置项数 (值有变化的) */
  settingsApplied?: number
}

/** 远端连不上 (断网 / DNS / 连接被拒) 的错误: 同步引擎据此不再逐个尝试剩下的文件 (断网时一轮会报上百条) */
export function unreachableError(message: string): Error {
  return Object.assign(new Error(message), { networkUnreachable: true })
}
export const isUnreachableError = (err: unknown) => (err as { networkUnreachable?: unknown })?.networkUnreachable === true
