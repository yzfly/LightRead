/**
 * 同步合并: 纯函数, 不碰存储与网络. 规则见 docs/sync.md.
 * 只允许 `import type`, 以便在 node --experimental-strip-types 下直接测试.
 */
import type { AnnotationRec, BooklistWantedRec, BookMeta, CatalogSourceRec } from '../../storage/types'
import type {
  AnnotationVal, ApplyOp, BooklistWantedVal, BookMetaVal, BookSyncRec, LocalState, ProgressVal, ReadingLogDoc, Reg,
  SettingsDoc, SourceVal, Stamp, SyncDoc,
} from './types'
import { storedHighlightStyle } from '../highlightStyle.ts'

// ---- 通用工具 ----

/** 键序无关、忽略 undefined 字段的稳定序列化; 用于判等与同 stamp 时的决胜 */
export function stableKey(v: unknown): string {
  if (v === null || typeof v !== 'object') return v === undefined ? 'undefined' : JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableKey).join(',')}]`
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`).join(',')}}`
}

export const same = (a: unknown, b: unknown) => stableKey(a) === stableKey(b)

const sortedKeys = (o: object) => Object.keys(o).sort()

/** 去掉 undefined 与空串的可选字段 (空串与缺省视为同一值, 避免来回抖动) */
function setOpt<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined | '') {
  if (value !== undefined && value !== '') target[key] = value as T[K]
}

const sumReading = (r: Record<string, number>) =>
  Object.values(r).reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0)

/** 先比 t, 相等比 d; a 新于 b 返回正数 */
export function cmpStamp(a: Stamp, b: Stamp): number {
  if (a.t !== b.t) return a.t > b.t ? 1 : -1
  if (a.d === b.d) return 0
  return a.d > b.d ? 1 : -1
}

/** LWW: 取 stamp 较新者; stamp 完全相同 (理论上不该发生) 时按值的稳定序列化决胜, 保证交换律 */
function lww<T>(a: Reg<T> | undefined, b: Reg<T> | undefined): Reg<T> | undefined {
  if (!a) return b
  if (!b) return a
  const c = cmpStamp(a.stamp, b.stamp)
  if (c !== 0) return c > 0 ? a : b
  return stableKey(a.value) >= stableKey(b.value) ? a : b
}

export function emptyDoc(deviceId: string, now: number): SyncDoc {
  return {
    format: 1,
    deviceId,
    writtenAt: now,
    books: {},
    annotations: {},
    booklists: {},
    booklistItems: {},
    sources: {},
  }
}

// ---- 规范化 ----

/** BookMeta → 规范化的可同步元数据 (缺省值补齐, undefined 字段去掉) */
export function bookMetaFrom(meta: BookMeta): BookMetaVal {
  const v: BookMetaVal = {
    title: meta.title,
    author: meta.author,
    format: meta.format,
    fileName: meta.fileName,
    tags: [...(meta.tags ?? [])],
    addedAt: meta.addedAt,
    kind: meta.kind === 'paper' ? 'paper' : 'book',
    pinnedAt: meta.pinnedAt ?? 0,
  }
  setOpt(v, 'description', meta.description)
  setOpt(v, 'language', meta.language)
  setOpt(v, 'source', meta.source)
  return v
}

export function progressFrom(meta: BookMeta): ProgressVal {
  const v: ProgressVal = {}
  setOpt(v, 'location', meta.location)
  setOpt(v, 'progress', meta.progress)
  setOpt(v, 'lastReadAt', meta.lastReadAt)
  return v
}

export function annotationFrom(a: AnnotationRec, bookHash: string): AnnotationVal {
  const v: AnnotationVal = {
    bookHash,
    kind: a.kind ?? 'highlight',
    cfi: a.cfi,
    text: a.text,
    color: a.color,
    createdAt: a.createdAt,
  }
  setOpt(v, 'note', a.note)
  setOpt(v, 'style', storedHighlightStyle(a.style))
  return v
}

/**
 * 书源在同步层的身份: 地址的规范化形式. 同一个书库在两台设备上各自添加 (末尾多一个斜杠、主机名大小写不同、
 * 地址里内嵌了账号) 时得到同一个键, 合并后只剩一条. 去掉内嵌账号、#片段、路径末尾的斜杠, 协议与主机小写,
 * 默认端口省略; 查询串保留. 不是 http(s) 地址时原样 (去首尾空白) 返回. 幂等.
 * 只用作键, 落地到本地的仍是用户填写的原地址 (SourceVal.url).
 */
export function sourceKey(url: string): string {
  const raw = String(url ?? '').trim()
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`
}

/** 把书源寄存器表的键归一成 sourceKey (旧客户端按原样 url 记键); 撞键时 LWW */
export function rekeySources(regs: Record<string, Reg<SourceVal>> | undefined): Record<string, Reg<SourceVal>> {
  const out: Record<string, Reg<SourceVal>> = {}
  for (const [k, reg] of Object.entries(regs ?? {})) {
    const key = sourceKey(k)
    out[key] = lww(out[key], reg)!
  }
  return out
}

/** 待找条目 → 规范化的可同步值 (空的可选字段去掉) */
export function wantedFrom(w: BooklistWantedRec): BooklistWantedVal {
  const v: BooklistWantedVal = { booklistId: w.booklistId, title: w.title, author: w.author ?? '', addedAt: w.addedAt }
  setOpt(v, 'isbn', w.isbn)
  if (typeof w.year === 'number' && Number.isFinite(w.year)) v.year = w.year
  setOpt(v, 'note', w.note)
  setOpt(v, 'originalTitle', w.originalTitle)
  setOpt(v, 'originalAuthor', w.originalAuthor)
  return v
}

export function sourceFrom(s: CatalogSourceRec): SourceVal {
  const v: SourceVal = { title: s.title, url: s.url, kind: s.kind, addedAt: s.addedAt }
  setOpt(v, 'username', s.username)
  setOpt(v, 'password', s.password)
  return v
}

// ---- 生成本机文档 ----

/**
 * 由本地状态生成本机的 SyncDoc. 规则见 docs/sync.md「本地改动」.
 * - 有基线且上次同步结束时书就在本地 (presentHashes): 与基线 diff, 变了的打新 stamp,
 *   消失的生成墓碑.
 * - 首次同步: 已同步过的记录 (远端有寄存器, 含墓碑) 远端优先, 原样沿用; 只有远端没有的记录打新 stamp.
 *   例外: 本地有的书总是存活 (复活远端已删的书), 不产生任何删除.
 * - 新落地的书 (有基线, 但上次不在本地, 如刚导入了仅元数据的书): 元数据沿用已同步的寄存器.
 * - 进度的 stamp.t 取 lastReadAt (从未读过取 0): 只有读得更晚才盖过已同步的进度.
 * @param base 上次同步的合并结果; null 表示首次同步
 * @param presentHashes 上次同步结束时本地拥有文件的书; base 为 null 时忽略
 * @param remoteMerged 远端所有设备文档的合并 (首次同步的对照、扣除他人计时); 可为 null
 */
export function buildLocalDoc(
  local: LocalState,
  base: SyncDoc | null,
  presentHashes: ReadonlySet<string>,
  remoteMerged: SyncDoc | null,
  ctx: { deviceId: string; now: number; deviceName?: string; app?: string },
): SyncDoc {
  const me = ctx.deviceId
  const now = ctx.now
  const doc: SyncDoc = base
    ? {
        ...emptyDoc(me, now),
        books: { ...base.books },
        annotations: { ...base.annotations },
        booklists: { ...base.booklists },
        booklistItems: { ...base.booklistItems },
        sources: rekeySources(base.sources),
      }
    : emptyDoc(me, now)
  const wanted: Record<string, Reg<BooklistWantedVal>> = base ? { ...(base.booklistWanted ?? {}) } : {}
  if (ctx.deviceName !== undefined) doc.deviceName = ctx.deviceName
  if (ctx.app !== undefined) doc.app = ctx.app

  const stamp = (t = now): Stamp => ({ t, d: me })
  /** diff 模式: 值未变沿用基线寄存器, 否则打新 stamp */
  const diff = <T>(prev: Reg<T> | undefined, value: T, t = now): Reg<T> =>
    prev && same(prev.value, value) ? prev : { value, stamp: stamp(t) }
  /** 采纳模式: 已同步过的寄存器 (含墓碑) 原样保留, 只有同步层没见过的记录才打新 stamp */
  const adopt = <T>(prev: Reg<T> | undefined, value: T): Reg<T> => prev ?? { value, stamp: stamp() }

  // 书
  for (const hash of sortedKeys(local.books)) {
    const lb = local.books[hash]
    const lastReadAt = lb.progress.lastReadAt ?? 0
    // 上次同步结束时就在本地的书按 diff 处理; 首次同步或新落地的书 (如刚导入了仅元数据的书) 采纳已同步的记录
    const diffMode = !!base && presentHashes.has(hash)
    const prev: BookSyncRec | undefined = diffMode ? base!.books[hash] : base?.books[hash] ?? remoteMerged?.books[hash]

    let meta: Reg<BookMetaVal>
    let progress: Reg<ProgressVal>
    if (diffMode) {
      meta = diff(prev?.meta, lb.meta)
      progress = diff(prev?.progress, lb.progress, Math.max(lastReadAt, (prev ? prev.progress.stamp.t : -1) + 1))
    } else {
      meta = prev?.meta.value ? prev.meta : { value: lb.meta, stamp: stamp() }
      // 进度仍按阅读时间: 本地读得比已同步的进度晚才胜出
      const p = prev?.progress
      progress = p && (same(p.value, lb.progress) || lastReadAt <= p.stamp.t)
        ? p
        : { value: lb.progress, stamp: stamp(lastReadAt) }
    }
    // 本地实际有这本书: 存活 (首次同步也会复活远端已删的书)
    const alive: Reg<boolean> = prev?.alive.value === true ? prev.alive : { value: true, stamp: stamp() }

    let reading: Record<string, number>
    const localTotal = Math.max(0, lb.readingSeconds || 0)
    if (base) {
      const baseReading = base.books[hash]?.reading ?? {}
      reading = { ...baseReading }
      const mine = (baseReading[me] ?? 0) + Math.max(0, localTotal - sumReading(baseReading))
      if (mine > 0 || me in baseReading) reading[me] = mine
    } else {
      const remoteReading = remoteMerged?.books[hash]?.reading ?? {}
      const others = sumReading(remoteReading) - (remoteReading[me] ?? 0)
      const mine = Math.max(localTotal - others, remoteReading[me] ?? 0, 0)
      reading = mine > 0 ? { [me]: mine } : {}
    }

    doc.books[hash] = { meta, progress, reading, alive }
  }

  // 标注 / 书单 / 书单条目 / 书源: 有基线按 diff; 首次同步远端优先 (含远端墓碑, 不会重新加回)
  const pickReg = <T>(fromBase: Reg<T> | undefined, fromRemote: Reg<T> | undefined, value: T) =>
    base ? diff(fromBase, value) : adopt(fromRemote, value)
  for (const id of sortedKeys(local.annotations)) {
    doc.annotations[id] = pickReg(base?.annotations[id], remoteMerged?.annotations[id], local.annotations[id])
  }
  for (const id of sortedKeys(local.booklists)) {
    doc.booklists[id] = pickReg(base?.booklists[id], remoteMerged?.booklists[id], local.booklists[id])
  }
  for (const key of sortedKeys(local.booklistItems)) {
    doc.booklistItems[key] = pickReg(
      base?.booklistItems[key], remoteMerged?.booklistItems[key], local.booklistItems[key])
  }
  const localWanted = local.booklistWanted ?? {}
  for (const id of sortedKeys(localWanted)) {
    wanted[id] = pickReg(base?.booklistWanted?.[id], remoteMerged?.booklistWanted?.[id], localWanted[id])
  }
  // 书源: stamp.t 取修改时间 (updatedAt), 改得最晚的赢, 而不是同步得最晚的.
  // 有基线: 变了的 t = max(修改时间, 基线 t + 1) (时钟偏慢也能盖过它所基于的值);
  // 首次同步: 远端有寄存器时, 本地值相同或改得不比它晚就沿用远端 (含墓碑), 否则本地胜出.
  // 没有修改时间 (sourceTimes 缺省) 时退回与书单相同的规则: 按同步时间打 stamp、首次同步远端优先.
  const baseSources = base ? { ...doc.sources } : {}
  const remoteSources = !base && remoteMerged ? rekeySources(remoteMerged.sources) : {}
  for (const key of sortedKeys(local.sources)) {
    const value = local.sources[key]
    const t = local.sourceTimes?.[key]
    if (base) {
      const prev = baseSources[key]
      doc.sources[key] = prev && same(prev.value, value)
        ? prev
        : { value, stamp: stamp(t === undefined ? now : Math.max(t, (prev ? prev.stamp.t : -1) + 1)) }
    } else {
      const prev = remoteSources[key]
      doc.sources[key] = prev && (same(prev.value, value) || t === undefined || t <= prev.stamp.t)
        ? prev
        : { value, stamp: stamp(t ?? now) }
    }
  }

  // 墓碑: 只在有基线时生成.
  // 标注/书单条目只在所属的书 (与书单) 此刻仍在本地时才单独生成墓碑: 书或书单整个没了时
  // 由它们自己的墓碑级联; 否则会把「因书单已删而从未落地」的条目误判为删除,
  // 且书/书单日后被恢复 (重新导入、并发改名胜出) 时其内容也能一起回来.
  if (base) {
    const tomb = <T>(): Reg<T> => ({ value: null, stamp: stamp() })
    for (const [hash, rec] of Object.entries(base.books)) {
      if (rec.alive.value === true && presentHashes.has(hash) && !(hash in local.books)) {
        doc.books[hash] = { ...rec, alive: { value: false, stamp: stamp() } }
      }
    }
    for (const [id, reg] of Object.entries(base.annotations)) {
      const v = reg.value
      if (v && presentHashes.has(v.bookHash) && v.bookHash in local.books && !(id in local.annotations)) {
        doc.annotations[id] = tomb()
      }
    }
    for (const [key, reg] of Object.entries(base.booklistItems)) {
      const v = reg.value
      if (
        v && presentHashes.has(v.bookHash) && v.bookHash in local.books && v.booklistId in local.booklists
        && !(key in local.booklistItems)
      ) {
        doc.booklistItems[key] = tomb()
      }
    }
    for (const [id, reg] of Object.entries(base.booklists)) {
      if (reg.value && !(id in local.booklists)) doc.booklists[id] = tomb()
    }
    // 待找条目: 同书单条目, 所属书单此刻在本地才单独生成墓碑 (书单整个删了由书单墓碑级联)
    for (const [id, reg] of Object.entries(base.booklistWanted ?? {})) {
      const v = reg.value
      if (v && v.booklistId in local.booklists && !(id in localWanted)) wanted[id] = tomb()
    }
    const builtin = new Set(local.builtinSourceKeys ?? [])
    for (const [key, reg] of Object.entries(baseSources)) {
      if (reg.value && !(key in local.sources) && !builtin.has(key)) doc.sources[key] = tomb()
    }
  }

  if (Object.keys(wanted).length) doc.booklistWanted = wanted
  return structuredClone(doc)
}

// ---- 合并 ----

function mergeBook(a: BookSyncRec | undefined, b: BookSyncRec | undefined): BookSyncRec {
  if (!a) return b!
  if (!b) return a
  const reading: Record<string, number> = { ...a.reading }
  for (const [d, n] of Object.entries(b.reading)) reading[d] = Math.max(reading[d] ?? 0, n)
  return {
    meta: lww(a.meta, b.meta)!,
    progress: lww(a.progress, b.progress)!,
    reading,
    alive: lww(a.alive, b.alive)!,
  }
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 每日阅读记录的合并: 逐叶取较大值 (交换律/结合律/幂等). 缺失或畸形的输入当作空;
 * 非正数 / 非有限数的叶子、不像日期的键丢弃. 结果为空时返回 undefined (文档里不写该字段).
 */
export function mergeReadingLog(...logs: Array<ReadingLogDoc | undefined | null>): ReadingLogDoc | undefined {
  const out: ReadingLogDoc = {}
  let any = false
  for (const log of logs) {
    if (!isPlainObj(log)) continue
    for (const [device, days] of Object.entries(log)) {
      if (!isPlainObj(days)) continue
      for (const [day, books] of Object.entries(days)) {
        if (!DAY_RE.test(day) || !isPlainObj(books)) continue
        for (const [hash, n] of Object.entries(books)) {
          if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue
          const d = (out[device] ??= {})
          const b = (d[day] ??= {})
          if (!(hash in b) || n > b[hash]) b[hash] = n
          any = true
        }
      }
    }
  }
  return any ? out : undefined
}

/** 设置寄存器是否完好: stamp 合法, value 不是 null / undefined (设置没有墓碑) */
function validSettingReg(reg: unknown): reg is Reg<unknown> {
  if (!isPlainObj(reg)) return false
  const st = reg.stamp
  return isPlainObj(st) && typeof st.t === 'number' && Number.isFinite(st.t) && typeof st.d === 'string'
    && reg.value !== null && reg.value !== undefined
}

/**
 * 设置的合并: 按路径 LWW (交换律/结合律/幂等). 缺失或畸形的输入与寄存器跳过;
 * 不认识的路径 (更新的客户端加的设置) 也原样保留并转写, 是否落地由 settingsSync.planSettingsApply 按白名单决定.
 * 结果为空时返回 undefined (文档里不写该字段).
 */
export function mergeSettingRegs(...docs: Array<SettingsDoc | undefined | null>): SettingsDoc | undefined {
  const out: SettingsDoc = {}
  let any = false
  for (const doc of docs) {
    if (!isPlainObj(doc)) continue
    for (const [path, reg] of Object.entries(doc)) {
      if (!validSettingReg(reg)) continue
      out[path] = lww(out[path], { value: reg.value, stamp: { t: reg.stamp.t, d: reg.stamp.d } })!
      any = true
    }
  }
  return any ? structuredClone(out) : undefined
}

function mergeRegs<T>(into: Record<string, Reg<T>>, from: Record<string, Reg<T>>) {
  for (const [k, reg] of Object.entries(from)) into[k] = lww(into[k], reg)!
}

/** 合并任意多份文档 (交换律/结合律/幂等). 结果的 deviceId/writtenAt 取 ctx;
 *  deviceName/app 取自 deviceId 为 ctx.deviceId 的文档中最新写入的一份 */
export function mergeDocs(docs: SyncDoc[], ctx: { deviceId: string; now: number }): SyncDoc {
  const out = emptyDoc(ctx.deviceId, ctx.now)
  let self: SyncDoc | undefined
  for (const doc of docs) {
    for (const [hash, rec] of Object.entries(doc.books)) out.books[hash] = mergeBook(out.books[hash], rec)
    mergeRegs(out.annotations, doc.annotations)
    mergeRegs(out.booklists, doc.booklists)
    mergeRegs(out.booklistItems, doc.booklistItems)
    mergeRegs(out.sources, rekeySources(doc.sources))
    if (isPlainObj(doc.booklistWanted)) mergeRegs(out.booklistWanted ??= {}, doc.booklistWanted)
    if (doc.deviceId === ctx.deviceId && (!self || doc.writtenAt > self.writtenAt)) self = doc
  }
  if (self?.deviceName !== undefined) out.deviceName = self.deviceName
  if (self?.app !== undefined) out.app = self.app
  const readingLog = mergeReadingLog(...docs.map(d => d.readingLog))
  if (readingLog) out.readingLog = readingLog
  const settings = mergeSettingRegs(...docs.map(d => d.settings))
  if (settings) out.settings = settings
  return structuredClone(out)
}

// ---- 落地到本地 ----

const META_KEYS = [
  'title', 'author', 'format', 'fileName', 'description', 'language',
  'tags', 'addedAt', 'kind', 'source', 'pinnedAt',
] as const
/** 可选字符串字段: 合并结果里去掉了就写空串 (空串规范化后等同缺省) */
const OPTIONAL_STR = new Set<string>(['description', 'language', 'source'])
const PROGRESS_KEYS = ['location', 'progress', 'lastReadAt'] as const

type BookPatch = Extract<ApplyOp, { op: 'updateBook' }>['patch']

/**
 * 计算把合并结果落到本地所需的操作, 按可执行顺序排列:
 * addBook → updateBook → addBooklist/renameBooklist → addAnnotation/updateAnnotation
 * → addBooklistItem/putWanted → addSource/updateSource → 各类删除 (removeBooklistItem, deleteWanted,
 * deleteAnnotation, deleteBooklist, deleteSource, deleteBook).
 * 例外: 标注的 cfi/text 等不可原地修改的字段变了时, 产出紧挨着的
 * deleteAnnotation + addAnnotation (同一 id), 放在添加阶段, 保证先删后加.
 * 书源内容变了时产出 updateSource (原地改写, 本地 id 不变), 与 addSource 同一阶段.
 * 书被删 (alive=false) 时其标注/书单条目不再单独产出删除, 由 deleteBook 级联;
 * 书单被删时其条目同理由 deleteBooklist 级联.
 * 只有元数据、本地没有的书也会产出 addBook, 由 engine 决定能否下载文件;
 * 引用本地不存在的书的标注/书单条目照样产出, engine 找不到 hash 时跳过.
 */
export function planApply(merged: SyncDoc, local: LocalState): ApplyOp[] {
  const addBooks: ApplyOp[] = []
  const updateBooks: ApplyOp[] = []
  const lists: ApplyOp[] = []
  const annos: ApplyOp[] = []
  const addItems: ApplyOp[] = []
  const addSources: ApplyOp[] = []
  const rmItems: ApplyOp[] = []
  const delAnnos: ApplyOp[] = []
  const delLists: ApplyOp[] = []
  const delSources: ApplyOp[] = []
  const delBooks: ApplyOp[] = []

  /** 合并结果里书是否存活; 合并结果没有这本书时以本地为准 */
  const bookAlive = (hash: string) => {
    const rec = merged.books[hash]
    return rec ? rec.alive.value === true : hash in local.books
  }
  const listAlive = (id: string) => {
    const reg = merged.booklists[id]
    return reg ? reg.value !== null : id in local.booklists
  }

  // 书
  for (const hash of sortedKeys(merged.books)) {
    const rec = merged.books[hash]
    const alive = rec.alive.value === true
    const lb = local.books[hash]
    const total = sumReading(rec.reading)
    if (alive && !lb) {
      if (!rec.meta.value) continue
      addBooks.push({
        op: 'addBook', hash,
        meta: structuredClone(rec.meta.value),
        progress: structuredClone(rec.progress.value ?? {}),
        readingSeconds: total,
      })
    } else if (!alive && lb) {
      delBooks.push({ op: 'deleteBook', hash })
    } else if (alive && lb) {
      const patch: Record<string, unknown> = {}
      const m = rec.meta.value
      if (m) {
        for (const k of META_KEYS) {
          if (same(m[k], lb.meta[k])) continue
          const v = m[k]
          patch[k] = v === undefined && OPTIONAL_STR.has(k) ? '' : structuredClone(v)
        }
      }
      const p = rec.progress.value
      if (p) {
        for (const k of PROGRESS_KEYS) if (!same(p[k], lb.progress[k])) patch[k] = p[k]
      }
      // 本机贡献已计入合并结果, 总数只会更大; 更小说明 merged 不含本机文档, 不回退
      if (total > (lb.readingSeconds || 0)) patch.readingSeconds = total
      if (Object.keys(patch).length) updateBooks.push({ op: 'updateBook', hash, patch: patch as BookPatch })
    }
  }

  // 书单
  for (const id of sortedKeys(merged.booklists)) {
    const v = merged.booklists[id].value
    const ll = local.booklists[id]
    if (v) {
      if (!ll) lists.push({ op: 'addBooklist', id, value: structuredClone(v) })
      else if (v.name !== ll.name) lists.push({ op: 'renameBooklist', id, name: v.name })
    } else if (ll) {
      delLists.push({ op: 'deleteBooklist', id })
    }
  }

  // 标注
  for (const id of sortedKeys(merged.annotations)) {
    const v = merged.annotations[id].value
    const la = local.annotations[id]
    if (v) {
      if (!bookAlive(v.bookHash)) continue
      if (!la) {
        annos.push({ op: 'addAnnotation', id, value: structuredClone(v) })
        continue
      }
      const { note: vn, color: vc, style: vs, ...vRest } = v
      const { note: ln, color: lc, style: ls, ...lRest } = la
      if (!same(vRest, lRest)) {
        annos.push({ op: 'deleteAnnotation', id }, { op: 'addAnnotation', id, value: structuredClone(v) })
        continue
      }
      const patch: { note?: string; color?: string; style?: AnnotationRec['style'] } = {}
      if ((vn ?? '') !== (ln ?? '')) patch.note = vn ?? ''
      if (vc !== lc) patch.color = vc
      if (storedHighlightStyle(vs) !== storedHighlightStyle(ls)) patch.style = storedHighlightStyle(vs)
      if (Object.keys(patch).length) annos.push({ op: 'updateAnnotation', id, patch })
    } else if (la && bookAlive(la.bookHash)) {
      delAnnos.push({ op: 'deleteAnnotation', id })
    }
  }

  // 书单条目
  for (const key of sortedKeys(merged.booklistItems)) {
    const v = merged.booklistItems[key].value
    const li = local.booklistItems[key]
    if (v) {
      if (!li && listAlive(v.booklistId) && bookAlive(v.bookHash)) {
        addItems.push({ op: 'addBooklistItem', booklistId: v.booklistId, hash: v.bookHash })
      }
    } else if (li && listAlive(li.booklistId) && bookAlive(li.bookHash)) {
      rmItems.push({ op: 'removeBooklistItem', booklistId: li.booklistId, hash: li.bookHash })
    }
  }

  // 待找条目: 新增或内容变了 → putWanted (同 id 覆盖); 墓碑 → deleteWanted. 都要求所属书单存活
  const localWanted = local.booklistWanted ?? {}
  for (const id of sortedKeys(merged.booklistWanted ?? {})) {
    const v = merged.booklistWanted![id].value
    const lw = localWanted[id]
    if (v) {
      if (listAlive(v.booklistId) && (!lw || !same(v, lw))) addItems.push({ op: 'putWanted', id, value: structuredClone(v) })
    } else if (lw && listAlive(lw.booklistId)) {
      rmItems.push({ op: 'deleteWanted', id })
    }
  }

  // 书源 (键为 sourceKey; 落地时的修改时间沿用寄存器的 stamp.t). 与本机内置书源同地址的不落地
  const builtinSources = new Set(local.builtinSourceKeys ?? [])
  for (const key of sortedKeys(merged.sources)) {
    const reg = merged.sources[key]
    const v = reg.value
    const ls = local.sources[key]
    if (!ls && builtinSources.has(key)) continue
    if (v) {
      if (!ls) addSources.push({ op: 'addSource', key, value: structuredClone(v), updatedAt: reg.stamp.t })
      else if (!same(v, ls)) {
        addSources.push({ op: 'updateSource', key, value: structuredClone(v), updatedAt: reg.stamp.t })
      }
    } else if (ls) {
      delSources.push({ op: 'deleteSource', key })
    }
  }

  return [
    ...addBooks, ...updateBooks, ...lists, ...annos, ...addItems, ...addSources,
    ...rmItems, ...delAnnos, ...delLists, ...delSources, ...delBooks,
  ]
}
