// 设置同步: settingsSync 纯函数 (归类 / 预设 / 修改时间 / LWW / 密钥) + engine 端到端 (假 WebDAV、假账号服务器).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runSync } from '../src/services/sync/engine.ts'
import { createMemorySyncStore } from '../src/services/sync/baseline.ts'
import { mergeDocs, mergeSettingRegs } from '../src/services/sync/merge.ts'
import {
  ALL_SYNC_PATHS, LOCAL_SETTING_PATHS, SECRET_SETTING_PATHS, SETTINGS_SYNC_SPEC,
  buildSettingsRegs, createSettingsSyncPort, initSettingsMeta, planSettingsApply, readSyncedSettings,
  recordSettingsChanges, writeSyncedSetting,
} from '../src/services/sync/settingsSync.ts'
import { createPinia } from 'pinia'
import { useSettings, settingsDefaults } from '../src/stores/settings.ts'
import { createFakeAccountServer, createFakeDav, createFakeStorage, tr } from './sync-test-fakes.mjs'

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)
const reg = (value, t, d) => ({ value, stamp: { t, d } })

// ---- 归类 ----

test('每个默认设置都已归类 (sync / secret / local), 归类表没有多余的键', () => {
  const walk = (defaults, spec, prefix) => {
    for (const k of Object.keys(defaults)) {
      const path = prefix ? `${prefix}.${k}` : k
      assert.ok(k in spec, `设置 ${path} 没有在 SETTINGS_SYNC_SPEC 里归类`)
      if (typeof spec[k] === 'object') {
        assert.ok(isObj(defaults[k]), `${path} 按子键归类, 默认值应为对象`)
        walk(defaults[k], spec[k], path)
      } else {
        assert.ok(['sync', 'secret', 'local'].includes(spec[k]), path)
      }
    }
    for (const k of Object.keys(spec)) {
      assert.ok(k in defaults, `归类表里的 ${prefix ? `${prefix}.` : ''}${k} 不是设置项`)
    }
  }
  walk(settingsDefaults(), SETTINGS_SYNC_SPEC, '')
  assert.deepEqual([...SECRET_SETTING_PATHS].sort(), ['aiApiKey', 'doubaoApiKey', 'doubaoAppId', 'minimaxApiKey', 'webdavPass'])
  for (const p of [
    'libraryRoot', 'calibrePath', 'customFonts', 'httpProxy', 'corsProxy', 'paperAgentEngine',
    'paperAgentExecutables', 'usageStats', 'syncSettings', 'syncSecrets', 'version', 'webdavSyncAuto',
    'webdavSyncFiles', 'ttsEngine', 'ttsVoice', 'dianjing.perBook', 'dianjing.fiction', 'readingMode.presets',
    'readingMode.eink', 'readingMode.largeText',
  ]) assert.ok(LOCAL_SETTING_PATHS.includes(p), `${p} 应只属于本机`)
  for (const p of ['reader.theme', 'reader.fontSize', 'appearance', 'language', 'webdavUrl', 'webdavUser',
    'webdavProvider', 'aiProvider', 'aiBaseUrl', 'aiModel', 'readingMode.typewriter.cpm', 'ambient.layers',
    'features.recommendedBooklists', 'features.transfer', 'dianjing.level', 'readingMode.wordGuide.enabled',
    'readingMode.wordGuide.intensity', 'readingMode.wordGuide.color', 'readingMode.wordGuide.mark', 'dianjing.density',
    'dianjing.kinds']) {
    assert.ok(ALL_SYNC_PATHS.includes(p), `${p} 应同步`)
  }
  const values = readSyncedSettings(settingsDefaults())
  assert.deepEqual(Object.keys(values).sort(), [...ALL_SYNC_PATHS])
  assert.ok(!('libraryRoot' in values) && !('reader' in values))
})

test('点睛阅读: 版本 (基础 / 智能) 默认基础版并随同步, 按书开关只属于本机', () => {
  assert.equal(settingsDefaults().dianjing.level, 'basic')
  assert.equal(settingsDefaults().readingMode.wordGuide.enabled, false)
  assert.equal(SETTINGS_SYNC_SPEC.dianjing.level, 'sync')
  assert.equal(SETTINGS_SYNC_SPEC.dianjing.perBook, 'local')
})

test('点睛阅读基础版「标什么」: 新安装默认重点词, 老存档没有这个字段时保持词与词; 随同步; 智能版的重点词默认勾上', async () => {
  const { savedBasicMark } = await import('../src/services/dianjing/level.ts')
  assert.equal(settingsDefaults().readingMode.wordGuide.mark, 'keywords')
  assert.equal(savedBasicMark(undefined), 'boundary')
  assert.equal(savedBasicMark('bogus'), 'boundary')
  assert.equal(savedBasicMark('keywords'), 'keywords')
  assert.equal(savedBasicMark('boundary'), 'boundary')
  assert.equal(SETTINGS_SYNC_SPEC.readingMode.wordGuide.mark, 'sync')
  assert.equal(SETTINGS_SYNC_SPEC.dianjing.density, 'sync')
  assert.equal(settingsDefaults().dianjing.density, 'normal')
  assert.equal(settingsDefaults().dianjing.kinds.kw, true)
})

test('可选功能 (书单推荐 / 互传) 默认关闭, 作为使用偏好随同步', () => {
  assert.deepEqual(settingsDefaults().features, { recommendedBooklists: false, transfer: false })
  assert.deepEqual(SETTINGS_SYNC_SPEC.features, { recommendedBooklists: 'sync', transfer: 'sync' })
})

test('分栏默认自动, 旧自动双栏迁移, 手动选择持久化与同步', () => {
  const previous = globalThis.localStorage
  try {
    assert.equal(settingsDefaults().reader.maxColumnCount, 'auto')
    for (const [version, saved, expected] of [
      [14, 2, 'auto'], [14, 1, 1], [14, undefined, 'auto'],
      [15, 'auto', 'auto'], [15, 1, 1], [15, 2, 2],
    ]) {
      globalThis.localStorage = { getItem: () => JSON.stringify({ version, reader: { ...(saved == null ? {} : { maxColumnCount: saved }) } }) }
      const store = useSettings(createPinia())
      assert.equal(store.reader.maxColumnCount, expected)
    }
    for (const choice of ['auto', 1, 2]) {
      const state = settingsDefaults()
      assert.ok(writeSyncedSetting(state, 'reader.maxColumnCount', choice))
      assert.equal(readSyncedSettings(state)['reader.maxColumnCount'], choice)
    }
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})

// ---- 预设 ----

test('预设临时改的键按开启前的值同步; 落地写进预设快照, 关闭预设时恢复到同步来的值', () => {
  const s = settingsDefaults()
  s.reader.fontSize = 24
  s.readingMode.typewriter.unit = 'sentence'
  s.readingMode.presets = {
    largeText: { before: { 'reader.fontSize': 18 }, applied: { 'reader.fontSize': 24 }, order: 1 },
    lyric: { before: { 'typewriter.unit': 'char' }, applied: { 'typewriter.unit': 'sentence' }, order: 2 },
  }
  let v = readSyncedSettings(s)
  assert.equal(v['reader.fontSize'], 18)
  assert.equal(v['readingMode.typewriter.unit'], 'char')

  // 落地: 写进最底层持有者的 before, 正在显示的值不动
  assert.ok(writeSyncedSetting(s, 'reader.fontSize', 20))
  assert.equal(s.reader.fontSize, 24)
  assert.equal(s.readingMode.presets.largeText.before['reader.fontSize'], 20)
  assert.equal(readSyncedSettings(s)['reader.fontSize'], 20)

  // 两层持有者: 取最底层的 before
  s.reader.fontSize = 29
  s.readingMode.presets.lyric.applied['reader.fontSize'] = 29
  s.readingMode.presets.lyric.before['reader.fontSize'] = 24
  assert.equal(readSyncedSettings(s)['reader.fontSize'], 20)

  // 用户在模式里手动改过 (当前值不是最上层写入的): 按当前值同步, 落地也直接写
  s.reader.fontSize = 31
  v = readSyncedSettings(s)
  assert.equal(v['reader.fontSize'], 31)
  writeSyncedSetting(s, 'reader.fontSize', 22)
  assert.equal(s.reader.fontSize, 22)
})

// ---- 修改时间 ----

test('修改时间: 首次见到时默认值记 0、改过的记 1; 追踪之外的改动与之后的修改记为现在且严格递增', () => {
  const d = readSyncedSettings(settingsDefaults())
  const s = settingsDefaults()
  s.reader.fontSize = 20
  const meta = initSettingsMeta(null, readSyncedSettings(s), d, 5000)
  assert.equal(meta.stamps['reader.theme'].t, 0)
  assert.equal(meta.stamps['reader.fontSize'].t, 1)

  // 重启时发现值变了 (追踪之外改的)
  s.reader.theme = 'dark'
  const meta2 = initSettingsMeta(JSON.parse(JSON.stringify(meta)), readSyncedSettings(s), d, 6000)
  assert.equal(meta2.stamps['reader.theme'].t, 6000)
  assert.equal(meta2.stamps['reader.fontSize'].t, 1)

  // 修改: 没变的不动; 时钟比已知 stamp 慢时取已知 + 1
  assert.deepEqual(recordSettingsChanges(meta2, readSyncedSettings(s), 7000), [])
  meta2.stamps['reader.lineHeight'] = { t: 9000, d: 'dev-other' }
  s.reader.lineHeight = 2.2
  s.ambient.layers = { 'rain/drops': 0.5 }
  assert.deepEqual(recordSettingsChanges(meta2, readSyncedSettings(s), 8000).sort(), ['ambient.layers', 'reader.lineHeight'])
  assert.deepEqual(meta2.stamps['reader.lineHeight'], { t: 9001 })
  assert.deepEqual(meta2.stamps['ambient.layers'], { t: 8000 })
  // 设备相关项不追踪
  s.libraryRoot = '/data'
  assert.deepEqual(recordSettingsChanges(meta2, readSyncedSettings(s), 8100), [])
})

test('buildSettingsRegs: 从没改过的不写; 密钥仅 includeSecrets 时写; 本机 stamp 写成本机 id, 收到的沿用来源', () => {
  const local = {
    values: { 'reader.theme': 'dark', 'reader.fontSize': 18, webdavPass: 'pw', aiApiKey: 'sk', webdavUrl: 'https://dav/' },
    stamps: {
      'reader.theme': { t: 100 }, 'reader.fontSize': { t: 0 }, webdavPass: { t: 50 }, aiApiKey: { t: 0 },
      webdavUrl: { t: 40, d: 'dev-B' },
    },
  }
  assert.deepEqual(buildSettingsRegs(local, 'dev-A', false), {
    'reader.theme': reg('dark', 100, 'dev-A'),
    webdavUrl: reg('https://dav/', 40, 'dev-B'),
  })
  const withSecrets = buildSettingsRegs(local, 'dev-A', true)
  assert.deepEqual(withSecrets.webdavPass, reg('pw', 50, 'dev-A'))
  assert.equal('aiApiKey' in withSecrets, false, '空密钥从没改过, 不写')
})

// ---- 合并 ----

test('mergeSettingRegs: 按路径 LWW, 交换律/结合律/幂等, 缺席不删除, 畸形寄存器跳过', () => {
  const a = { 'reader.theme': reg('dark', 10, 'A'), webdavPass: reg('old', 5, 'A'), bad: { value: null, stamp: { t: 1, d: 'A' } } }
  const b = { 'reader.theme': reg('sepia', 20, 'B'), 'reader.fontSize': reg(22, 3, 'B'), junk: 'x' }
  const c = { 'reader.fontSize': reg(19, 3, 'C') }
  const m1 = mergeSettingRegs(a, b, c)
  assert.deepEqual(m1, {
    'reader.theme': reg('sepia', 20, 'B'),
    'reader.fontSize': reg(19, 3, 'C'), // 同 t 比 d
    webdavPass: reg('old', 5, 'A'), // b、c 没带密钥: 不变
  })
  assert.deepEqual(mergeSettingRegs(c, a, b), m1)
  assert.deepEqual(mergeSettingRegs(mergeSettingRegs(a, b), c), m1)
  assert.deepEqual(mergeSettingRegs(m1, m1), m1)
  assert.equal(mergeSettingRegs(undefined, null, {}), undefined)

  // mergeDocs 带上 settings; 都没有时不写字段
  const doc = (deviceId, settings) => ({
    format: 1, deviceId, writtenAt: 1, books: {}, annotations: {}, booklists: {}, booklistItems: {}, sources: {},
    ...(settings ? { settings } : {}),
  })
  assert.deepEqual(mergeDocs([doc('A', a), doc('B', b)], { deviceId: 'A', now: 1 }).settings, mergeSettingRegs(a, b))
  assert.equal('settings' in mergeDocs([doc('A'), doc('B')], { deviceId: 'A', now: 1 }), false)
})

test('planSettingsApply: 只落地比本机新、类型相符的白名单项; 本机更新的 (含没发出去的密钥) 不被盖掉', () => {
  const local = {
    values: { 'reader.theme': 'light', 'reader.fontSize': 18, aiApiKey: 'mine', webdavUrl: 'https://a/', githubBookRepos: [] },
    stamps: { 'reader.theme': { t: 10 }, 'reader.fontSize': { t: 0 }, aiApiKey: { t: 500 }, webdavUrl: { t: 30 } },
  }
  const merged = {
    'reader.theme': reg('dark', 20, 'B'), // 更新: 落地
    'reader.fontSize': reg('huge', 40, 'B'), // 类型不符: 跳过
    aiApiKey: reg('theirs', 100, 'B'), // 本机密钥改得更晚 (没发出去): 不落地
    webdavUrl: reg('https://a/', 50, 'B'), // 值相同 stamp 更新: 只记下 stamp
    githubBookRepos: reg(['x/y'], 5, 'B'),
    libraryRoot: reg('/evil', 999, 'B'), // 设备相关项: 永不落地
    'future.setting': reg(1, 999, 'B'), // 不认识的路径: 不落地
  }
  const plan = planSettingsApply(merged, local, 'A')
  assert.deepEqual(plan, [
    { path: 'githubBookRepos', value: ['x/y'], stamp: { t: 5, d: 'B' }, changed: true },
    { path: 'reader.theme', value: 'dark', stamp: { t: 20, d: 'B' }, changed: true },
    { path: 'webdavUrl', value: 'https://a/', stamp: { t: 50, d: 'B' }, changed: false },
  ])
  assert.deepEqual(planSettingsApply(undefined, local, 'A'), [])
})

test('端口: 落地同时更新快照与修改时间, 不会被记成本机修改', () => {
  const state = settingsDefaults()
  const meta = initSettingsMeta(null, readSyncedSettings(state), readSyncedSettings(settingsDefaults()), 1000)
  let saves = 0
  const port = createSettingsSyncPort({ state: () => state, meta, includeSecrets: false, now: () => 2000, onMetaChange: () => saves++ })
  state.appearance = 'dark' // 同步前一刻的修改 (watch 还没来得及记): read() 补记
  const local = port.read()
  assert.deepEqual(local.stamps.appearance, { t: 2000 })
  port.apply([{ path: 'reader.theme', value: 'sepia', stamp: { t: 3000, d: 'B' }, changed: true }])
  assert.equal(state.reader.theme, 'sepia')
  assert.deepEqual(meta.stamps['reader.theme'], { t: 3000, d: 'B' })
  assert.deepEqual(recordSettingsChanges(meta, readSyncedSettings(state), 4000), [])
  assert.equal(saves, 2)
})

// ---- engine 端到端 ----

let clock = 1_900_000_000_000
const tick = (ms = 1000) => (clock += ms)

async function device(name, opts = {}) {
  const storage = createFakeStorage()
  await storage.init()
  const settings = settingsDefaults()
  const dev = {
    name, storage, store: createMemorySyncStore(`dev-${name}`), settings,
    meta: initSettingsMeta(null, readSyncedSettings(settings), readSyncedSettings(settingsDefaults()), clock),
    syncSettings: opts.syncSettings ?? true,
    syncSecrets: opts.syncSecrets ?? false,
  }
  return dev
}

/** 用户修改设置: 同应用里 settingsTracker 的 watch, 修改当时就记下修改时间 */
function edit(dev, fn) {
  fn(dev.settings)
  recordSettingsChanges(dev.meta, readSyncedSettings(dev.settings), clock)
}

const sync = (dev, remote) => {
  tick()
  return runSync({
    storage: dev.storage,
    remote,
    store: dev.store,
    syncFiles: true,
    now: () => clock,
    deviceName: dev.name,
    app: 'test',
    t: tr,
    settings: dev.syncSettings
      ? createSettingsSyncPort({ state: () => dev.settings, meta: dev.meta, includeSecrets: dev.syncSecrets, now: () => clock })
      : undefined,
  })
}

test('两台设备经 WebDAV: 主题 / 字号 / WebDAV 地址同步过去, 设备相关项不动; 收到后不来回打架', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  tick()
  A.settings.reader.theme = 'dark'
  A.settings.reader.fontSize = 22
  A.settings.layoutOverrides.reader.fontSize = true
  A.settings.webdavUrl = 'https://dav.jianguoyun.com/dav/'
  A.settings.webdavUser = 'me@x.com'
  A.settings.webdavProvider = 'jianguoyun'
  A.settings.webdavPass = 'app-pass'
  A.settings.libraryRoot = '/home/a/books'
  A.settings.readingMode.typewriter.cpm = 500
  A.settings.dianjing.perBook = { 'local-id': true }
  A.settings.dianjing.level = 'smart'
  B.settings.libraryRoot = '/sdcard/books'

  await sync(A, dav.remote())
  const docA = dav.readJson('devices/dev-A.json')
  assert.equal(docA.settings['reader.theme'].value, 'dark')
  assert.equal('webdavPass' in docA.settings, false, '默认不同步密钥')
  assert.equal('libraryRoot' in docA.settings, false)

  const r = await sync(B, dav.remote())
  assert.equal(B.settings.reader.theme, 'dark')
  assert.equal(B.settings.reader.fontSize, 22)
  assert.equal(B.settings.webdavUrl, 'https://dav.jianguoyun.com/dav/')
  assert.equal(B.settings.webdavUser, 'me@x.com')
  assert.equal(B.settings.webdavProvider, 'jianguoyun')
  assert.equal(B.settings.readingMode.typewriter.cpm, 500)
  assert.equal(B.settings.webdavPass, '')
  assert.equal(B.settings.libraryRoot, '/sdcard/books')
  assert.deepEqual(B.settings.dianjing.perBook, {})
  assert.equal(B.settings.dianjing.level, 'smart', '点睛阅读选的版本随同步')
  assert.equal(r.settingsApplied, 8)
  assert.equal(B.settings.layoutOverrides.reader.fontSize, true, '字号的手动优先级一起同步')

  // 不打架: 双方再同步, 没有新的落地, 文档里的寄存器与来源一致
  assert.equal((await sync(B, dav.remote())).settingsApplied, 0)
  assert.equal((await sync(A, dav.remote())).settingsApplied, 0)
  assert.deepEqual(dav.readJson('devices/dev-B.json').settings['reader.theme'], docA.settings['reader.theme'])

  // 设备相关项从别处改了也不落地
  B.settings.httpProxy = 'socks5://127.0.0.1:1080'
  await sync(B, dav.remote())
  await sync(A, dav.remote())
  assert.equal(A.settings.httpProxy, '')
})

test('按修改时间 LWW: 改得晚的赢, 与谁先同步无关; 不同的键互不影响', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  tick()
  edit(A, s => { // A 先改
    s.reader.fontSize = 20
    s.appearance = 'dark'
  })
  tick()
  edit(B, s => { // B 后改
    s.reader.fontSize = 26
    s.reader.lineHeight = 2.4
  })
  // B 先同步, A 后同步: A 的较早修改不会因为同步得晚而胜出
  await sync(B, dav.remote())
  await sync(A, dav.remote())
  await sync(B, dav.remote())
  for (const d of [A, B]) {
    assert.equal(d.settings.reader.fontSize, 26, d.name)
    assert.equal(d.settings.reader.lineHeight, 2.4, d.name)
    assert.equal(d.settings.appearance, 'dark', d.name)
  }
})

test('密钥: 仅发送方开启 syncSecrets 时同步; 关闭的设备不删远端的密钥, 自己没发出去的新密钥也不被旧值盖掉', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  tick()
  A.settings.aiApiKey = 'sk-A1'
  await sync(A, dav.remote())
  await sync(B, dav.remote())
  assert.equal(B.settings.aiApiKey, '', '发送方没开启: 不同步密钥')

  A.syncSecrets = true
  await sync(A, dav.remote())
  assert.equal(dav.readJson('devices/dev-A.json').settings.aiApiKey.value, 'sk-A1')
  await sync(B, dav.remote())
  assert.equal(B.settings.aiApiKey, 'sk-A1', '接收方没开启也照样落地远端有的密钥')
  // B 没开启, 写自己的文档时转写 A 的密钥 (缺席 = 不变, 不删除)
  assert.equal(dav.readJson('devices/dev-B.json').settings.aiApiKey.value, 'sk-A1')

  // B 改了自己的密钥 (不发出去): 不被 A 的旧密钥盖回, 也不传给 A
  tick()
  B.settings.aiApiKey = 'sk-B-private'
  await sync(B, dav.remote())
  await sync(A, dav.remote())
  await sync(B, dav.remote())
  assert.equal(B.settings.aiApiKey, 'sk-B-private')
  assert.equal(A.settings.aiApiKey, 'sk-A1')
  assert.equal(dav.readJson('devices/dev-B.json').settings.aiApiKey.value, 'sk-A1')

  // A 关掉 syncSecrets 后: 远端已有的旧密钥保留 (不删), 之后的新密钥不再发出
  A.syncSecrets = false
  tick()
  A.settings.aiApiKey = 'sk-A2'
  await sync(A, dav.remote())
  assert.equal(dav.readJson('devices/dev-A.json').settings.aiApiKey.value, 'sk-A1')
  assert.equal(A.settings.aiApiKey, 'sk-A2')
})

test('关闭「同步设置」的设备: 不发出也不落地设置, 但照样转写别的设备的设置; 重新打开后按修改时间收敛', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B', { syncSettings: false })
  tick()
  A.settings.reader.theme = 'sepia'
  B.settings.reader.fontSize = 30
  await sync(A, dav.remote())
  await sync(B, dav.remote())
  assert.equal(B.settings.reader.theme, 'auto', '关闭时不落地')
  const docB = dav.readJson('devices/dev-B.json')
  assert.equal(docB.settings['reader.theme'].value, 'sepia', '转写别的设备的设置')
  assert.equal('reader.fontSize' in docB.settings, false, '不发出本机设置')
  await sync(A, dav.remote())
  assert.equal(A.settings.reader.fontSize, 18)

  // 重新打开: B 的字号 (改得比 A 的主题晚) 发出去, A 的主题落地到 B
  B.syncSettings = true
  await sync(B, dav.remote())
  await sync(A, dav.remote())
  assert.equal(B.settings.reader.theme, 'sepia')
  assert.equal(A.settings.reader.fontSize, 30)
})

test('预设临时值不外传: A 开着大字 (24) 时 B 收到的是开启前的字号', async () => {
  const dav = createFakeDav()
  const A = await device('A')
  const B = await device('B')
  tick()
  A.settings.reader.fontSize = 19
  await sync(A, dav.remote())
  tick()
  // A 开启大字预设
  A.settings.readingMode.presets = { largeText: { before: { 'reader.fontSize': 19 }, applied: { 'reader.fontSize': 24 }, order: 1 } }
  A.settings.reader.fontSize = 24
  await sync(A, dav.remote())
  await sync(B, dav.remote())
  assert.equal(B.settings.reader.fontSize, 19)
  // B 改字号 → A 收到时写进预设快照, 大字照常显示; 关闭预设后恢复到 B 的值
  tick()
  B.settings.reader.fontSize = 17
  await sync(B, dav.remote())
  await sync(A, dav.remote())
  assert.equal(A.settings.reader.fontSize, 24)
  assert.equal(A.settings.readingMode.presets.largeText.before['reader.fontSize'], 17)
})

test('新设备登录账号: 先从账号拉到设置 (含 WebDAV 配置), 随后同一轮就能连上 WebDAV', async () => {
  const srv = createFakeAccountServer()
  const dav = createFakeDav()
  const A = await device('A', { syncSecrets: true })
  tick()
  A.settings.webdavUrl = dav.base + '/'
  A.settings.webdavUser = 'u'
  A.settings.webdavPass = 'p'
  A.settings.webdavProvider = 'selfhosted'
  A.settings.reader.theme = 'green'
  const sessA = srv.login('me@x.com', 'A')
  await sync(A, srv.remote(sessA))
  await sync(A, dav.remote())

  // 同 sync/index.ts 的 syncNow: 先账号, 账号同步之后再判断 WebDAV 是否可用
  const C = await device('C')
  const webdavReady = d => !!d.settings.webdavUrl.trim() && (!d.settings.webdavUser.trim() || !!d.settings.webdavPass)
  assert.equal(webdavReady(C), false)
  const sessC = srv.login('me@x.com', 'C')
  await sync(C, srv.remote(sessC))
  assert.equal(C.settings.reader.theme, 'green')
  assert.equal(C.settings.webdavUrl, dav.base + '/')
  assert.equal(C.settings.webdavPass, 'p')
  assert.equal(webdavReady(C), true)
  await sync(C, dav.remote())
  assert.ok(dav.readJson('devices/dev-C.json'), 'C 已写入 WebDAV')

  // C 在本机断开 WebDAV: 只影响 C, 不会把 A 的 WebDAV 一起断掉
  tick()
  edit(C, st => {
    st.webdavUrl = ''
    st.webdavUser = ''
    st.webdavPass = ''
    st.webdavProvider = ''
  })
  await sync(C, srv.remote(sessC))
  await sync(A, srv.remote(sessA))
  assert.equal(A.settings.webdavUrl, dav.base + '/')
  assert.equal(A.settings.webdavPass, 'p')
  await sync(C, srv.remote(sessC))
  assert.equal(C.settings.webdavUrl, '', '断开后不会被旧配置连回去')
  // 之后 A 换了新的 WebDAV 配置: 会过来
  tick()
  edit(A, st => { st.webdavUrl = 'https://dav2.example.com/' })
  await sync(A, srv.remote(sessA))
  await sync(C, srv.remote(sessC))
  assert.equal(C.settings.webdavUrl, 'https://dav2.example.com/')
  assert.equal(C.settings.webdavUser, 'u', '账号 / 密码跟着新地址一起落地')
  assert.equal(C.settings.webdavPass, 'p')

  // 发送方没开 syncSecrets 时: 地址与账号来了但没有密码, WebDAV 视为未就绪 (不去连、不报认证失败)
  const srv2 = createFakeAccountServer('https://sync2.test')
  const D = await device('D')
  const E = await device('E')
  tick()
  D.settings.webdavUrl = 'https://dav.example.com/'
  D.settings.webdavUser = 'u'
  D.settings.webdavPass = 'p'
  await sync(D, srv2.remote(srv2.login('d@x.com', 'D')))
  await sync(E, srv2.remote(srv2.login('d@x.com', 'E')))
  assert.equal(E.settings.webdavUrl, 'https://dav.example.com/')
  assert.equal(E.settings.webdavPass, '')
  assert.equal(webdavReady(E), false)
})

test('响应式 (Proxy) 的对象 / 数组设置也能写进同步文档, 不抛 DataCloneError', async () => {
  const { buildSettingsRegs, cloneValue } = await import('../src/services/sync/settingsSync.ts')
  const proxied = new Proxy([{ id: 'rain', volume: 0.4 }], {})
  assert.throws(() => structuredClone(proxied), /could not be cloned|DataCloneError/)
  assert.deepEqual(cloneValue(proxied), [{ id: 'rain', volume: 0.4 }])
  const path = 'ambient.layers'
  const regs = buildSettingsRegs({ values: { [path]: proxied }, stamps: { [path]: { t: 5, d: 'dev' } } }, 'dev', false)
  assert.deepEqual(regs[path]?.value, [{ id: 'rain', volume: 0.4 }])
})


test('歌词高度迁移保留坐标含义，自定义行数和位置参与同步', () => {
  const previous = globalThis.localStorage
  try {
    for (const [version, anchor, expected] of [[15, 0.4, 0.382], [15, 0.5, 0.5], [16, 0.4, 0.4], [16, 0, 0], [16, 1, 1]]) {
      globalThis.localStorage = { getItem: () => JSON.stringify({ version, readingMode: { lyric: { anchor, lines: 7 } } }) }
      const store = useSettings(createPinia())
      assert.equal(store.readingMode.lyric.anchor, expected)
      assert.equal(store.readingMode.lyric.lines, 7)
      assert.equal(store.version, settingsDefaults().version)
    }
    const state = settingsDefaults()
    assert.equal(state.readingMode.lyric.anchor, 0.382)
    assert.ok(writeSyncedSetting(state, 'readingMode.lyric.anchor', 0.127))
    assert.ok(writeSyncedSetting(state, 'readingMode.lyric.lines', 8))
    assert.equal(readSyncedSettings(state)['readingMode.lyric.anchor'], 0.127)
    assert.equal(readSyncedSettings(state)['readingMode.lyric.lines'], 8)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
})
