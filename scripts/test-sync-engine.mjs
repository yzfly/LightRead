// 同步引擎 + WebDAV 后端端到端契约: 内存假书库 × 内存假 WebDAV 服务器 × 内存基线.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runSync, sha256Hex } from '../src/services/sync/engine.ts'
import { createWebdavRemote, parsePropfindNames } from '../src/services/sync/webdavRemote.ts'
import { createMemorySyncStore } from '../src/services/sync/baseline.ts'
import { rowKey } from '../src/services/readingLog.ts'
import { errorText, redactUrls } from '../src/services/errorText.ts'
import { createFakeDav, createFakeStorage, enc, tr } from './sync-test-fakes.mjs'

// ---- 场景工具 ----
let clock = 1_700_000_000_000
const tick = (ms = 1000) => (clock += ms)

async function device(name) {
  const storage = createFakeStorage()
  await storage.init()
  return { name, storage, store: createMemorySyncStore(`dev-${name}`) }
}

const sync = (dev, dav, opts = {}) => runSync({
  storage: dev.storage,
  remote: opts.remote ?? dav.remote(),
  store: dev.store,
  syncFiles: opts.syncFiles ?? true,
  now: () => clock,
  deviceName: dev.name,
  app: 'test',
  t: tr,
  onProgress: opts.onProgress,
  readingLog: opts.readingLog,
})

const BOOK_BYTES = enc('%EPUB fake book content for sync tests')
const COVER_BYTES = enc('fake-jpeg-cover')

async function importBook(dev, extra = {}) {
  return dev.storage.addBook({
    title: '三体', author: '刘慈欣', format: 'epub', fileName: 'santi.epub',
    tags: ['科幻'], addedAt: clock, readingSeconds: 60,
    location: 'cfi-1', progress: 0.1, lastReadAt: clock, ...extra,
  }, new Blob([BOOK_BYTES]), extra.noCover ? undefined : new Blob([COVER_BYTES]))
}

const onlyBook = async dev => {
  const list = await dev.storage.listBooks()
  assert.equal(list.length, 1)
  return list[0]
}

test('已知私密内容的未缓存副本: 首次计算指纹后也不上传书目、文件或阅读记录', async () => {
  const dav = createFakeDav()
  const A = await device('private-duplicate')
  const hash = await sha256Hex(BOOK_BYTES)
  const secret = await importBook(A, { noSync: true })
  await A.store.setHash(secret, hash)
  const duplicate = await importBook(A)
  const day = '2026-10-16'
  const row = {
    key: rowKey('dev-private-duplicate', day, `id:${duplicate}`),
    device: 'dev-private-duplicate', day, bookId: duplicate,
    title: '三体', kind: 'book', seconds: 120, updatedAt: clock,
  }
  const readingLog = { list: async () => [row], addSynced: async () => {} }
  tick(); const result = await sync(A, dav, { readingLog })
  assert.equal((await A.store.getHashes()).get(duplicate), hash)
  assert.equal(result.uploadedFiles, 0)
  const doc = dav.readJson('devices/dev-private-duplicate.json')
  assert.equal(doc.books[hash], undefined)
  assert.deepEqual(doc.readingLog ?? {}, {})
})

// ---- 场景 ----

test('A → B: 书文件、标注、书单、书源沿用原 id; B 阅读 + 删标注后回到 A', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const hash = await sha256Hex(BOOK_BYTES)

  const bookA = await importBook(A)
  const annId = await A.storage.addAnnotation({
    bookId: bookA, kind: 'highlight', cfi: 'epubcfi(/6/2)', text: '给岁月以文明', color: 'yellow', createdAt: clock,
  })
  const listId = await A.storage.createBooklist('科幻书单', { createdAt: clock })
  await A.storage.addBooksToBooklist(listId, [bookA], { addedAt: clock + 5 })
  await A.storage.addSource({ title: '我的 calibre', url: 'https://calibre.local/opds', kind: 'opds', builtin: false, addedAt: clock, username: 'me', password: 'pw' })

  tick()
  const phases = []
  const r1 = await sync(A, dav, { onProgress: m => phases.push(m.split(' ')[0]) })
  assert.equal(r1.uploadedFiles, 2, '书 + 封面')
  assert.equal(r1.devices, 1)
  assert.ok(dav.files.has(`/remote.php/dav/LightRead/sync/v1/files/${hash}`))
  assert.ok(dav.files.has(`/remote.php/dav/LightRead/sync/v1/files/${hash}.cover`))
  assert.equal(dav.readJson('devices/dev-A.json').deviceId, 'dev-A')
  for (const p of ['sync.phase.scan', 'sync.phase.hash', 'sync.phase.fetch', 'sync.phase.apply', 'sync.phase.upload', 'sync.phase.save']) {
    assert.ok(phases.includes(p), `phase ${p}`)
  }

  tick()
  const r2 = await sync(B, dav)
  assert.equal(r2.downloadedBooks, 1)
  assert.equal(r2.pendingBooks, 0)
  assert.equal(r2.devices, 2)
  const bookB = await onlyBook(B)
  assert.equal(bookB.title, '三体')
  assert.equal(bookB.location, 'cfi-1')
  assert.equal(bookB.readingSeconds, 60)
  assert.equal(bookB.hasCover, true)
  assert.deepEqual(new Uint8Array(await (await B.storage.getBookFile(bookB.id)).arrayBuffer()), BOOK_BYTES)
  const annsB = await B.storage.listAnnotations(bookB.id)
  assert.deepEqual(annsB.map(a => [a.id, a.text]), [[annId, '给岁月以文明']])
  const listsB = await B.storage.listBooklists()
  assert.deepEqual(listsB.map(l => [l.id, l.name]), [[listId, '科幻书单']])
  assert.equal(listsB[0].createdAt, bookB.addedAt, '沿用创建时间')
  assert.deepEqual(await B.storage.listBooklistItems(listId), [{ bookId: bookB.id, addedAt: listsB[0].createdAt + 5 }])
  const srcB = (await B.storage.listSources()).filter(s => !s.builtin)
  assert.deepEqual(srcB.map(s => [s.url, s.username, s.password]), [['https://calibre.local/opds', 'me', 'pw']])

  // 再同步一次: 幂等
  tick()
  const r2b = await sync(B, dav)
  assert.equal(r2b.applied, 0)
  assert.equal(r2b.uploadedFiles, 0)

  // B 阅读并删掉标注
  tick(60_000)
  await B.storage.updateBook(bookB.id, { location: 'cfi-2', progress: 0.5, lastReadAt: clock, readingSeconds: 60 + 120 })
  await B.storage.deleteAnnotation(annId)
  tick()
  await sync(B, dav)

  tick()
  const r3 = await sync(A, dav)
  assert.ok(r3.applied >= 2)
  const a = await A.storage.getBook(bookA)
  assert.equal(a.location, 'cfi-2')
  assert.equal(a.progress, 0.5)
  assert.equal(a.readingSeconds, 180)
  assert.deepEqual(await A.storage.listAnnotations(bookA), [])

  // 两边再各同步一次后收敛, 且时长不重复计算
  tick()
  await sync(B, dav)
  tick()
  const r4 = await sync(A, dav)
  assert.equal(r4.applied, 0)
  assert.equal((await A.storage.getBook(bookA)).readingSeconds, 180)
  assert.equal((await onlyBook(B)).readingSeconds, 180)
})

test('A 删书后 B 也删除; 仅元数据的书不会因本地没有而被删', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const C = await device('C')
  const bookA = await importBook(A)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  tick(); await sync(C, dav, { syncFiles: false }) // C 只有元数据
  tick(); await sync(C, dav, { syncFiles: false })
  assert.equal((await C.storage.listBooks()).length, 0)

  await A.storage.deleteBook(bookA)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  assert.equal((await B.storage.listBooks()).length, 0)
  const hash = await sha256Hex(BOOK_BYTES)
  assert.equal(dav.readJson('devices/dev-B.json').books[hash].alive.value, false)
})

test('不同步书籍文件: B 只拿到元数据 (pending), 之后导入同一文件时匹配进度与标注', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const bookA = await importBook(A, { location: 'cfi-9', progress: 0.9 })
  const annId = await A.storage.addAnnotation({
    bookId: bookA, kind: 'highlight', cfi: 'epubcfi(/6/4)', text: '弱小和无知不是生存的障碍', color: 'red', createdAt: clock,
  })
  tick(); await sync(A, dav, { syncFiles: false })
  assert.equal([...dav.files.keys()].filter(k => k.includes('/files/')).length, 0, '不上传文件')

  tick()
  const r = await sync(B, dav, { syncFiles: false })
  assert.equal(r.pendingBooks, 1)
  assert.equal(r.downloadedBooks, 0)
  assert.equal((await B.storage.listBooks()).length, 0)

  // 文件关着时远端有文件也不下载
  tick(); await sync(A, dav) // A 开启文件同步, 上传
  tick()
  const r2 = await sync(B, dav, { syncFiles: false })
  assert.equal(r2.pendingBooks, 1)

  // B 自己导入同一本书 (新的本地 id, 没有阅读记录)
  tick(60_000)
  const bookB = await B.storage.addBook({
    title: '三体', author: '刘慈欣', format: 'epub', fileName: 'santi-copy.epub', tags: [], addedAt: clock,
  }, new Blob([BOOK_BYTES]))
  tick()
  const r3 = await sync(B, dav, { syncFiles: false })
  assert.equal(r3.pendingBooks, 0)
  const b = await B.storage.getBook(bookB)
  assert.equal(b.location, 'cfi-9', '沿用 A 的阅读位置')
  assert.equal(b.progress, 0.9)
  assert.equal(b.readingSeconds, 60)
  assert.deepEqual((await B.storage.listAnnotations(bookB)).map(a => a.id), [annId])
})

test('基线属于别的远端时作废: 不产生删除, 只做并集', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  await importBook(B)
  tick(); await sync(B, dav)
  const hash = await sha256Hex(BOOK_BYTES)
  const remoteId = dav.remote().id

  // A 的基线说"上次这本书在本地", 但基线来自另一个远端 → 应忽略, 书被下载而不是被删
  const bDoc = (await B.store.loadBaseline()).doc
  await A.store.saveBaseline({ remoteId: 'webdav:https://other.example.com#x', doc: bDoc, presentHashes: [hash], syncedAt: clock })
  tick()
  const r = await sync(A, dav)
  assert.equal(r.downloadedBooks, 1)
  assert.equal(dav.readJson('devices/dev-A.json').books[hash].alive.value, true)
  assert.equal((await A.store.loadBaseline()).remoteId, remoteId)

  // 对照: 基线属于当前远端时, 同样的情形就是"本地删了这本书"
  const A2 = await device('A2')
  await A2.store.saveBaseline({ remoteId, doc: bDoc, presentHashes: [hash], syncedAt: clock })
  tick()
  const r2 = await sync(A2, dav)
  assert.equal(r2.downloadedBooks, 0)
  assert.equal(dav.readJson('devices/dev-A2.json').books[hash].alive.value, false)
})

test('私人书库: 两台设备各自添加同一书库只留一条; 编辑按修改时间胜出且本地 id 不变; 删除不复活; 内置书源不同步', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const custom = async dev => (await dev.storage.listSources()).filter(s => !s.builtin)
  const LIB = 'https://lib.example.com/opds'

  // B 先添加 (地址多一个斜杠、主机名大写), A 后添加 (带账号密码) → A 的修改更晚, 合并后两边都是 A 的版本
  await B.storage.addSource({ title: '书库 B', url: 'https://LIB.example.com/opds/', kind: 'opds', builtin: false, addedAt: clock, updatedAt: clock })
  tick()
  await A.storage.addSource({ title: '我的私人书库', url: LIB, kind: 'opds', builtin: false, addedAt: clock, updatedAt: clock, username: 'me', password: 'pw' })
  tick(); await sync(A, dav)
  const docA = dav.readJson('devices/dev-A.json')
  assert.deepEqual(Object.keys(docA.sources), [LIB], '键是规范化地址; 内置书源不进文档')
  assert.equal(docA.sources[LIB].value.password, 'pw', '账号密码随记录同步')
  assert.equal(docA.sources[LIB].stamp.t, clock - 1000, 'stamp.t 是修改时间')
  const [bBefore] = await custom(B)
  tick(); await sync(B, dav)
  tick(); await sync(A, dav)
  const [srcA] = await custom(A)
  const [srcB] = await custom(B)
  assert.equal((await custom(B)).length, 1, '不重复')
  assert.equal(srcB.id, bBefore.id, '原地改写, 本地 id 不变')
  for (const s of [srcA, srcB]) {
    assert.deepEqual([s.title, s.url, s.username, s.password], ['我的私人书库', LIB, 'me', 'pw'])
  }
  assert.equal(srcB.updatedAt, docA.sources[LIB].stamp.t, '落地时记下胜出方的修改时间')

  // B 改密码 → A 收到, A 的本地 id 不变
  tick()
  await B.storage.updateSource(srcB.id, { ...srcB, password: 'pw2', updatedAt: clock })
  tick(); await sync(B, dav)
  tick(); const rA = await sync(A, dav)
  assert.equal(rA.applied, 1)
  const [srcA2] = await custom(A)
  assert.equal(srcA2.id, srcA.id)
  assert.equal(srcA2.password, 'pw2')

  // A 删除 → B 删除; 再同步不复活
  await A.storage.deleteSource(srcA.id)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  assert.deepEqual(await custom(B), [])
  tick(); assert.equal((await sync(B, dav)).applied, 0)
  tick(); assert.equal((await sync(A, dav)).applied, 0)
  assert.deepEqual(await custom(A), [])
  assert.equal((await A.storage.listSources()).filter(s => s.builtin).length, 1, '内置书源不受影响')
  assert.equal(dav.readJson('devices/dev-B.json').sources[LIB].value, null)

  // 与内置书源同地址的自定义书源: 在 A 上保留, B 不落地也不删
  await A.storage.addSource({ title: 'Gutenberg 副本', url: 'https://www.gutenberg.org/ebooks.opds', kind: 'opds', builtin: false, addedAt: clock, updatedAt: clock })
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  tick(); await sync(B, dav)
  tick(); await sync(A, dav)
  assert.equal((await custom(A)).length, 1)
  assert.equal((await custom(B)).length, 0)
  assert.equal((await B.storage.listSources()).length, 1)
})

test('同内容多本只取 addedAt 最早的一本; hash 有缓存只算一次', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const early = await importBook(A, { addedAt: clock - 10_000, title: '早' })
  await importBook(A, { title: '晚' })
  const reads = []
  const orig = A.storage.getBookFile
  A.storage.getBookFile = async id => { reads.push(id); return orig(id) }
  tick(); await sync(A, dav, { syncFiles: false })
  assert.equal(reads.length, 2)
  const hash = await sha256Hex(BOOK_BYTES)
  const doc = dav.readJson('devices/dev-A.json')
  assert.deepEqual(Object.keys(doc.books), [hash])
  assert.equal(doc.books[hash].meta.value.title, '早')
  tick(); await sync(A, dav, { syncFiles: false })
  assert.equal(reads.length, 2, '第二次同步走 hash 缓存')
  assert.ok((await A.store.getHashes()).get(early) === hash)
})

test('WebDAV: 目录创建、401 映射、损坏文件跳过、href 解析', async () => {
  const dav = createFakeDav()
  const remote = dav.remote()
  assert.equal(remote.id, 'webdav:https://dav.example.com/remote.php/dav#u')
  assert.equal(remote.supportsFiles, true)
  await remote.prepare()
  assert.ok(dav.log.some(l => l.startsWith('MKCOL') && l.endsWith('/sync/v1/files/')))
  const n = dav.log.length
  await remote.prepare()
  assert.equal(dav.log.slice(n).filter(l => l.startsWith('MKCOL')).length, 0, '已存在时不再 MKCOL')

  assert.deepEqual(await remote.listDocs(), [])
  assert.deepEqual([...await remote.listFiles()], [])
  assert.equal(await remote.getFile('nope'), null)

  const doc = { format: 1, deviceId: 'x', writtenAt: 1, books: {}, annotations: {}, booklists: {}, booklistItems: {}, sources: {} }
  await remote.putDoc(doc)
  dav.files.set('/remote.php/dav/LightRead/sync/v1/devices/broken.json', enc('{not json'))
  dav.files.set('/remote.php/dav/LightRead/sync/v1/devices/future.json', enc(JSON.stringify({ ...doc, deviceId: 'y', format: 2 })))
  dav.files.set('/remote.php/dav/LightRead/sync/v1/devices/readme.txt', enc('hi'))
  assert.deepEqual((await remote.listDocs()).map(d => d.deviceId), ['x'])

  await remote.putFile('abc', new Blob([enc('data')]))
  assert.deepEqual([...await remote.listFiles()], ['abc'])
  assert.equal(await (await remote.getFile('abc')).text(), 'data')

  dav.authFail = true
  await assert.rejects(remote.listDocs(), { message: 'sync.err.auth' })
  dav.authFail = false
  const bad = createWebdavRemote({ url: 'https://x', user: '', pass: '' }, async () => ({ status: 500, text: async () => '', blob: async () => new Blob() }), tr)
  await assert.rejects(bad.putDoc(doc), { message: 'sync.err.http {"status":500}' })

  const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:">
    <response><href>/dav/LightRead/sync/v1/files</href></response>
    <response><href>https://h/dav/LightRead/sync/v1/files/a%20b.cover</href></response>
    <response><lp1:href xmlns:lp1="DAV:">/dav/LightRead/sync/v1/files/c&amp;d</lp1:href></response>
    <response><d:href>/dav/LightRead/sync/v1/files/sub/</d:href></response>
  </multistatus>`
  assert.deepEqual(parsePropfindNames(xml, 'files'), ['a b.cover', 'c&d'])
})

test('先写文档再传文件: 上传失败 / 中断时文档已写入, B 先拿到元数据, 文件到位后再下载', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const hash = await sha256Hex(BOOK_BYTES)
  const bookA = await importBook(A)
  // 文件系统后端提供本地文件引用; 注入的 HTTP 函数收到的仍是读出来的 Blob
  const refs = []
  A.storage.getBookFileRef = async id => {
    refs.push(id)
    return { kind: 'local-file', root: '', rel: `books/${id}.epub`, blob: () => A.storage.getBookFile(id) }
  }

  // 1) 书文件上传失败: 文档与基线照样写入, 失败的文件下次再传
  let mode = 'fail'
  let release
  const filePuts = []
  const http = async (url, req) => {
    if (req.method === 'PUT' && url.includes('/files/')) {
      filePuts.push(url)
      if (mode === 'fail') return { status: 507, text: async () => '', blob: async () => new Blob() }
      if (mode === 'hang') {
        await new Promise((_, reject) => { release = () => reject(new Error('killed')) })
      }
    }
    return dav.http(url, req)
  }
  const remote = () => createWebdavRemote({ url: dav.base + '/', user: 'u', pass: 'p' }, http, tr)

  tick()
  const r1 = await sync(A, dav, { remote: remote() })
  assert.equal(r1.uploadedFiles, 0)
  assert.equal(filePuts.length, 1, '书文件失败后这本书的封面也留到下次')
  assert.equal(dav.readJson('devices/dev-A.json').books[hash].alive.value, true)
  assert.deepEqual((await A.store.loadBaseline()).presentHashes, [hash])
  assert.deepEqual(refs, [bookA], '书文件走本地文件引用')

  // B: 文件还没到位, 只拿到元数据 (pending), 也不会因此生成删除
  tick()
  const r2 = await sync(B, dav, { remote: remote() })
  assert.equal(r2.pendingBooks, 1)
  assert.equal(r2.downloadedBooks, 0)
  assert.deepEqual(await B.storage.listBooks(), [])
  assert.equal(dav.readJson('devices/dev-B.json').books[hash].alive.value, true)

  // 2) 上传中途被杀 (请求挂住): 文档在上传开始前就已写入
  mode = 'hang'
  await A.storage.updateBook(bookA, { location: 'cfi-9', progress: 0.9, lastReadAt: tick() })
  tick()
  const phases = []
  const pending = sync(A, dav, { remote: remote(), onProgress: m => phases.push(m) })
  while (!release) await new Promise(r => setImmediate(r))
  assert.equal(dav.readJson('devices/dev-A.json').books[hash].progress.value.location, 'cfi-9')
  assert.ok(phases.includes('sync.phase.save'))
  assert.ok(phases.some(p => p.startsWith('sync.phase.upload') && p.includes('"done":1,"total":1')), phases.join('\n'))
  release()
  assert.equal((await pending).uploadedFiles, 0)

  // 3) A 恢复上传; B 下次同步下载到文件, 进度是最新的
  mode = 'ok'
  tick()
  const r3 = await sync(A, dav, { remote: remote() })
  assert.equal(r3.uploadedFiles, 2, '书 + 封面')
  assert.ok(dav.files.has(`/remote.php/dav/LightRead/sync/v1/files/${hash}`))
  tick()
  const r4 = await sync(B, dav, { remote: remote() })
  assert.equal(r4.downloadedBooks, 1)
  assert.equal(r4.pendingBooks, 0)
  const bookB = await onlyBook(B)
  assert.equal(bookB.location, 'cfi-9')
  assert.equal(bookB.hasCover, true)
  assert.deepEqual(new Uint8Array(await (await B.storage.getBookFile(bookB.id)).arrayBuffer()), BOOK_BYTES)
})

test('WebDAV: 请求整体超时 → sync.err.timeout, 并中止请求', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  const hang = async (_url, req) => {
    signal = req.signal
    return new Promise(() => {})
  }
  const remote = createWebdavRemote({ url: 'https://dav.example.com/', user: 'u', pass: 'p' }, hang, tr)
  const p = remote.listDocs()
  t.mock.timers.tick(59_999)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await assert.rejects(p, { message: 'sync.err.timeout' })
  assert.equal(signal.aborted, true)

  // 原生上传命令报的超时 (code: 'timeout') 同样映射
  const nativeTimeout = createWebdavRemote({ url: 'https://x/', user: '', pass: '' }, async () => {
    throw Object.assign(new Error('operation timed out'), { code: 'timeout' })
  }, tr)
  await assert.rejects(nativeTimeout.putFile('abc', new Blob([enc('x')])), { message: 'sync.err.timeout' })
})

test('WebDAV: 网络层失败 → webdav.err.network, 不把请求地址带进报错', async () => {
  const raw = 'error sending request for url (https://dav.example.com/dav/LightRead/sync/v1/devices/)'
  const down = createWebdavRemote({ url: 'https://dav.example.com/dav/', user: 'u', pass: 'p' }, async () => {
    throw raw // plugin-http 抛的是字符串
  }, tr)
  await assert.rejects(down.listDocs(), { message: 'webdav.err.network' })
  // 读响应正文时断开同样映射
  const cut = createWebdavRemote({ url: 'https://dav.example.com/dav/', user: 'u', pass: 'p' }, async () => ({
    status: 207, text: async () => { throw new TypeError('Load failed') }, blob: async () => new Blob(),
  }), tr)
  await assert.rejects(cut.listDocs(), { message: 'webdav.err.network' })
  // 我们自己的 HTTP 状态报错不受影响
  const http500 = createWebdavRemote({ url: 'https://x/', user: '', pass: '' }, async () => ({
    status: 500, text: async () => '', blob: async () => new Blob(),
  }), tr)
  await assert.rejects(http500.listDocs(), { message: 'sync.err.http {"status":500}' })
})

test('WebDAV: 连接被对方重置时立即重试一次; DNS / 连不上不重试', async () => {
  const reset = 'error sending request for url (https://dav.example.com/x): client error (SendRequest): connection error: 远程主机强迫关闭了一个现有的连接。 (os error 10054)'
  const dav = createFakeDav()
  let puts = 0
  const flaky = createWebdavRemote({ url: dav.base + '/', user: 'u', pass: 'p' }, async (url, req) => {
    if (req.method === 'PUT' && ++puts === 1) throw new Error(reset)
    return dav.http(url, req)
  }, tr)
  await flaky.prepare()
  await flaky.putFile('abc', new Blob([enc('data')]))
  assert.equal(puts, 2, 'one retry')
  assert.ok(dav.files.has('/remote.php/dav/LightRead/sync/v1/files/abc'))
  // 一直被重置: 只重试一次, 报网络错误
  let n = 0
  const dead = createWebdavRemote({ url: 'https://dav.example.com/', user: 'u', pass: 'p' }, async () => { n++; throw new Error('connection closed before message completed') }, tr)
  await assert.rejects(dead.putFile('abc', new Blob([enc('x')])), { message: 'webdav.err.network' })
  assert.equal(n, 2)
  // DNS 失败重试也没用
  let m = 0
  const dns = createWebdavRemote({ url: 'https://dav.example.com/', user: 'u', pass: 'p' }, async () => { m++; throw new Error('client error (Connect): dns error: 不知道这样的主机。 (os error 11001)') }, tr)
  await assert.rejects(dns.putFile('abc', new Blob([enc('x')])), { message: 'webdav.err.network' })
  assert.equal(m, 1)
})

test('断网时: 第一个文件上传连不上就停, 不再逐个试剩下的书', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  for (const title of ['一', '二', '三']) {
    await A.storage.addBook({ title, author: 'x', format: 'epub', fileName: `${title}.epub`, tags: [], addedAt: tick(), readingSeconds: 0, location: '', progress: 0, lastReadAt: clock }, new Blob([enc(`book ${title}`)]))
  }
  let filePuts = 0
  const http = async (url, req) => {
    if (req.method === 'PUT' && url.includes('/files/')) {
      filePuts++
      throw new Error('client error (Connect): dns error: 不知道这样的主机。 (os error 11001)')
    }
    return dav.http(url, req)
  }
  tick()
  const r = await sync(A, dav, { remote: createWebdavRemote({ url: dav.base + '/', user: 'u', pass: 'p' }, http, tr) })
  assert.equal(r.uploadedFiles, 0)
  assert.equal(filePuts, 1)
  assert.equal(Object.keys(dav.readJson('devices/dev-A.json').books).length, 3, '书目照常写入')
})

test('errorText: 本地化文案原样展示, 原始技术报错换成兜底; redactUrls 去掉漏网地址', () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(errorText(new Error('网盘账号或密码不对，点「修改」重新填写'), 'x'), '网盘账号或密码不对，点「修改」重新填写')
    assert.equal(errorText(new Error('Could not sync. Check your connection and try again'), 'x'), 'Could not sync. Check your connection and try again')
    for (const raw of [
      'error sending request for url (https://dav.jianguoyun.com/dav/LightRead/)',
      new TypeError('Failed to fetch'),
      'TypeError: Load failed',
      'NetworkError when attempting to fetch resource.',
      'tcp connect error: Connection refused (os error 111)',
      'invalid peer certificate: UnknownIssuer',
      new Error('x'.repeat(400)),
      { message: 'http://127.0.0.1:8787/api/sync' },
    ]) assert.equal(errorText(raw, '兜底'), '兜底', String(raw?.message ?? raw))
    assert.equal(errorText(null, '兜底'), '兜底')
    assert.equal(errorText(new Error(''), ''), '')
  } finally {
    console.warn = warn
  }
  assert.equal(redactUrls('同步失败：error sending request for url (https://a.example.com/x?y=1)'), '同步失败：error sending request')
  assert.equal(redactUrls('下载失败（https://a.example.com/b.epub）'), '下载失败')
  assert.equal(redactUrls('没有地址的提示'), '没有地址的提示')
  assert.ok(!/https?:/.test(redactUrls('see http://a.b/c and https://d.e/f')))
})

test('书单的待找条目: A → B 沿用 id; B 删除后回到 A; 删除书单级联', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const listId = await A.storage.createBooklist('想读', { createdAt: clock })
  await A.storage.putBooklistWanted([
    { id: 'w-1', booklistId: listId, title: '理想国', author: '柏拉图', originalTitle: 'The Republic', originalAuthor: 'Plato', year: -375, addedAt: clock },
    { id: 'w-2', booklistId: listId, title: '瓦尔登湖', author: '梭罗', note: '', addedAt: clock + 1 },
  ])
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  assert.deepEqual((await B.storage.listBooklistWanted()).map(w => [w.id, w.booklistId, w.title, w.year ?? null, w.originalTitle ?? null]), [
    ['w-1', listId, '理想国', -375, 'The Republic'],
    ['w-2', listId, '瓦尔登湖', null, null],
  ])
  tick(); assert.equal((await sync(B, dav)).applied, 0, '幂等')

  await B.storage.deleteBooklistWanted(['w-2'])
  tick(); await sync(B, dav)
  tick(); await sync(A, dav)
  assert.deepEqual((await A.storage.listBooklistWanted()).map(w => w.id), ['w-1'])

  await A.storage.deleteBooklist(listId)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  assert.deepEqual(await B.storage.listBooklists(), [])
  assert.deepEqual(await B.storage.listBooklistWanted(), [])
})

test('私密书: 不上传、不发出改动、不落地别人的改动; 设为私密不会删掉其他设备上的书', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const hash = await sha256Hex(BOOK_BYTES)

  // 从未同步过就设为私密: 不上传, B 看不到
  const secret = await A.storage.addBook({
    title: '日记', author: '', format: 'txt', fileName: 'diary.txt', tags: [], addedAt: clock, noSync: true,
  }, new Blob([enc('dear diary')]))
  const bookA = await importBook(A)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  assert.deepEqual((await B.storage.listBooks()).map(b => b.title), ['三体'])
  assert.equal([...dav.files.keys()].filter(k => k.includes('/files/') && !k.endsWith('.cover')).length, 1)
  assert.ok(await A.storage.getBook(secret))

  // A 把已同步的书设为私密, 之后读书、划线; B 也读了
  await A.storage.updateBook(bookA, { noSync: true })
  tick(); await sync(A, dav)
  tick(60_000)
  await A.storage.updateBook(bookA, { location: 'cfi-private', progress: 0.9, lastReadAt: clock, readingSeconds: 600 })
  await A.storage.addAnnotation({ bookId: bookA, kind: 'highlight', cfi: 'epubcfi(/6/8)', text: '私密划线', color: 'yellow', createdAt: clock })
  const bookB = (await onlyBook(B)).id
  await B.storage.updateBook(bookB, { location: 'cfi-b', progress: 0.3, lastReadAt: clock + 1 })
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  tick(); await sync(A, dav)
  const b = await onlyBook(B)
  assert.equal(b.location, 'cfi-b', 'A 的私密进度不外发')
  assert.deepEqual(await B.storage.listAnnotations(b.id), [])
  const a = await A.storage.getBook(bookA)
  assert.equal(a.location, 'cfi-private', 'B 的进度不落到私密书上')
  assert.equal((await A.storage.listAnnotations(bookA)).length, 1)

  // A 删掉私密书: B 上的不受影响; A 也不会因「本地没有」再把它下载回来
  await A.storage.deleteBook(bookA)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  assert.equal((await B.storage.listBooks()).length, 1)
  assert.equal(dav.readJson('devices/dev-A.json').books[hash].alive.value, true)
})

test('私密书取消私密后: 期间的进度与标注照常同步出去', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  const bookA = await importBook(A)
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)

  await A.storage.updateBook(bookA, { noSync: true })
  tick(); await sync(A, dav)
  tick(60_000)
  await A.storage.updateBook(bookA, { location: 'cfi-later', progress: 0.7, lastReadAt: clock })
  const annId = await A.storage.addAnnotation({ bookId: bookA, kind: 'highlight', cfi: 'epubcfi(/6/4)', text: '后来的划线', color: 'blue', createdAt: clock })
  tick(); await sync(A, dav)

  await A.storage.updateBook(bookA, { noSync: false })
  tick(); await sync(A, dav)
  tick(); await sync(B, dav)
  const b = await onlyBook(B)
  assert.equal(b.location, 'cfi-later')
  assert.deepEqual((await B.storage.listAnnotations(b.id)).map(x => x.id), [annId])
  assert.equal((await A.storage.listBooks()).length, 1, '不会重复下载')
})
