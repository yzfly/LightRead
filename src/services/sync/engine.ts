/**
 * 同步编排: 读本地库 → 拉远端 → 合并 → 落地 → 写本机文档 + 基线 → 上传文件.
 * 流程见 docs/sync.md. 本模块顶层不依赖 vue / pinia, 依赖全部注入, 可在 node 里测试.
 */
import type { BookMeta, CatalogSourceRec, LibraryStorage, NewBookMeta } from '../../storage/types'
import { baselineUsableFor, nextBaselineRemotes, type SyncStore } from './baseline.ts'
import {
  annotationFrom, bookMetaFrom, buildLocalDoc, mergeDocs, mergeReadingLog, mergeSettingRegs, planApply, progressFrom,
  sourceFrom, sourceKey, wantedFrom,
} from './merge.ts'
import { buildSettingsRegs, planSettingsApply } from './settingsSync.ts'
import { sha256Blob } from './hash.ts'
import { isUnreachableError } from './types.ts'
import {
  aggregateReadingLog, planReadingLogLanding, type ReadingLogRow, type ReadingLogSyncPort,
} from '../readingLog.ts'
import type {
  ApplyOp, BookMetaVal, LocalState, ProgressVal, SettingsSyncPort, SyncDoc, SyncRemote, SyncResult,
} from './types'

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string

export interface SyncDeps {
  storage: LibraryStorage
  remote: SyncRemote
  store: SyncStore
  /** 上传 / 下载书籍文件 */
  syncFiles: boolean
  now?: () => number
  deviceName?: string
  app?: string
  onProgress?: (msg: string) => void
  t?: TranslateFn
  /** 删除本地书籍 (默认 storage.deleteBook; 应用里换成会清理论文 Agent 数据的 store 动作) */
  deleteBook?: (id: string) => Promise<void>
  /** 每日阅读记录 (不提供则不读写本地记录, 远端已有的记录照样合并保留) */
  readingLog?: ReadingLogSyncPort
  /**
   * 应用设置 (不提供 = 本机关闭了「同步设置」: 不发出本机设置也不落地, 远端已有的设置照样合并转写).
   * 规则见 settingsSync.ts 与 docs/sync.md「设置同步」.
   */
  settings?: SettingsSyncPort
}

export { sha256Hex } from './hash.ts'

/** 本地库快照 + 反查表 */
interface LocalScan {
  state: LocalState
  /** hash → 本地 id 列表 (首个为规范的那本, 即 addedAt 最早) */
  idsByHash: Map<string, string[]>
  /** 书单 id (本地已有) */
  booklistIds: Set<string>
  /** 自定义书源 sourceKey → 本地 id 列表 (首个为规范的那条, 即 addedAt 最早) */
  sourceIdsByKey: Map<string, string[]>
  /** 所有书源的 sourceKey (含内置: 与内置书源同地址的自定义书源不会落地) */
  allSourceKeys: Set<string>
  /** 私密书 (noSync) 的 hash (已知的): 不在 state 里, 远端针对它们的改动也不落地 */
  privateHashes: Set<string>
  /** 私密书的本地 id */
  privateIds: Set<string>
}

async function scanLocal(
  storage: LibraryStorage,
  store: SyncStore,
  progress: (msg: string) => void,
  tr: TranslateFn,
): Promise<LocalScan> {
  const all = await storage.listBooks()
  const cache = await store.getHashes()
  // 私密书不参与同步: 不算指纹 (只用缓存里已有的), 同内容的书只要有一本私密, 这份内容整体按私密处理
  const privateIds = new Set(all.filter(b => b.noSync).map(b => b.id))
  const privateHashes = new Set<string>()
  for (const id of privateIds) {
    const h = cache.get(id)
    if (h) privateHashes.add(h)
  }
  const books = all.filter(b => !privateIds.has(b.id) && !privateHashes.has(cache.get(b.id) ?? ''))
  const hashById = new Map<string, string>()
  const missing = books.filter(b => !cache.has(b.id))
  for (const b of books) {
    const h = cache.get(b.id)
    if (h) hashById.set(b.id, h)
  }
  let done = 0
  for (const b of missing) {
    progress(tr('sync.phase.hash', { done, total: missing.length }))
    try {
      // 不把整本书读进内存: 桌面 / 安卓原生读盘算, 网页按块算 (几十 MB 的书曾在这里卡死、闪退)
      const hash = storage.hashBookFile
        ? await storage.hashBookFile(b.id)
        : await sha256Blob(await storage.getBookFile(b.id))
      hashById.set(b.id, hash)
      await store.setHash(b.id, hash)
    } catch (err) {
      // 文件缺失 / 读不出: 这本书不参与同步
      console.warn('[sync] hash failed', b.id, err)
    }
    done++
  }

  // 同一 hash 多本时取 addedAt 最早的一本为规范
  const byHash = new Map<string, BookMeta[]>()
  for (const b of books) {
    const h = hashById.get(b.id)
    if (!h || privateHashes.has(h)) continue
    const list = byHash.get(h) ?? []
    list.push(b)
    byHash.set(h, list)
  }
  const state: LocalState = {
    books: {}, annotations: {}, booklists: {}, booklistItems: {}, booklistWanted: {}, sources: {}, sourceTimes: {},
  }
  const idsByHash = new Map<string, string[]>()
  for (const [hash, list] of byHash) {
    list.sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id))
    const b = list[0]
    idsByHash.set(hash, list.map(x => x.id))
    state.books[hash] = {
      id: b.id,
      meta: bookMetaFrom(b),
      progress: progressFrom(b),
      readingSeconds: b.readingSeconds ?? 0,
      hasCover: b.hasCover,
    }
  }

  for (const [hash, book] of Object.entries(state.books)) {
    for (const a of await storage.listAnnotations(book.id)) {
      state.annotations[a.id] = annotationFrom(a, hash)
    }
  }

  const booklistIds = new Set<string>()
  for (const bl of await storage.listBooklists()) {
    booklistIds.add(bl.id)
    state.booklists[bl.id] = { name: bl.name, createdAt: bl.createdAt }
    for (const item of await storage.listBooklistItems(bl.id)) {
      const hash = hashById.get(item.bookId)
      if (!hash || !idsByHash.has(hash)) continue
      const key = `${bl.id}|${hash}`
      const prev = state.booklistItems[key]
      if (!prev || item.addedAt < prev.addedAt) {
        state.booklistItems[key] = { booklistId: bl.id, bookHash: hash, addedAt: item.addedAt }
      }
    }
  }

  for (const w of await storage.listBooklistWanted()) {
    if (booklistIds.has(w.booklistId)) state.booklistWanted![w.id] = wantedFrom(w)
  }

  // 自定义书源 (私人书库等) 按规范化地址归并; 同一地址多条时取 addedAt 最早的一条为规范, 内置书源不同步
  const sourceIdsByKey = new Map<string, string[]>()
  const allSourceKeys = new Set<string>()
  const builtinSourceKeys = new Set<string>()
  const customSources = (await storage.listSources())
    .filter(s => {
      allSourceKeys.add(sourceKey(s.url))
      if (s.builtin) builtinSourceKeys.add(sourceKey(s.url))
      return !s.builtin
    })
    .sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id))
  state.builtinSourceKeys = [...builtinSourceKeys].sort()
  for (const s of customSources) {
    const key = sourceKey(s.url)
    if (!key) continue
    const ids = sourceIdsByKey.get(key)
    if (ids) {
      ids.push(s.id)
      continue
    }
    sourceIdsByKey.set(key, [s.id])
    state.sources[key] = sourceFrom(s)
    const t = s.updatedAt ?? s.addedAt
    if (Number.isFinite(t)) state.sourceTimes![key] = t
  }

  return { state, idsByHash, booklistIds, sourceIdsByKey, allSourceKeys, privateHashes, privateIds }
}

/** 操作涉及的书 (hash); 与书无关的操作返回 undefined */
function opHash(op: ApplyOp): string | undefined {
  switch (op.op) {
    case 'addBook': case 'deleteBook': case 'updateBook':
    case 'addBooklistItem': case 'removeBooklistItem':
      return op.hash
    case 'addAnnotation':
      return op.value.bookHash
    default:
      return undefined
  }
}

function newBookMeta(meta: BookMetaVal, progress: ProgressVal, readingSeconds: number): NewBookMeta {
  const out: NewBookMeta = {
    title: meta.title,
    author: meta.author,
    format: meta.format,
    fileName: meta.fileName,
    tags: [...meta.tags],
    addedAt: meta.addedAt,
    kind: meta.kind,
    readingSeconds: Math.max(0, Math.round(readingSeconds)),
  }
  if (meta.description !== undefined) out.description = meta.description
  if (meta.language !== undefined) out.language = meta.language
  if (meta.source !== undefined) out.source = meta.source
  if (meta.pinnedAt) out.pinnedAt = meta.pinnedAt
  if (progress.location !== undefined) out.location = progress.location
  if (progress.progress !== undefined) out.progress = progress.progress
  if (progress.lastReadAt !== undefined) out.lastReadAt = progress.lastReadAt
  return out
}

/** 读封面: 走 getCoverUrl (Object URL / data URL) 再 fetch 成 Blob; 失败视为无封面 */
async function readCover(storage: LibraryStorage, id: string): Promise<Blob | undefined> {
  try {
    const url = await storage.getCoverUrl(id)
    if (!url) return undefined
    const blob = await (await fetch(url)).blob()
    return blob.size ? blob : undefined
  } catch {
    return undefined
  }
}

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const { storage, remote, store } = deps
  const now = deps.now ?? Date.now
  const tr: TranslateFn = deps.t ?? (await import('../../i18n/index.ts')).t
  const progress = (msg: string) => deps.onProgress?.(msg)
  const removeBook = deps.deleteBook ?? ((id: string) => storage.deleteBook(id))
  const canFiles = deps.syncFiles && remote.supportsFiles

  const deviceId = await store.getDeviceId()

  // 1. 本地快照
  progress(tr('sync.phase.scan'))
  const scan = await scanLocal(storage, store, progress, tr)
  const local = scan.state

  // 2-3. 远端文档, 生成本机文档, 合并
  progress(tr('sync.phase.fetch'))
  await remote.prepare()
  const remoteDocs = await remote.listDocs()
  const remoteFiles = canFiles ? await remote.listFiles() : new Set<string>()
  // 基线在各远端间共用; 换成同类的另一个远端 (换网盘 / 换账号) 时作废, 按首次同步处理
  const saved = await store.loadBaseline()
  const baseline = saved && baselineUsableFor(saved, remote) ? saved : null

  const stampNow = now()
  const ctx = { deviceId, now: stampNow }
  const remoteMerged = remoteDocs.length ? mergeDocs(remoteDocs, ctx) : null
  // 私密书不算「上次在本地」: 本地快照里没有它们, 否则会被当成删除, 连带删掉其他设备上的这本书
  const presentBefore = new Set((baseline?.presentHashes ?? []).filter(h => !scan.privateHashes.has(h)))
  const localDoc = buildLocalDoc(
    local,
    baseline?.doc ?? null,
    presentBefore,
    remoteMerged,
    { deviceId, now: stampNow, deviceName: deps.deviceName, app: deps.app },
  )
  // 每日阅读记录: 本地行按 id→hash 聚合成 设备→日期→hash→秒, 与基线一起并入本机文档
  const hashById = deps.readingLog ? await store.getHashes() : new Map<string, string>()
  const logRows: ReadingLogRow[] = deps.readingLog ? await deps.readingLog.list() : []
  const localLog = aggregateReadingLog(logRows, hashById)
  // 私密书在本机新读的时长不发出 (文档里只保留基线已有的值); 落地时仍按完整的本地记录比较, 不会重复补记
  const publicHashById = new Map([...hashById].filter(([id, hash]) =>
    !scan.privateIds.has(id) && !scan.privateHashes.has(hash)))
  const ownLog = mergeReadingLog(baseline?.doc.readingLog, aggregateReadingLog(
    logRows.filter(r => !(r.hash && scan.privateHashes.has(r.hash))), publicHashById))
  if (ownLog) localDoc.readingLog = ownLog
  // 设置: 本机各项 (按修改时间打 stamp) 与基线里已知的设置一起并入本机文档
  const localSettings = deps.settings ? await deps.settings.read() : null
  const ownSettings = mergeSettingRegs(
    baseline?.doc.settings,
    localSettings ? buildSettingsRegs(localSettings, deviceId, deps.settings!.includeSecrets) : undefined,
  )
  if (ownSettings) localDoc.settings = ownSettings
  const merged = mergeDocs([localDoc, ...remoteDocs], ctx)

  // 4. 落地
  progress(tr('sync.phase.apply'))
  // 别的设备对私密书的改动 (含删除、新标注、书单归属) 不落地, 也不把它当成缺失的书去下载
  const ops = planApply(merged, local).filter(op => !scan.privateHashes.has(opHash(op) ?? ''))
  const present = new Set(scan.idsByHash.keys())
  let applied = 0
  let downloadedBooks = 0
  let pendingBooks = 0
  const idOf = (hash: string) => scan.idsByHash.get(hash)?.[0]

  /**
   * 下载并校验一本书, 收进本地库, 返回本地 id; 下载 / 校验失败返回 null (保持「仅元数据」, 下次再试),
   * 写本地库失败则抛错 (整次同步失败). 能直接写盘的后端 + 存储 (桌面 / 安卓) 书的内容不进 JS.
   */
  async function downloadBook(op: Extract<ApplyOp, { op: 'addBook' }>): Promise<string | null> {
    const coverName = `${op.hash}.cover`
    const getCover = async () => remoteFiles.has(coverName)
      ? (await remote.getFile(coverName).catch(() => null)) ?? undefined
      : undefined
    const meta = newBookMeta(op.meta, op.progress, op.readingSeconds)
    if (remote.downloadFileTo && storage.stageBookFile && storage.addBookFromStaged) {
      const staged = await storage.stageBookFile(op.hash)
      let ok = false
      let cover: Blob | undefined
      try {
        const res = await remote.downloadFileTo(op.hash, staged)
        ok = res?.sha256 === op.hash
        if (ok) cover = await getCover()
      } catch (err) {
        console.warn('[sync] download failed', op.hash, err)
      }
      if (!ok) {
        await storage.discardStaged?.(staged).catch(() => { /* 残留的暂存文件下次覆盖 */ })
        return null
      }
      return storage.addBookFromStaged(meta, staged, cover)
    }
    let file: Blob | null
    let cover: Blob | undefined
    try {
      file = await remote.getFile(op.hash)
      cover = await getCover()
    } catch (err) {
      console.warn('[sync] download failed', op.hash, err)
      file = null
    }
    if (!file || await sha256Blob(file) !== op.hash) return null
    return storage.addBook(meta, file, cover)
  }

  async function applyOp(op: ApplyOp): Promise<boolean> {
    switch (op.op) {
      case 'addBook': {
        if (scan.idsByHash.has(op.hash)) return false
        if (!canFiles || !remoteFiles.has(op.hash)) {
          pendingBooks++
          return false
        }
        progress(tr('sync.phase.download', { title: op.meta.title }))
        const id = await downloadBook(op)
        if (!id) {
          pendingBooks++
          return false
        }
        await store.setHash(id, op.hash)
        scan.idsByHash.set(op.hash, [id])
        present.add(op.hash)
        downloadedBooks++
        return true
      }
      case 'deleteBook': {
        const ids = scan.idsByHash.get(op.hash)
        if (!ids?.length) return false
        for (const id of ids) await removeBook(id)
        scan.idsByHash.delete(op.hash)
        present.delete(op.hash)
        return true
      }
      case 'updateBook': {
        // 只改规范的那本 (同内容的重复导入保持各自的元数据)
        const id = idOf(op.hash)
        if (!id) return false
        await storage.updateBook(id, op.patch)
        return true
      }
      case 'addAnnotation': {
        const { bookHash, ...rest } = op.value
        const bookId = idOf(bookHash)
        if (!bookId) return false
        await storage.addAnnotation({ ...rest, id: op.id, bookId })
        return true
      }
      case 'updateAnnotation': {
        if (!(op.id in local.annotations)) return false
        await storage.updateAnnotation(op.id, op.patch)
        return true
      }
      case 'deleteAnnotation': {
        if (!(op.id in local.annotations)) return false
        await storage.deleteAnnotation(op.id)
        return true
      }
      case 'addBooklist': {
        await storage.createBooklist(op.value.name, { id: op.id, createdAt: op.value.createdAt })
        scan.booklistIds.add(op.id)
        return true
      }
      case 'renameBooklist': {
        if (!scan.booklistIds.has(op.id)) return false
        await storage.renameBooklist(op.id, op.name)
        return true
      }
      case 'deleteBooklist': {
        if (!scan.booklistIds.has(op.id)) return false
        await storage.deleteBooklist(op.id)
        scan.booklistIds.delete(op.id)
        return true
      }
      case 'addBooklistItem': {
        const bookId = idOf(op.hash)
        if (!bookId || !scan.booklistIds.has(op.booklistId)) return false
        const addedAt = merged.booklistItems[`${op.booklistId}|${op.hash}`]?.value?.addedAt
        await storage.addBooksToBooklist(op.booklistId, [bookId], { addedAt })
        return true
      }
      case 'removeBooklistItem': {
        const ids = scan.idsByHash.get(op.hash)
        if (!ids?.length || !scan.booklistIds.has(op.booklistId)) return false
        await storage.removeBooksFromBooklist(op.booklistId, ids)
        return true
      }
      case 'putWanted': {
        if (!scan.booklistIds.has(op.value.booklistId)) return false
        await storage.putBooklistWanted([{ ...op.value, id: op.id }])
        return true
      }
      case 'deleteWanted': {
        if (!(op.id in (local.booklistWanted ?? {}))) return false
        await storage.deleteBooklistWanted([op.id])
        return true
      }
      case 'addSource': {
        if (!op.key || scan.allSourceKeys.has(op.key)) return false
        const rec: Omit<CatalogSourceRec, 'id'> = { ...op.value, builtin: false, updatedAt: op.updatedAt }
        const id = await storage.addSource(rec)
        scan.allSourceKeys.add(op.key)
        scan.sourceIdsByKey.set(op.key, [id])
        return true
      }
      case 'updateSource': {
        // 只改规范的那条, 本地 id 不变 (搜索范围、上传目标等按 id 记的状态保留)
        const id = scan.sourceIdsByKey.get(op.key)?.[0]
        if (!id) return false
        await storage.updateSource(id, { ...op.value, updatedAt: op.updatedAt })
        return true
      }
      case 'deleteSource': {
        const ids = scan.sourceIdsByKey.get(op.key)
        if (!ids?.length) return false
        for (const id of ids) await storage.deleteSource(id)
        scan.sourceIdsByKey.delete(op.key)
        scan.allSourceKeys.delete(op.key)
        return true
      }
    }
  }

  for (const op of ops) {
    if (await applyOp(op)) applied++
  }

  // 阅读记录落地: 合并值比本地 (id 行 + h 行) 多出的差额补进 h 行
  if (deps.readingLog) {
    const landing = planReadingLogLanding(merged.readingLog, localLog)
    if (landing.length) {
      const titleOfHash = new Map<string, string>()
      for (const row of logRows) {
        const h = row.hash ?? (row.bookId ? hashById.get(row.bookId) : undefined)
        if (h && row.title && !titleOfHash.has(h)) titleOfHash.set(h, row.title)
      }
      await deps.readingLog.addSynced(landing.map(e => {
        const meta = merged.books[e.hash]?.meta.value ?? local.books[e.hash]?.meta
        return {
          ...e,
          title: meta?.title ?? titleOfHash.get(e.hash) ?? '',
          kind: meta?.kind === 'paper' ? 'paper' as const : 'book' as const,
        }
      }))
    }
  }

  // 设置落地: 只落比本机修改时间新的白名单项 (先于写文档, 落地失败则整次同步失败、不写基线)
  let settingsApplied = 0
  if (deps.settings && localSettings) {
    const entries = planSettingsApply(merged.settings, localSettings, deviceId)
    if (entries.length) {
      await deps.settings.apply(entries)
      settingsApplied = entries.filter(e => e.changed).length
    }
  }

  // 5. 先写本机文档与基线: 其他设备马上能看到元数据 (书文件没到位时保持「仅元数据」,
  //    文件传上去以后的下一次同步再下载); 上传中途被杀 / 切后台也不会丢掉这次的改动
  progress(tr('sync.phase.save'))
  const doc: SyncDoc = { ...merged, deviceId, writtenAt: now() }
  if (deps.deviceName !== undefined) doc.deviceName = deps.deviceName
  else delete doc.deviceName
  if (deps.app !== undefined) doc.app = deps.app
  else delete doc.app
  await remote.putDoc(doc)
  await store.saveBaseline({
    remoteId: remote.id,
    remotes: nextBaselineRemotes(saved, !!baseline, remote),
    doc: merged,
    presentHashes: [...present],
    syncedAt: now(),
  })

  // 6. 上传本地有、远端还没有的书籍文件与封面. 是否已上传以远端文件列表为准 (不记在文档 / 基线里),
  //    失败的逐本跳过, 下次同步再传
  let uploadedFiles = 0
  if (canFiles) {
    const uploads: { hash: string; id: string; needFile: boolean; needCover: boolean }[] = []
    for (const hash of present) {
      if (merged.books[hash]?.alive.value !== true) continue
      const id = idOf(hash)
      if (!id) continue
      const needFile = !remoteFiles.has(hash)
      const needCover = !remoteFiles.has(`${hash}.cover`) && !!local.books[hash]?.hasCover
      if (needFile || needCover) uploads.push({ hash, id, needFile, needCover })
    }
    for (const [i, { hash, id, needFile, needCover }] of uploads.entries()) {
      const title = merged.books[hash]?.meta.value?.title ?? local.books[hash]?.meta.title ?? hash
      progress(tr('sync.phase.upload', { title, done: i + 1, total: uploads.length }))
      try {
        if (needFile) {
          // 桌面 / 安卓: 只给文件路径, 由原生层读盘上传, 书的内容不进 JS
          const data = (await storage.getBookFileRef?.(id)) ?? await storage.getBookFile(id)
          await remote.putFile(hash, data)
          remoteFiles.add(hash)
          uploadedFiles++
        }
        if (needCover) {
          const cover = await readCover(storage, id)
          if (cover) {
            await remote.putFile(`${hash}.cover`, cover)
            remoteFiles.add(`${hash}.cover`)
            uploadedFiles++
          }
        }
      } catch (err) {
        // 单个文件失败不影响元数据同步, 下次再传; 网络断了就不再逐个试剩下的 (2026-11-07 日志: 断网时一轮 121 条)
        console.warn('[sync] upload failed', hash, err)
        if (isUnreachableError(err)) break
      }
    }
  }

  return {
    applied,
    downloadedBooks,
    uploadedFiles,
    pendingBooks,
    devices: new Set([deviceId, ...remoteDocs.map(d => d.deviceId)]).size,
    settingsApplied,
  }
}
