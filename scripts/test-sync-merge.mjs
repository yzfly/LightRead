import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  annotationFrom,
  bookMetaFrom,
  buildLocalDoc,
  cmpStamp,
  emptyDoc,
  mergeDocs,
  planApply,
  progressFrom,
  rekeySources,
  sourceFrom,
  sourceKey,
  wantedFrom,
} from '../src/services/sync/merge.ts'

// ---- 模拟设备 ----

const emptyLocal = () => ({ books: {}, annotations: {}, booklists: {}, booklistItems: {}, booklistWanted: {}, sources: {} })

const meta = (title, extra = {}) => ({
  title, author: 'A', format: 'epub', fileName: `${title}.epub`, tags: [], addedAt: 1, kind: 'book', pinnedAt: 0,
  ...extra,
})

const book = (title, extra = {}) => ({
  id: `local-${title}`,
  meta: meta(title, extra.meta),
  progress: extra.progress ?? {},
  readingSeconds: extra.readingSeconds ?? 0,
  hasCover: false,
})

const wanted = (booklistId, title, extra = {}) => ({ booklistId, title, author: 'W', addedAt: 1, ...extra })

const anno = (bookHash, extra = {}) => ({
  bookHash, kind: 'highlight', cfi: 'epubcfi(/6/4)', text: 'hello', color: 'yellow', createdAt: 1, ...extra,
})

class Device {
  constructor(id) {
    this.id = id
    this.local = emptyLocal()
    /** 书源修改时间 (engine 由 updatedAt ?? addedAt 填); 没有记录的键退回按同步时间 */
    this.local.sourceTimes = {}
    this.base = null
    this.present = new Set()
    /** 远端有文件可下载的书 (模拟 engine 下载成功) */
    this.canDownload = () => true
  }
}

/** 把 BookMeta 形式的 patch 落到 LocalBook (走真实的规范化函数) */
function patchBook(lb, patch) {
  const bm = { id: lb.id, hasCover: lb.hasCover, readingSeconds: lb.readingSeconds, ...lb.meta, ...lb.progress }
  Object.assign(bm, patch)
  lb.meta = bookMetaFrom(bm)
  lb.progress = progressFrom(bm)
  lb.readingSeconds = bm.readingSeconds ?? 0
}

/** 模拟 engine 应用操作 (删除级联, 找不到书时跳过) */
function apply(dev, ops) {
  const L = dev.local
  for (const o of ops) {
    switch (o.op) {
      case 'addBook':
        if (dev.canDownload(o.hash)) {
          L.books[o.hash] = {
            id: `local-${o.hash}`, meta: structuredClone(o.meta), progress: structuredClone(o.progress),
            readingSeconds: o.readingSeconds, hasCover: false,
          }
        }
        break
      case 'deleteBook':
        delete L.books[o.hash]
        for (const [id, a] of Object.entries(L.annotations)) if (a.bookHash === o.hash) delete L.annotations[id]
        for (const [k, it] of Object.entries(L.booklistItems)) if (it.bookHash === o.hash) delete L.booklistItems[k]
        break
      case 'updateBook':
        assert.ok(L.books[o.hash], 'updateBook on missing book')
        patchBook(L.books[o.hash], o.patch)
        break
      case 'addAnnotation':
        if (L.books[o.value.bookHash]) {
          assert.ok(!L.annotations[o.id], 'addAnnotation over existing id')
          L.annotations[o.id] = structuredClone(o.value)
        }
        break
      case 'updateAnnotation': {
        const a = L.annotations[o.id]
        const rec = { id: o.id, bookId: 'x', ...a, ...o.patch }
        L.annotations[o.id] = annotationFrom(rec, a.bookHash)
        break
      }
      case 'deleteAnnotation':
        delete L.annotations[o.id]
        break
      case 'addBooklist':
        L.booklists[o.id] = structuredClone(o.value)
        break
      case 'renameBooklist':
        L.booklists[o.id].name = o.name
        break
      case 'deleteBooklist':
        delete L.booklists[o.id]
        for (const [k, it] of Object.entries(L.booklistItems)) if (it.booklistId === o.id) delete L.booklistItems[k]
        for (const [k, w] of Object.entries(L.booklistWanted)) if (w.booklistId === o.id) delete L.booklistWanted[k]
        break
      case 'putWanted':
        assert.ok(L.booklists[o.value.booklistId], 'putWanted into a missing booklist')
        L.booklistWanted[o.id] = structuredClone(o.value)
        break
      case 'deleteWanted':
        assert.ok(L.booklistWanted[o.id], 'deleteWanted on missing entry')
        delete L.booklistWanted[o.id]
        break
      case 'addBooklistItem':
        if (L.books[o.hash] && L.booklists[o.booklistId]) {
          L.booklistItems[`${o.booklistId}|${o.hash}`] = { booklistId: o.booklistId, bookHash: o.hash, addedAt: 1 }
        }
        break
      case 'removeBooklistItem':
        assert.ok(L.booklistItems[`${o.booklistId}|${o.hash}`], 'remove missing item')
        delete L.booklistItems[`${o.booklistId}|${o.hash}`]
        break
      case 'addSource':
        assert.ok(!L.sources[o.key], 'addSource over existing key')
        assert.ok(!(L.builtinSourceKeys ?? []).includes(o.key), 'addSource over a builtin source')
        L.sources[o.key] = structuredClone(o.value)
        if (L.sourceTimes) L.sourceTimes[o.key] = o.updatedAt
        break
      case 'updateSource':
        assert.ok(L.sources[o.key], 'updateSource on missing key')
        L.sources[o.key] = structuredClone(o.value)
        if (L.sourceTimes) L.sourceTimes[o.key] = o.updatedAt
        break
      case 'deleteSource':
        assert.ok(L.sources[o.key], 'deleteSource on missing key')
        delete L.sources[o.key]
        if (L.sourceTimes) delete L.sourceTimes[o.key]
        break
      default:
        throw new Error(`unknown op ${o.op}`)
    }
  }
}

/** 一次完整同步 (与 docs/sync.md 的 engine 流程一致); remote: Map<deviceId, SyncDoc> */
function sync(dev, remote, now) {
  const ctx = { deviceId: dev.id, now }
  const remoteDocs = [...remote.values()]
  const remoteMerged = remoteDocs.length ? mergeDocs(remoteDocs, ctx) : null
  const mine = buildLocalDoc(dev.local, dev.base, dev.present, remoteMerged, ctx)
  const merged = mergeDocs([mine, ...remoteDocs], ctx)
  const ops = planApply(merged, dev.local)
  apply(dev, ops)
  remote.set(dev.id, merged)
  dev.base = merged
  dev.present = new Set(Object.keys(dev.local.books))
  return ops
}

/** 本地库去掉设备本地的 book id 与书源修改时间 (本机改的保留编辑时间, 收到的记 stamp.t), 便于跨设备比较 */
const view = (local) => {
  const { sourceTimes, ...rest } = local
  return {
    ...rest,
    books: Object.fromEntries(Object.entries(local.books).map(([h, { id, ...b }]) => [h, b])),
  }
}

const strip = (doc) => {
  const { writtenAt, deviceId, deviceName, app, ...rest } = doc
  return rest
}

// ---- 基础 ----

test('cmpStamp compares t then d', () => {
  assert.ok(cmpStamp({ t: 2, d: 'a' }, { t: 1, d: 'z' }) > 0)
  assert.ok(cmpStamp({ t: 1, d: 'b' }, { t: 1, d: 'a' }) > 0)
  assert.ok(cmpStamp({ t: 1, d: 'a' }, { t: 1, d: 'b' }) < 0)
  assert.equal(cmpStamp({ t: 1, d: 'a' }, { t: 1, d: 'a' }), 0)
})

test('canonicalizers fill defaults and drop empty optional fields', () => {
  const bm = {
    id: 'x', title: 'T', author: 'A', format: 'pdf', fileName: 'f.pdf', tags: ['x'], addedAt: 5,
    hasCover: true, description: undefined, language: '', location: '3', progress: 0.5, lastReadAt: 9,
    readingSeconds: 10,
  }
  assert.deepEqual(bookMetaFrom(bm), {
    title: 'T', author: 'A', format: 'pdf', fileName: 'f.pdf', tags: ['x'], addedAt: 5, kind: 'book', pinnedAt: 0,
  })
  assert.deepEqual(progressFrom(bm), { location: '3', progress: 0.5, lastReadAt: 9 })
  assert.deepEqual(progressFrom({ ...bm, location: undefined, progress: undefined, lastReadAt: undefined }), {})
  assert.deepEqual(
    annotationFrom({ id: 'a', bookId: 'b', cfi: 'c', text: 't', color: 'red', createdAt: 1, note: undefined }, 'H'),
    { bookHash: 'H', kind: 'highlight', cfi: 'c', text: 't', color: 'red', createdAt: 1 },
  )
  assert.deepEqual(
    sourceFrom({ id: 's', title: 'S', url: 'u', kind: 'opds', builtin: false, addedAt: 2, username: undefined }),
    { title: 'S', url: 'u', kind: 'opds', addedAt: 2 },
  )
  assert.deepEqual(emptyDoc('d', 3), {
    format: 1, deviceId: 'd', writtenAt: 3, books: {}, annotations: {}, booklists: {}, booklistItems: {}, sources: {},
  })
})

// ---- 两台设备的完整流程 ----

test('first sync is a pure union: no tombstones, both sides converge, then steady state', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  A.local.books.h2 = book('two')
  A.local.annotations.a1 = anno('h1')
  B.local.books.h3 = book('three')
  B.local.booklists.l1 = { name: 'L', createdAt: 1 }
  B.local.booklistItems['l1|h3'] = { booklistId: 'l1', bookHash: 'h3', addedAt: 1 }
  B.local.sources.u1 = { title: 'S', url: 'u1', kind: 'opds', addedAt: 1 }

  // B 先同步 (远端空), 再 A, 再 B
  assert.deepEqual(sync(B, remote, 100), [])
  const aOps = sync(A, remote, 200)
  assert.ok(aOps.every((o) => !o.op.startsWith('delete') && o.op !== 'removeBooklistItem'))
  sync(B, remote, 300)

  for (const d of [A, B]) {
    assert.deepEqual(Object.keys(d.local.books).sort(), ['h1', 'h2', 'h3'])
    assert.deepEqual(Object.keys(d.local.annotations), ['a1'])
    assert.deepEqual(Object.keys(d.local.booklistItems), ['l1|h3'])
    assert.deepEqual(Object.keys(d.local.sources), ['u1'])
  }
  assert.deepEqual(view(A.local), view(B.local))

  // 稳态: 再同步没有操作, 文档内容不变
  const before = strip(remote.get('B'))
  assert.deepEqual(sync(A, remote, 400), [])
  assert.deepEqual(sync(B, remote, 500), [])
  assert.deepEqual(strip(remote.get('B')), before)
})

test('first sync never deletes even if the remote holds tombstones (resurrects instead)', () => {
  const remote = new Map()
  const A = new Device('A')
  A.local.books.h1 = book('one')
  sync(A, remote, 100)
  delete A.local.books.h1
  sync(A, remote, 200)
  assert.equal(remote.get('A').books.h1.alive.value, false)

  const B = new Device('B')
  B.local.books.h1 = book('one')
  const ops = sync(B, remote, 300)
  assert.ok(!ops.some((o) => o.op === 'deleteBook'))
  assert.ok(B.local.books.h1)
  sync(A, remote, 400)
  assert.ok(A.local.books.h1, 'B re-imported it, so it is alive again')
})

test('first sync: remote wins on conflicts, local-only records are added', () => {
  const remote = new Map()
  const A = new Device('A')
  A.local.books.h1 = book('one', { meta: { tags: ['a'] } })
  A.local.annotations.a1 = anno('h1', { note: 'A' })
  A.local.booklists.l1 = { name: 'A', createdAt: 1 }
  A.local.sources.u1 = { title: 'A', url: 'u1', kind: 'opds', addedAt: 1 }
  sync(A, remote, 100)

  const B = new Device('B')
  B.local.books.h1 = book('one', { meta: { tags: ['b'], addedAt: 999 } })
  B.local.annotations.a1 = anno('h1', { note: 'B' })
  B.local.annotations.a2 = anno('h1', { cfi: 'only-B' })
  B.local.booklists.l1 = { name: 'B', createdAt: 1 }
  B.local.sources.u1 = { title: 'B', url: 'u1', kind: 'opds', addedAt: 1 }
  sync(B, remote, 200) // 首次同步, stamp 比 A 新, 但远端优先
  assert.deepEqual(B.local.books.h1.meta.tags, ['a'])
  assert.equal(B.local.books.h1.meta.addedAt, 1)
  assert.equal(B.local.annotations.a1.note, 'A')
  assert.equal(B.local.booklists.l1.name, 'A')
  assert.equal(B.local.sources.u1.title, 'A')
  sync(A, remote, 300)
  assert.deepEqual(view(A.local), view(B.local))
  assert.ok(A.local.annotations.a2)
})

test('first sync after losing the baseline does not overwrite newer edits with a stale backup', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  A.local.annotations.a1 = anno('h1', { note: 'v1' })
  sync(A, remote, 100)
  sync(B, remote, 200)
  A.local.annotations.a2 = anno('h1', { cfi: 'x' })
  sync(A, remote, 250)
  sync(B, remote, 260)
  const stale = structuredClone(B.local) // 旧备份
  // 之后 A 又改了标签、笔记, 删了 a2
  patchBook(A.local.books.h1, { tags: ['new'] })
  A.local.annotations.a1.note = 'v2'
  delete A.local.annotations.a2
  sync(A, remote, 300)
  // B 重装并从旧备份恢复: 基线丢失
  B.local = stale
  B.base = null
  B.present = new Set()
  const ops = sync(B, remote, 400)
  assert.deepEqual(B.local.books.h1.meta.tags, ['new'])
  assert.equal(B.local.annotations.a1.note, 'v2')
  // 远端的标注墓碑在首次同步时同样生效
  assert.ok(ops.some((o) => o.op === 'deleteAnnotation' && o.id === 'a2'))
  assert.equal(B.local.annotations.a2, undefined)
  sync(A, remote, 500)
  assert.deepEqual(view(A.local), view(B.local))
})

test('first sync: a later local read still wins the progress', () => {
  const remote = new Map()
  const A = new Device('A')
  A.local.books.h1 = book('one', { progress: { location: 'A', lastReadAt: 50 } })
  sync(A, remote, 100)
  const B = new Device('B')
  B.local.books.h1 = book('one', { progress: { location: 'B', lastReadAt: 80 } })
  sync(B, remote, 200)
  sync(A, remote, 300)
  assert.deepEqual(A.local.books.h1.progress, { location: 'B', lastReadAt: 80 })
  assert.deepEqual(B.local.books.h1.progress, { location: 'B', lastReadAt: 80 })
})

test('importing a metadata-only book keeps the synced meta and progress', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  B.canDownload = () => false
  A.local.books.h1 = book('one', { meta: { tags: ['t'], pinnedAt: 5 }, progress: { location: 'A', lastReadAt: 50 } })
  A.local.books.h2 = book('two', { progress: { location: 'A2', lastReadAt: 50 } })
  sync(A, remote, 100)
  sync(B, remote, 200)
  assert.deepEqual(B.local.books, {})

  // 用户在 B 上自己导入了同一文件 (新元数据, 未读); h2 导入后还读了一会儿
  B.local.books.h1 = book('one', { meta: { addedAt: 999 } })
  B.local.books.h2 = book('two', { meta: { addedAt: 999 }, progress: { location: 'B2', lastReadAt: 150 } })
  const ops = sync(B, remote, 300)
  assert.ok(ops.every((o) => o.op === 'updateBook'))
  assert.deepEqual(B.local.books.h1.meta, A.local.books.h1.meta)
  assert.deepEqual(B.local.books.h1.progress, { location: 'A', lastReadAt: 50 })
  assert.equal(B.local.books.h2.meta.addedAt, 1)
  assert.deepEqual(B.local.books.h2.progress, { location: 'B2', lastReadAt: 150 })
  assert.deepEqual(sync(A, remote, 400), [
    { op: 'updateBook', hash: 'h2', patch: { location: 'B2', lastReadAt: 150 } },
  ])
  assert.deepEqual(sync(B, remote, 500), [])
})

test('local delete becomes a tombstone and the other device deletes (with cascade)', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  A.local.books.h2 = book('two')
  A.local.annotations.a1 = anno('h1')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistItems['l1|h1'] = { booklistId: 'l1', bookHash: 'h1', addedAt: 1 }
  sync(A, remote, 100)
  sync(B, remote, 200)
  assert.ok(B.local.annotations.a1 && B.local.booklistItems['l1|h1'])

  // A 删书 (本地级联删除标注与书单条目)
  apply(A, [{ op: 'deleteBook', hash: 'h1' }])
  sync(A, remote, 300)
  const ops = sync(B, remote, 400)
  // 书的删除级联标注/条目, 不再单独产出这些删除
  assert.deepEqual(ops, [{ op: 'deleteBook', hash: 'h1' }])
  assert.deepEqual(Object.keys(B.local.books), ['h2'])
  assert.deepEqual(B.local.annotations, {})
  assert.deepEqual(B.local.booklistItems, {})
  assert.deepEqual(sync(A, remote, 500), [])
})

test('deleting an annotation / booklist item / source propagates', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  A.local.annotations.a1 = anno('h1')
  A.local.annotations.a2 = anno('h1', { cfi: 'other' })
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistItems['l1|h1'] = { booklistId: 'l1', bookHash: 'h1', addedAt: 1 }
  A.local.sources.u1 = { title: 'S', url: 'u1', kind: 'opds', addedAt: 1 }
  sync(A, remote, 100)
  sync(B, remote, 200)
  delete B.local.annotations.a1
  delete B.local.booklistItems['l1|h1']
  delete B.local.sources.u1
  sync(B, remote, 300)
  const ops = sync(A, remote, 400)
  assert.deepEqual(ops, [
    { op: 'removeBooklistItem', booklistId: 'l1', hash: 'h1' },
    { op: 'deleteAnnotation', id: 'a1' },
    { op: 'deleteSource', key: 'u1' },
  ])
  assert.deepEqual(Object.keys(A.local.annotations), ['a2'])
})

test('metadata-only book (file not downloaded) is never tombstoned', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  B.canDownload = () => false
  A.local.books.h1 = book('one')
  A.local.annotations.a1 = anno('h1')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistItems['l1|h1'] = { booklistId: 'l1', bookHash: 'h1', addedAt: 1 }
  sync(A, remote, 100)

  const first = sync(B, remote, 200)
  assert.ok(first.some((o) => o.op === 'addBook' && o.hash === 'h1'))
  assert.equal(B.local.books.h1, undefined)
  // 多次同步: 仍然只有元数据, 不生成墓碑
  sync(B, remote, 300)
  sync(B, remote, 400)
  const bDoc = remote.get('B')
  assert.equal(bDoc.books.h1.alive.value, true)
  assert.notEqual(bDoc.annotations.a1.value, null)
  assert.notEqual(bDoc.booklistItems['l1|h1'].value, null)
  sync(A, remote, 500)
  assert.ok(A.local.books.h1 && A.local.annotations.a1 && A.local.booklistItems['l1|h1'])

  // 之后文件能下载了: 书与标注、书单条目一起落地
  B.canDownload = () => true
  sync(B, remote, 600)
  assert.ok(B.local.books.h1 && B.local.annotations.a1 && B.local.booklistItems['l1|h1'])
})

test('progress: the later read wins even if it was synced earlier', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  sync(A, remote, 100)
  sync(B, remote, 110)

  patchBook(B.local.books.h1, { location: 'B-loc', progress: 0.8, lastReadAt: 300 })
  patchBook(A.local.books.h1, { location: 'A-loc', progress: 0.2, lastReadAt: 200 })
  sync(B, remote, 400) // 读得晚, 同步得早
  sync(A, remote, 500) // 读得早, 同步得晚
  sync(B, remote, 600)
  for (const d of [A, B]) {
    assert.deepEqual(d.local.books.h1.progress, { location: 'B-loc', progress: 0.8, lastReadAt: 300 })
  }
})

test('progress of a never-read copy does not override remote reading position on first sync', () => {
  const remote = new Map()
  const A = new Device('A')
  A.local.books.h1 = book('one', { progress: { location: 'loc', progress: 0.5, lastReadAt: 50 } })
  sync(A, remote, 100)
  const B = new Device('B')
  B.local.books.h1 = book('one')
  sync(B, remote, 200)
  assert.deepEqual(B.local.books.h1.progress, { location: 'loc', progress: 0.5, lastReadAt: 50 })
})

test('reading time is a G-counter: no double counting across repeated syncs and reinstalls', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one', { readingSeconds: 100 })
  sync(A, remote, 100)
  sync(B, remote, 200)
  assert.equal(B.local.books.h1.readingSeconds, 100)

  B.local.books.h1.readingSeconds += 50
  A.local.books.h1.readingSeconds += 30
  sync(B, remote, 300)
  sync(A, remote, 400)
  sync(B, remote, 500)
  assert.equal(A.local.books.h1.readingSeconds, 180)
  assert.equal(B.local.books.h1.readingSeconds, 180)

  // 反复同步不变
  for (let i = 0; i < 3; i++) {
    sync(A, remote, 600 + i * 10)
    sync(B, remote, 700 + i * 10)
  }
  assert.equal(A.local.books.h1.readingSeconds, 180)
  assert.deepEqual(remote.get('A').books.h1.reading, { A: 130, B: 50 })

  // 重装 (同一 deviceId, 基线丢失, 本地从备份恢复了 180 秒)
  B.base = null
  B.present = new Set()
  sync(B, remote, 800)
  assert.equal(B.local.books.h1.readingSeconds, 180)

  // 重装 (新 deviceId, 本地从旧备份恢复 150 秒)
  const B2 = new Device('B2')
  B2.local.books.h1 = book('one', { readingSeconds: 150 })
  sync(B2, remote, 900)
  assert.equal(B2.local.books.h1.readingSeconds, 180)
  B2.local.books.h1.readingSeconds += 20
  sync(B2, remote, 1000)
  sync(A, remote, 1100)
  assert.equal(A.local.books.h1.readingSeconds, 200)
  assert.equal(B2.local.books.h1.readingSeconds, 200)
})

test('annotation note edits are LWW; cfi change replaces the annotation (delete before add)', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  A.local.annotations.a1 = anno('h1', { note: 'orig' })
  sync(A, remote, 100)
  sync(B, remote, 200)

  A.local.annotations.a1.note = 'from A'
  B.local.annotations.a1.note = 'from B'
  B.local.annotations.a1.color = 'blue'
  sync(A, remote, 300)
  const ops = sync(B, remote, 400) // B 的改动 stamp 更新, 胜出; B 本地无需操作
  assert.deepEqual(ops, [])
  const aOps = sync(A, remote, 500)
  assert.deepEqual(aOps, [{ op: 'updateAnnotation', id: 'a1', patch: { note: 'from B', color: 'blue' } }])
  assert.equal(A.local.annotations.a1.note, 'from B')

  // 清空笔记: 用空串表示
  delete A.local.annotations.a1.note
  sync(A, remote, 600)
  assert.deepEqual(sync(B, remote, 700), [{ op: 'updateAnnotation', id: 'a1', patch: { note: '' } }])
  assert.equal(B.local.annotations.a1.note, undefined)

  // cfi 变化无法原地更新: 紧挨着先删后加
  B.local.annotations.a1.cfi = 'epubcfi(/6/8)'
  sync(B, remote, 800)
  assert.deepEqual(sync(A, remote, 900), [
    { op: 'deleteAnnotation', id: 'a1' },
    { op: 'addAnnotation', id: 'a1', value: B.local.annotations.a1 },
  ])
  assert.deepEqual(A.local.annotations, B.local.annotations)
})

test('booklist rename propagates; deleting a booklist cascades its items', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  A.local.books.h2 = book('two')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistItems['l1|h1'] = { booklistId: 'l1', bookHash: 'h1', addedAt: 1 }
  A.local.booklistItems['l1|h2'] = { booklistId: 'l1', bookHash: 'h2', addedAt: 1 }
  sync(A, remote, 100)
  sync(B, remote, 200)

  B.local.booklists.l1.name = 'Renamed'
  sync(B, remote, 300)
  assert.deepEqual(sync(A, remote, 400), [{ op: 'renameBooklist', id: 'l1', name: 'Renamed' }])

  apply(A, [{ op: 'deleteBooklist', id: 'l1' }])
  sync(A, remote, 500)
  assert.deepEqual(sync(B, remote, 600), [{ op: 'deleteBooklist', id: 'l1' }])
  assert.deepEqual(B.local.booklistItems, {})
  assert.deepEqual(B.local.booklists, {})
})

test('a booklist brought back by a newer rename keeps its items (items are not tombstoned separately)', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistItems['l1|h1'] = { booklistId: 'l1', bookHash: 'h1', addedAt: 1 }
  sync(A, remote, 100)
  sync(B, remote, 200)
  apply(B, [{ op: 'deleteBooklist', id: 'l1' }])
  sync(B, remote, 300)
  assert.equal(remote.get('B').booklists.l1.value, null)
  assert.notEqual(remote.get('B').booklistItems['l1|h1'].value, null)
  // A 并发改名 (stamp 更新), 书单连同条目回来
  A.local.booklists.l1.name = 'Kept'
  assert.deepEqual(sync(A, remote, 400), [])
  assert.deepEqual(sync(B, remote, 500), [
    { op: 'addBooklist', id: 'l1', value: { name: 'Kept', createdAt: 1 } },
    { op: 'addBooklistItem', booklistId: 'l1', hash: 'h1' },
  ])
})

test('re-importing a deleted book resurrects it everywhere (newer stamp wins)', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one', { meta: { tags: ['t'] } })
  sync(A, remote, 100)
  sync(B, remote, 200)
  delete A.local.books.h1
  sync(A, remote, 300)
  sync(B, remote, 400)
  assert.equal(B.local.books.h1, undefined)

  B.local.books.h1 = book('one')
  sync(B, remote, 500)
  const ops = sync(A, remote, 600)
  assert.equal(ops.length, 1)
  assert.equal(ops[0].op, 'addBook')
  assert.ok(A.local.books.h1)
  assert.equal(remote.get('A').books.h1.alive.value, true)
})

test('concurrent delete vs. edit: alive and meta are independent registers', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  sync(A, remote, 100)
  sync(B, remote, 200)
  delete A.local.books.h1
  patchBook(B.local.books.h1, { tags: ['x'], pinnedAt: 7 })
  sync(A, remote, 300)
  sync(B, remote, 400)
  // A 的删除 stamp 300 < B 未改 alive, 所以书仍然被删; B 的标签改动保留在 meta 里
  assert.equal(B.local.books.h1, undefined)
  assert.deepEqual(remote.get('B').books.h1.meta.value.tags, ['x'])
})

test('meta patch covers changed fields only, optional removals become empty strings', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one', { meta: { description: 'd', source: 's' } })
  sync(A, remote, 100)
  sync(B, remote, 200)
  patchBook(A.local.books.h1, { description: undefined, pinnedAt: 0, tags: ['n'], title: 'New' })
  A.local.books.h1.meta.pinnedAt = 0
  sync(A, remote, 300)
  const ops = sync(B, remote, 400)
  assert.deepEqual(ops, [{ op: 'updateBook', hash: 'h1', patch: { title: 'New', description: '', tags: ['n'] } }])
  assert.deepEqual(B.local.books.h1.meta, A.local.books.h1.meta)

  // 置顶取消 → pinnedAt 0
  patchBook(A.local.books.h1, { pinnedAt: 99 })
  sync(A, remote, 500)
  sync(B, remote, 600)
  patchBook(B.local.books.h1, { pinnedAt: 0 })
  sync(B, remote, 700)
  assert.deepEqual(sync(A, remote, 800), [{ op: 'updateBook', hash: 'h1', patch: { pinnedAt: 0 } }])
})

test('source content change is applied in place (updateSource) on the same key', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.sources.u1 = { title: 'S', url: 'u1', kind: 'opds', addedAt: 1 }
  sync(A, remote, 100)
  sync(B, remote, 200)
  B.local.sources.u1 = { ...B.local.sources.u1, username: 'me', password: 'pw' }
  B.local.sourceTimes.u1 = 250
  sync(B, remote, 300)
  assert.deepEqual(sync(A, remote, 400), [
    {
      op: 'updateSource', key: 'u1', updatedAt: 250,
      value: { title: 'S', url: 'u1', kind: 'opds', addedAt: 1, username: 'me', password: 'pw' },
    },
  ])
})

// ---- 私人书库 / 自定义书源 ----

const LIB = 'https://lib.example.com/opds'
const lib = (extra = {}) => ({ title: '我的书库', url: LIB, kind: 'opds', addedAt: 10, ...extra })
/** 在设备上添加 / 编辑书源 (同 CatalogView.saveSource: 记下修改时间) */
function putSource(dev, value, at) {
  const key = sourceKey(value.url)
  dev.local.sources[key] = value
  dev.local.sourceTimes[key] = at
  return key
}

test('sourceKey normalizes spelling variants of the same library address, idempotently', () => {
  for (const v of [
    'https://lib.example.com/opds', 'https://lib.example.com/opds/', 'HTTPS://LIB.Example.com/opds',
    ' https://lib.example.com/opds// ', 'https://me:secret@lib.example.com/opds', 'https://lib.example.com:443/opds#x',
  ]) assert.equal(sourceKey(v), LIB, v)
  assert.equal(sourceKey('https://lib.example.com/'), 'https://lib.example.com')
  assert.equal(sourceKey('http://lib.example.com:8083/opds?lang=zh'), 'http://lib.example.com:8083/opds?lang=zh')
  assert.notEqual(sourceKey('http://lib.example.com/opds'), sourceKey(LIB), 'scheme is part of the identity')
  assert.notEqual(sourceKey('https://lib.example.com/OPDS'), sourceKey(LIB), 'path case is kept')
  assert.equal(sourceKey('u1'), 'u1', 'non-URL keys pass through')
  for (const v of ['https://A.b/x/', 'u1', 'http://h:80/p?q#f']) assert.equal(sourceKey(sourceKey(v)), sourceKey(v))
})

test('private library: credentials ride along in the synced record', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  putSource(A, lib({ username: 'me', password: 's3cret' }), 50)
  sync(A, remote, 100)
  assert.deepEqual(remote.get('A').sources[LIB].value, lib({ username: 'me', password: 's3cret' }))
  assert.deepEqual(remote.get('A').sources[LIB].stamp, { t: 50, d: 'A' }, 'stamp.t is the edit time, not the sync time')
  const ops = sync(B, remote, 200)
  assert.deepEqual(ops, [{ op: 'addSource', key: LIB, value: lib({ username: 'me', password: 's3cret' }), updatedAt: 50 }])
  assert.equal(B.local.sourceTimes[LIB], 50)
})

test('private library added independently on two devices (different spelling) dedupes to one, newer edit wins', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  putSource(A, lib({ password: 'old' }), 50)
  putSource(B, lib({ url: 'https://LIB.example.com/opds/', title: '书库', password: 'new' }), 60)
  sync(A, remote, 100)
  // B 首次同步: 远端已有同一书库, 但 B 的修改更晚 → B 胜出 (按修改时间, 不是一律远端优先)
  assert.deepEqual(sync(B, remote, 200), [])
  sync(A, remote, 300)
  for (const d of [A, B]) {
    assert.deepEqual(Object.keys(d.local.sources), [LIB])
    assert.equal(d.local.sources[LIB].password, 'new')
    assert.equal(d.local.sources[LIB].url, 'https://LIB.example.com/opds/', 'the address as typed is kept')
  }

  // 反过来: 后同步的设备改得更早 → 远端的胜出
  const remote2 = new Map()
  const C = new Device('C')
  const D = new Device('D')
  putSource(C, lib({ password: 'newer' }), 80)
  putSource(D, lib({ password: 'older' }), 70)
  sync(C, remote2, 100)
  sync(D, remote2, 200)
  assert.equal(D.local.sources[LIB].password, 'newer')
})

test('private library edits are LWW by edit time, not by sync order', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  putSource(A, lib(), 50)
  sync(A, remote, 100)
  sync(B, remote, 110)
  putSource(A, lib({ password: 'from-A' }), 150) // A 先改
  putSource(B, lib({ password: 'from-B' }), 200) // B 后改
  sync(B, remote, 300) // B 先同步
  sync(A, remote, 400) // A 后同步, 但它的修改更早
  sync(B, remote, 500)
  for (const d of [A, B]) assert.equal(d.local.sources[LIB].password, 'from-B')
  assert.equal(A.local.sourceTimes[LIB], 200, 'landed edit keeps the winner edit time')
  assert.deepEqual(sync(A, remote, 600), [])
  assert.deepEqual(sync(B, remote, 700), [])

  // 本机时钟偏慢: 改动仍盖过它所基于的值
  putSource(A, lib({ password: 'slow-clock' }), 10)
  sync(A, remote, 800)
  sync(B, remote, 900)
  assert.equal(B.local.sources[LIB].password, 'slow-clock')
})

test('deleted private library does not resurrect (stale device, lost baseline), but a later re-add does', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  putSource(A, lib({ username: 'me', password: 'pw' }), 50)
  sync(A, remote, 100)
  sync(B, remote, 200)
  delete A.local.sources[LIB]
  delete A.local.sourceTimes[LIB]
  sync(A, remote, 300)
  assert.equal(remote.get('A').sources[LIB].value, null, 'tombstone')
  assert.deepEqual(sync(B, remote, 400), [{ op: 'deleteSource', key: LIB }])
  assert.deepEqual(B.local.sources, {})

  // 第三台设备带着旧副本 (从没同步过 / 基线丢失) 首次同步: 修改时间早于删除 → 采纳墓碑, 不复活
  const C = new Device('C')
  putSource(C, lib({ username: 'me', password: 'pw' }), 50)
  assert.deepEqual(sync(C, remote, 500), [{ op: 'deleteSource', key: LIB }])
  sync(A, remote, 600)
  sync(B, remote, 700)
  for (const d of [A, B, C]) assert.deepEqual(d.local.sources, {})

  // 删除之后重新添加 (修改时间更晚) → 各设备都回来
  putSource(B, lib({ password: 'again' }), 800)
  sync(B, remote, 810)
  sync(A, remote, 820)
  sync(C, remote, 830)
  for (const d of [A, B, C]) assert.equal(d.local.sources[LIB]?.password, 'again')
})

test('editing a private library address: old key tombstoned, new key added', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  putSource(A, lib(), 50)
  sync(A, remote, 100)
  sync(B, remote, 200)
  delete A.local.sources[LIB]
  delete A.local.sourceTimes[LIB]
  const k2 = putSource(A, lib({ url: 'https://lib2.example.com/opds' }), 250)
  sync(A, remote, 300)
  const ops = sync(B, remote, 400)
  assert.deepEqual(ops.map(o => [o.op, o.key]), [['addSource', k2], ['deleteSource', LIB]])
  assert.deepEqual(Object.keys(B.local.sources), [k2])
})

test('documents from older clients (raw url keys) merge into the normalized key', () => {
  const old = {
    ...emptyDoc('old', 1),
    sources: {
      'https://LIB.example.com/opds/': { value: lib({ url: 'https://LIB.example.com/opds/', password: 'x' }), stamp: { t: 5, d: 'old' } },
      'https://gone.example.com/opds/': { value: null, stamp: { t: 9, d: 'old' } },
    },
  }
  const merged = mergeDocs([old], { deviceId: 'n', now: 10 })
  assert.deepEqual(Object.keys(merged.sources).sort(), ['https://gone.example.com/opds', LIB])
  assert.equal(merged.sources[LIB].value.password, 'x')
  // 旧客户端的墓碑 (按原样 url 记键) 也能删掉新客户端按规范键记的书源
  const remote = new Map()
  const A = new Device('A')
  putSource(A, lib({ url: 'https://gone.example.com/opds' }), 1)
  remote.set('old', old)
  sync(A, remote, 100)
  assert.deepEqual(Object.keys(A.local.sources), [LIB], 'old tombstone (t=9) beats an add edited at t=1')
  // 撞键 (两种拼写) 时按 LWW 取一个, 与输入顺序无关
  const a = { [LIB]: { value: lib({ password: 'a' }), stamp: { t: 3, d: 'a' } } }
  const b = { [`${LIB}/`]: { value: lib({ password: 'b' }), stamp: { t: 4, d: 'b' } } }
  assert.deepEqual(rekeySources({ ...a, ...b }), rekeySources({ ...b, ...a }))
  assert.equal(rekeySources({ ...a, ...b })[LIB].value.password, 'b')
})

test('a synced custom source that duplicates a builtin is neither landed nor tombstoned', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  const G = 'https://www.gutenberg.org/ebooks.opds'
  B.local.builtinSourceKeys = [G]
  putSource(A, { title: 'Gutenberg 副本', url: `${G}/`, kind: 'opds', addedAt: 1 }, 40)
  sync(A, remote, 100)
  assert.deepEqual(sync(B, remote, 200), [])
  sync(B, remote, 300)
  assert.ok(remote.get('B').sources[G].value, 'B passes it through instead of deleting it')
  sync(A, remote, 400)
  assert.ok(A.local.sources[G], 'still alive on A')
})

// ---- planApply 顺序 ----

test('planApply orders ops: adds, updates, lists, annotations, items, sources, then deletes', () => {
  const s = (t) => ({ t, d: 'x' })
  const reg = (value, t = 10) => ({ value, stamp: s(t) })
  const rec = (m, alive = true, reading = {}) => ({ meta: reg(m), progress: reg({}), reading, alive: reg(alive) })
  const merged = {
    ...emptyDoc('x', 1),
    books: {
      new: rec(meta('new'), true, { x: 5 }),
      upd: rec(meta('upd2')),
      gone: rec(meta('gone'), false),
    },
    annotations: {
      an: reg(anno('upd')),
      ad: reg(null),
      ag: reg(null), // 所属书被删: 由 deleteBook 级联
    },
    booklists: { ln: reg({ name: 'n', createdAt: 1 }), ld: reg(null), lr: reg({ name: 'r2', createdAt: 1 }) },
    booklistItems: {
      'ln|upd': reg({ booklistId: 'ln', bookHash: 'upd', addedAt: 1 }),
      'lr|upd': reg(null),
      'ld|upd': reg(null), // 书单被删: 级联
    },
    sources: { sn: reg({ title: 'n', url: 'sn', kind: 'opds', addedAt: 1 }), sd: reg(null) },
  }
  const local = {
    books: { upd: book('upd'), gone: book('gone') },
    annotations: { ad: anno('upd'), ag: anno('gone') },
    booklists: { ld: { name: 'd', createdAt: 1 }, lr: { name: 'r', createdAt: 1 } },
    booklistItems: {
      'lr|upd': { booklistId: 'lr', bookHash: 'upd', addedAt: 1 },
      'ld|upd': { booklistId: 'ld', bookHash: 'upd', addedAt: 1 },
    },
    sources: { sd: { title: 'd', url: 'sd', kind: 'opds', addedAt: 1 } },
  }
  const ops = planApply(merged, local)
  assert.deepEqual(ops.map((o) => o.op), [
    'addBook', 'updateBook', 'addBooklist', 'renameBooklist', 'addAnnotation', 'addBooklistItem', 'addSource',
    'removeBooklistItem', 'deleteAnnotation', 'deleteBooklist', 'deleteSource', 'deleteBook',
  ])
  assert.deepEqual(ops[0], { op: 'addBook', hash: 'new', meta: meta('new'), progress: {}, readingSeconds: 5 })
  assert.deepEqual(ops[1], { op: 'updateBook', hash: 'upd', patch: { title: 'upd2', fileName: 'upd2.epub' } })
  assert.deepEqual(ops[7], { op: 'removeBooklistItem', booklistId: 'lr', hash: 'upd' })
  assert.deepEqual(ops[8], { op: 'deleteAnnotation', id: 'ad' })
})

// ---- 合并代数性质 (随机) ----

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomDoc(rand, deviceId) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const maybe = (p = 0.5) => rand() < p
  // 小的时间与设备空间, 故意制造相同 stamp 不同值的情况
  const stamp = () => ({ t: Math.floor(rand() * 4), d: pick(['a', 'b', 'c']) })
  const reg = (mk) => ({ value: maybe(0.2) ? null : mk(), stamp: stamp() })
  const doc = emptyDoc(deviceId, Math.floor(rand() * 1000))
  for (const h of ['h1', 'h2', 'h3']) {
    if (!maybe(0.7)) continue
    const reading = {}
    for (const d of ['a', 'b', 'c']) if (maybe()) reading[d] = Math.floor(rand() * 5)
    doc.books[h] = {
      meta: reg(() => meta(pick(['x', 'y']), { tags: maybe() ? ['t'] : [] })),
      progress: reg(() => (maybe() ? { location: pick(['p', 'q']), lastReadAt: 1 } : {})),
      reading,
      alive: { value: maybe(), stamp: stamp() },
    }
  }
  for (const id of ['a1', 'a2']) if (maybe(0.6)) doc.annotations[id] = reg(() => anno('h1', { note: pick(['n', 'm']) }))
  for (const id of ['l1', 'l2']) if (maybe(0.6)) doc.booklists[id] = reg(() => ({ name: pick(['A', 'B']), createdAt: 1 }))
  for (const k of ['l1|h1', 'l2|h2']) {
    if (maybe(0.6)) {
      const [booklistId, bookHash] = k.split('|')
      doc.booklistItems[k] = reg(() => ({ booklistId, bookHash, addedAt: pick([1, 2]) }))
    }
  }
  for (const u of ['u1', 'u2']) if (maybe(0.6)) doc.sources[u] = reg(() => ({ title: pick(['S', 'T']), url: u, kind: 'opds', addedAt: 1 }))
  // 每日阅读记录 (可选字段; 只生成非空叶子, 与合并结果的规范形一致)
  if (maybe(0.6)) {
    const log = {}
    for (const d of ['a', 'b']) {
      for (const day of ['2026-01-01', '2026-01-02']) {
        for (const h of ['h1', 'h2']) {
          if (maybe(0.4)) ((log[d] ??= {})[day] ??= {})[h] = 1 + Math.floor(rand() * 5)
        }
      }
    }
    if (Object.keys(log).length) doc.readingLog = log
  }
  return doc
}

test('mergeDocs is commutative, associative and idempotent (randomized)', () => {
  const rand = rng(20260929)
  const ctx = { deviceId: 'm', now: 1 }
  const m = (...docs) => strip(mergeDocs(docs, ctx))
  const M = (...docs) => mergeDocs(docs, ctx)
  for (let i = 0; i < 500; i++) {
    const a = randomDoc(rand, 'a')
    const b = randomDoc(rand, 'b')
    const c = randomDoc(rand, 'c')
    const snapshot = structuredClone([a, b, c])
    assert.deepEqual(m(a, b), m(b, a), `commutative #${i}`)
    assert.deepEqual(m(M(a, b), c), m(a, M(b, c)), `associative #${i}`)
    assert.deepEqual(m(a, b, c), m(c, a, b), `n-ary order #${i}`)
    assert.deepEqual(m(a, a), strip(a), `idempotent #${i}`)
    assert.deepEqual(m(M(a, b), b), m(a, b), `absorbing #${i}`)
    assert.deepEqual([a, b, c], snapshot, 'inputs must not be mutated')
  }
})

test('source key normalization keeps mergeDocs commutative / associative / idempotent (randomized)', () => {
  const rand = rng(20261006)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const spellings = [LIB, `${LIB}/`, 'https://LIB.example.com/opds', 'https://u:p@lib.example.com/opds', 'https://lib2.example.com/opds']
  const doc = (id) => {
    const d = emptyDoc(id, 1)
    for (let i = 0; i < 3; i++) {
      if (rand() < 0.6) {
        d.sources[pick(spellings)] = {
          value: rand() < 0.2 ? null : lib({ password: pick(['a', 'b']) }),
          stamp: { t: Math.floor(rand() * 3), d: pick(['a', 'b']) },
        }
      }
    }
    return d
  }
  const ctx = { deviceId: 'm', now: 1 }
  const m = (...docs) => strip(mergeDocs(docs, ctx))
  const M = (...docs) => mergeDocs(docs, ctx)
  for (let i = 0; i < 300; i++) {
    const [a, b, c] = [doc('a'), doc('b'), doc('c')]
    assert.deepEqual(m(a, b), m(b, a), `commutative #${i}`)
    assert.deepEqual(m(M(a, b), c), m(a, M(b, c)), `associative #${i}`)
    assert.deepEqual(m(a, a), m(a), `idempotent #${i}`)
    assert.deepEqual(m(M(a)), m(a), `normalization is stable #${i}`)
  }
})

test('mergeDocs output does not alias its inputs', () => {
  const rand = rng(7)
  const a = randomDoc(rand, 'a')
  a.books.hx = { meta: { value: meta('x'), stamp: { t: 1, d: 'a' } }, progress: { value: {}, stamp: { t: 1, d: 'a' } }, reading: {}, alive: { value: true, stamp: { t: 1, d: 'a' } } }
  const out = mergeDocs([a], { deviceId: 'a', now: 2 })
  out.books.hx.meta.value.tags.push('mutated')
  assert.deepEqual(a.books.hx.meta.value.tags, [])
})

test('randomized multi-device sessions converge to identical local libraries', () => {
  const rand = rng(42)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  for (let round = 0; round < 60; round++) {
    const remote = new Map()
    const devs = [new Device('A'), new Device('B'), new Device('C')]
    let now = 100
    for (let step = 0; step < 30; step++) {
      const d = pick(devs)
      const L = d.local
      const hash = pick(['h1', 'h2', 'h3'])
      d.canDownload = () => rand() < 0.7 // 文件时有时无: 产生仅元数据的书
      if (rand() < 0.05) { d.base = null; d.present = new Set() } // 基线丢失
      const lk = pick([LIB, 'https://lib2.example.com/opds'])
      switch (Math.floor(rand() * 12)) {
        case 0: if (!L.books[hash]) L.books[hash] = book(hash); break
        case 1: if (L.books[hash]) apply(d, [{ op: 'deleteBook', hash }]); break
        case 2: if (L.books[hash]) patchBook(L.books[hash], { tags: [pick(['x', 'y'])] }); break
        case 3: if (L.books[hash]) { patchBook(L.books[hash], { location: pick(['p', 'q']), lastReadAt: now }); L.books[hash].readingSeconds += 10 } break
        case 4: if (L.books[hash]) L.annotations[`a-${hash}`] = anno(hash, { note: pick(['n', 'm']) }); break
        case 5: delete L.annotations[`a-${hash}`]; break
        case 6: L.booklists.l1 = { name: pick(['X', 'Y']), createdAt: 1 }; if (L.books[hash]) L.booklistItems[`l1|${hash}`] = { booklistId: 'l1', bookHash: hash, addedAt: 1 }; break
        case 7: apply(d, [{ op: 'deleteBooklist', id: 'l1' }]); break
        case 8: putSource(d, lib({ url: pick([lk, `${lk}/`]), password: pick(['p', 'q']) }), now - Math.floor(rand() * 30)); break
        case 9: delete L.sources[lk]; delete L.sourceTimes[lk]; break
        case 10: if (L.booklists.l1) L.booklistWanted[`w-${hash}`] = wanted('l1', hash, { note: pick(['n', 'm']) }); break
        case 11:
          // 待找条目被自动关联: 删掉条目、书单里加上这本书
          if (L.booklistWanted[`w-${hash}`]) {
            delete L.booklistWanted[`w-${hash}`]
            if (L.books[hash] && L.booklists.l1) L.booklistItems[`l1|${hash}`] = { booklistId: 'l1', bookHash: hash, addedAt: 1 }
          }
          break
      }
      now += 10
      if (rand() < 0.5) sync(d, remote, now)
    }
    // 文件都可下载后, 两轮全员同步应一致且稳定
    for (const d of devs) d.canDownload = () => true
    for (let r = 0; r < 2; r++) for (const d of devs) sync(d, remote, (now += 10))
    for (const d of devs.slice(1)) assert.deepEqual(view(d.local), view(devs[0].local), `round ${round} device ${d.id}`)
    for (const d of devs) assert.deepEqual(sync(d, remote, (now += 10)), [], `round ${round} steady ${d.id}`)
  }
})

// ---- 书单的待找条目 (booklistWanted) ----

test('wantedFrom drops empty optional fields', () => {
  assert.deepEqual(
    wantedFrom({ id: 'w', booklistId: 'l', title: 'T', author: 'A', addedAt: 3, note: '', isbn: undefined, year: 1859, originalTitle: 'O' }),
    { booklistId: 'l', title: 'T', author: 'A', addedAt: 3, year: 1859, originalTitle: 'O' },
  )
})

test('wanted entries propagate, edits are LWW, deletes become tombstones', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistWanted.w1 = wanted('l1', 'Walden')
  A.local.booklistWanted.w2 = wanted('l1', 'Moby-Dick')
  sync(A, remote, 100)
  assert.deepEqual(sync(B, remote, 200), [
    { op: 'addBooklist', id: 'l1', value: { name: 'L', createdAt: 1 } },
    { op: 'putWanted', id: 'w1', value: wanted('l1', 'Walden') },
    { op: 'putWanted', id: 'w2', value: wanted('l1', 'Moby-Dick') },
  ])
  B.local.booklistWanted.w1.note = 'read in winter'
  sync(B, remote, 300)
  assert.deepEqual(sync(A, remote, 400), [{ op: 'putWanted', id: 'w1', value: wanted('l1', 'Walden', { note: 'read in winter' }) }])
  delete A.local.booklistWanted.w2
  sync(A, remote, 500)
  assert.equal(remote.get('A').booklistWanted.w2.value, null)
  assert.deepEqual(sync(B, remote, 600), [{ op: 'deleteWanted', id: 'w2' }])
  assert.deepEqual(Object.keys(B.local.booklistWanted), ['w1'])
  assert.deepEqual(sync(A, remote, 700), [])
  assert.deepEqual(sync(B, remote, 800), [])
})

test('auto-link on one device: the entry becomes a booklist item on the other once it has the book', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistWanted.w1 = wanted('l1', 'one')
  sync(A, remote, 100)
  B.canDownload = () => false
  sync(B, remote, 200)
  // A 导入了这本书, refresh 时自动关联: 删待找条目, 书单里加上书
  A.local.books.h1 = book('one')
  delete A.local.booklistWanted.w1
  A.local.booklistItems['l1|h1'] = { booklistId: 'l1', bookHash: 'h1', addedAt: 1 }
  sync(A, remote, 300)
  // B 还没有书的文件: 条目先删掉, 书单条目等书落地
  const ops = sync(B, remote, 400)
  assert.ok(ops.some(o => o.op === 'deleteWanted' && o.id === 'w1'))
  assert.deepEqual(B.local.booklistWanted, {})
  assert.deepEqual(B.local.booklistItems, {})
  B.canDownload = () => true
  sync(B, remote, 500)
  assert.deepEqual(B.local.booklistItems, { 'l1|h1': { booklistId: 'l1', bookHash: 'h1', addedAt: 1 } })
})

test('deleting a booklist cascades its wanted entries without separate tombstones', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistWanted.w1 = wanted('l1', 'Walden')
  sync(A, remote, 100)
  sync(B, remote, 200)
  apply(A, [{ op: 'deleteBooklist', id: 'l1' }])
  sync(A, remote, 300)
  assert.equal(remote.get('A').booklists.l1.value, null)
  assert.notEqual(remote.get('A').booklistWanted.w1.value, null)
  assert.deepEqual(sync(B, remote, 400), [{ op: 'deleteBooklist', id: 'l1' }])
  assert.deepEqual(B.local.booklistWanted, {})
})

test('a booklist brought back by a newer rename keeps its wanted entries', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistWanted.w1 = wanted('l1', 'Walden')
  sync(A, remote, 100)
  sync(B, remote, 200)
  apply(B, [{ op: 'deleteBooklist', id: 'l1' }])
  sync(B, remote, 300)
  // A 并发改名 (stamp 更新): 书单连同待找条目回来
  A.local.booklists.l1.name = 'Kept'
  assert.deepEqual(sync(A, remote, 400), [])
  assert.deepEqual(sync(B, remote, 500), [
    { op: 'addBooklist', id: 'l1', value: { name: 'Kept', createdAt: 1 } },
    { op: 'putWanted', id: 'w1', value: wanted('l1', 'Walden') },
  ])
})

test('documents from older clients (no booklistWanted field) do not drop wanted entries', () => {
  const remote = new Map()
  const A = new Device('A')
  A.local.booklists.l1 = { name: 'L', createdAt: 1 }
  A.local.booklistWanted.w1 = wanted('l1', 'Walden')
  sync(A, remote, 100)
  // 旧客户端: 只认识旧集合, 写回自己的文档时没有 booklistWanted
  const { booklistWanted: _drop, ...old } = mergeDocs([...remote.values()], { deviceId: 'OLD', now: 200 })
  remote.set('OLD', old)
  const B = new Device('B')
  sync(B, remote, 300)
  assert.deepEqual(B.local.booklistWanted, { w1: wanted('l1', 'Walden') })
  assert.deepEqual(sync(A, remote, 400), [])
  const merged = mergeDocs([...remote.values()], { deviceId: 'X', now: 500 })
  assert.deepEqual(Object.keys(merged.booklistWanted), ['w1'])
  // 没有任何待找条目时文档里不写这个字段
  assert.equal(mergeDocs([old], { deviceId: 'X', now: 1 }).booklistWanted, undefined)
})

test('highlight style (issue #21) syncs as an in-place update; back to marker clears it', () => {
  const remote = new Map()
  const A = new Device('A')
  const B = new Device('B')
  A.local.books.h1 = book('one')
  A.local.annotations.a1 = anno('h1')
  sync(A, remote, 100)
  sync(B, remote, 200)
  assert.equal('style' in B.local.annotations.a1, false, 'marker highlights carry no style field')

  A.local.annotations.a1.style = 'squiggly'
  sync(A, remote, 300)
  assert.deepEqual(sync(B, remote, 400), [{ op: 'updateAnnotation', id: 'a1', patch: { style: 'squiggly' } }])
  assert.equal(B.local.annotations.a1.style, 'squiggly')

  delete B.local.annotations.a1.style
  sync(B, remote, 500)
  assert.deepEqual(sync(A, remote, 600), [{ op: 'updateAnnotation', id: 'a1', patch: { style: undefined } }])
  assert.equal('style' in A.local.annotations.a1, false)

  // 新建时带风格: 整条加过去
  B.local.annotations.a2 = anno('h1', { style: 'underline', cfi: 'epubcfi(/6/10)' })
  sync(B, remote, 700)
  sync(A, remote, 800)
  assert.equal(A.local.annotations.a2.style, 'underline')
})
