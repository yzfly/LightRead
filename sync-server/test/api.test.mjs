// 轻阅账号 / 同步后端接口契约 (node --test). 经 wrangler 的本地运行时 (workerd + 本地 D1/R2) 驱动 Worker.
// 运行: cd sync-server && node --test test/   (wrangler 取仓库根目录的 node_modules)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHmac, randomUUID } from 'node:crypto'
import { createTestHarness } from 'wrangler'
import { addDays, beijingDay } from '../src/stats.ts'

const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef'
const root = fileURLToPath(new URL('..', import.meta.url))
const server = createTestHarness({
  root,
  // DEV_EXPOSE_CODE 只在测试里打开: /v1/auth/code 直接返回验证码
  workers: [{ configPath: './wrangler.jsonc', vars: { DEV_EXPOSE_CODE: '1', ADMIN_TOKEN } }],
})

const BASE = 'http://sync.test'
let ipSeq = 0

/** 每次发码 / 心跳 / 取件码请求用不同 IP, 避免撞上单 IP 每日上限 (需要固定 IP 时显式传 cf-connecting-ip) */
function call(method, path, { body, token, raw, headers = {} } = {}) {
  const h = { ...headers }
  if (token) h.authorization = `Bearer ${token}`
  if (body !== undefined && !raw) h['content-type'] = 'application/json'
  // 测试运行时转发请求时会丢掉 undici 自动加的 content-length (改成 chunked), 原始请求体显式带上, 同浏览器上传
  if (raw && h['content-length'] === undefined && (typeof body === 'string' || body instanceof Uint8Array)) {
    h['content-length'] = String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength)
  }
  if ((path === '/v1/auth/code' || path === '/v1/ping' || path === '/v1/feedback' || path.startsWith('/v1/drops')) && !h['cf-connecting-ip']) {
    ++ipSeq
    h['cf-connecting-ip'] = `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`
  }
  return server.fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
}

async function jsonOf(res) {
  return JSON.parse(await res.text())
}

async function requestCode(email) {
  const res = await call('POST', '/v1/auth/code', { body: { email } })
  assert.equal(res.status, 200)
  const { devCode } = await jsonOf(res)
  assert.match(devCode, /^\d{6}$/)
  return devCode
}

async function login(email, deviceName = 'test') {
  const code = await requestCode(email)
  const res = await call('POST', '/v1/auth/verify', { body: { email, code, deviceName } })
  assert.equal(res.status, 200)
  return jsonOf(res)
}

function makeDoc(deviceId, extra = {}) {
  return {
    format: 1,
    deviceId,
    deviceName: deviceId,
    writtenAt: Date.now(),
    books: {},
    annotations: {},
    booklists: {},
    booklistItems: {},
    sources: {},
    ...extra,
  }
}

before(async () => {
  await server.listen()
  const env = await server.getWorker().getEnv()
  // 按 schema.sql 建表 (与生产 wrangler d1 execute 同一份)
  const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
  const statements = sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
  await env.DB.batch(statements.map(s => env.DB.prepare(s)))
})

after(async () => {
  await server.close()
})

test('health', async () => {
  const res = await call('GET', '/health')
  assert.equal(res.status, 200)
  assert.deepEqual(await jsonOf(res), { ok: true })
})

test('CORS 预检与错误响应都带 CORS 头', async () => {
  const pre = await call('OPTIONS', '/v1/docs/abc', {
    headers: { origin: 'https://app.example', 'access-control-request-method': 'PUT' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/)
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/)
  for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.match(pre.headers.get('access-control-allow-methods'), new RegExp(m))
  }
  const nf = await call('GET', '/nope')
  assert.equal(nf.status, 404)
  assert.equal(nf.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await jsonOf(nf), { error: 'not_found' })
  const unauth = await call('GET', '/v1/me')
  assert.equal(unauth.status, 401)
  assert.equal(unauth.headers.get('access-control-allow-origin'), '*')
  assert.deepEqual(await jsonOf(unauth), { error: 'unauthorized' })
})

test('WebDAV 中转: 预检放行 WebDAV 方法; 只认白名单服务商; 无 Basic 鉴权 / 越级路径不转发', async () => {
  const pre = await call('OPTIONS', '/v1/webdav/jianguoyun/LightRead/', {
    headers: { origin: 'https://app.example', 'access-control-request-method': 'PROPFIND' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.match(pre.headers.get('access-control-allow-headers'), /depth/)
  for (const m of ['PROPFIND', 'MKCOL', 'PUT', 'HEAD']) {
    assert.match(pre.headers.get('access-control-allow-methods'), new RegExp(m))
  }
  const unknown = await call('PROPFIND', '/v1/webdav/evil/x', { headers: { authorization: 'Basic eDp5' } })
  assert.equal(unknown.status, 404)
  const noAuth = await call('PROPFIND', '/v1/webdav/koofr/')
  assert.equal(noAuth.status, 401)
  assert.equal(noAuth.headers.get('www-authenticate'), null)
  assert.equal(noAuth.headers.get('access-control-allow-origin'), '*')
  const bearer = await call('GET', '/v1/webdav/koofr/a', { headers: { authorization: 'Bearer x' } })
  assert.equal(bearer.status, 401)
  const traversal = await call('GET', '/v1/webdav/jianguoyun/a/..%2Fb', { headers: { authorization: 'Basic eDp5' } })
  assert.equal(traversal.status, 400)
  const post = await call('POST', '/v1/webdav/jianguoyun/a', { headers: { authorization: 'Basic eDp5' } })
  assert.equal(post.status, 405)
})

test('非法邮箱 → 400 invalid_email', async () => {
  for (const email of ['', 'not-an-email', 'a@b', 'x y@z.com', 123]) {
    const res = await call('POST', '/v1/auth/code', { body: { email } })
    assert.equal(res.status, 400, String(email))
    assert.deepEqual(await jsonOf(res), { error: 'invalid_email' })
  }
  const bad = await call('POST', '/v1/auth/code', { body: '{oops', raw: true })
  assert.equal(bad.status, 400)
})

test('验证码 → 验证 → token; 邮箱 trim + 小写; 同一邮箱再登录是同一账号', async () => {
  const first = await login('  Alice@Example.COM ')
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(first.account.email, 'alice@example.com')
  assert.ok(first.account.id)
  assert.equal(typeof first.account.createdAt, 'number')

  const me = await call('GET', '/v1/me', { token: first.token })
  assert.equal(me.status, 200)
  assert.deepEqual(await jsonOf(me), { account: first.account })

  // 验证码一次性
  const code = await requestCode('reuse@example.com')
  const ok = await call('POST', '/v1/auth/verify', { body: { email: 'reuse@example.com', code } })
  assert.equal(ok.status, 200)
  const again = await call('POST', '/v1/auth/verify', { body: { email: 'reuse@example.com', code } })
  assert.equal(again.status, 400)
  assert.deepEqual(await jsonOf(again), { error: 'invalid_code' })

  // 同一个邮箱再登录: 同一账号, 另一个 token
  const second = await login('alice@example.com')
  assert.equal(second.account.id, first.account.id)
  assert.notEqual(second.token, first.token)
})

test('60 秒内重发 → 429 rate_limited + retryAfter', async () => {
  await requestCode('resend@example.com')
  const res = await call('POST', '/v1/auth/code', { body: { email: 'RESEND@example.com' } })
  assert.equal(res.status, 429)
  const body = await jsonOf(res)
  assert.equal(body.error, 'rate_limited')
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 60, String(body.retryAfter))
  assert.equal(res.headers.get('retry-after'), String(body.retryAfter))
})

test('错误验证码: 前 4 次 invalid_code, 第 5 次起 too_many_attempts, 正确码也作废', async () => {
  const email = 'brute@example.com'
  const code = await requestCode(email)
  const wrong = code === '000000' ? '111111' : '000000'
  for (let i = 1; i <= 4; i++) {
    const res = await call('POST', '/v1/auth/verify', { body: { email, code: wrong } })
    assert.equal(res.status, 400, `attempt ${i}`)
    assert.deepEqual(await jsonOf(res), { error: 'invalid_code' })
  }
  const fifth = await call('POST', '/v1/auth/verify', { body: { email, code: wrong } })
  assert.equal(fifth.status, 429)
  assert.deepEqual(await jsonOf(fifth), { error: 'too_many_attempts' })
  const right = await call('POST', '/v1/auth/verify', { body: { email, code } })
  assert.equal(right.status, 429)
  assert.deepEqual(await jsonOf(right), { error: 'too_many_attempts' })

  // 没发过码 / 格式不对
  const none = await call('POST', '/v1/auth/verify', { body: { email: 'never@example.com', code: '123456' } })
  assert.equal(none.status, 400)
  const malformed = await call('POST', '/v1/auth/verify', { body: { email, code: '12ab' } })
  assert.equal(malformed.status, 400)
})

test('PUT/GET 文档: 两台设备往返; deviceId 不符 / 格式错 → 400; 超 8MB → 413', async () => {
  const { token } = await login('docs@example.com')
  const empty = await call('GET', '/v1/docs', { token })
  assert.equal(empty.status, 200)
  assert.deepEqual(await jsonOf(empty), { docs: [] })

  const a = makeDoc('dev-A', {
    books: { h1: { meta: { value: { title: '书' }, stamp: { t: 1, d: 'dev-A' } }, reading: { 'dev-A': 5 } } },
  })
  const b = makeDoc('dev_B')
  for (const doc of [a, b]) {
    const res = await call('PUT', `/v1/docs/${doc.deviceId}`, { token, body: doc })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
  }
  // 覆盖写
  const a2 = { ...a, writtenAt: a.writtenAt + 1 }
  assert.equal((await call('PUT', '/v1/docs/dev-A', { token, body: a2 })).status, 204)

  const got = await jsonOf(await call('GET', '/v1/docs', { token }))
  const byId = Object.fromEntries(got.docs.map(d => [d.deviceId, d]))
  assert.equal(got.docs.length, 2)
  assert.deepEqual(byId['dev-A'], a2)
  assert.deepEqual(byId['dev_B'], b)

  // 另一个账号看不到
  const other = await login('other@example.com')
  assert.deepEqual(await jsonOf(await call('GET', '/v1/docs', { token: other.token })), { docs: [] })

  const expect400 = async (path, body, raw) => {
    const res = await call('PUT', path, { token, body, raw })
    assert.equal(res.status, 400, path)
    assert.deepEqual(await jsonOf(res), { error: 'invalid_doc' })
  }
  await expect400('/v1/docs/dev-A', makeDoc('dev-B'))
  await expect400('/v1/docs/dev-A', { ...makeDoc('dev-A'), format: 2 })
  await expect400('/v1/docs/dev-A', { ...makeDoc('dev-A'), books: [] })
  await expect400('/v1/docs/dev-A', { ...makeDoc('dev-A'), sources: undefined })
  await expect400('/v1/docs/dev-A', '{not json', true)
  await expect400('/v1/docs/bad.id', makeDoc('bad.id'))
  await expect400(`/v1/docs/${'x'.repeat(65)}`, makeDoc('x'.repeat(65)))

  const big = JSON.stringify(makeDoc('dev-A', { pad: 'x'.repeat(8 * 1024 * 1024) }))
  const tooLarge = await call('PUT', '/v1/docs/dev-A', { token, body: big, raw: true })
  assert.equal(tooLarge.status, 413)
  assert.deepEqual(await jsonOf(tooLarge), { error: 'too_large' })
  // 超限的写入不落盘
  const stored = await jsonOf(await call('GET', '/v1/docs', { token }))
  assert.equal(stored.docs.find(d => d.deviceId === 'dev-A').pad, undefined)

  // 未登录
  assert.equal((await call('PUT', '/v1/docs/dev-A', { body: a })).status, 401)
  assert.equal((await call('GET', '/v1/docs')).status, 401)
})

test('登出吊销当前 token, 其它会话不受影响', async () => {
  const s1 = await login('logout@example.com')
  const s2 = await login('logout@example.com')
  const res = await call('POST', '/v1/auth/logout', { token: s1.token })
  assert.equal(res.status, 204)
  assert.equal((await call('GET', '/v1/me', { token: s1.token })).status, 401)
  assert.equal((await call('POST', '/v1/auth/logout', { token: s1.token })).status, 401)
  assert.equal((await call('GET', '/v1/me', { token: s2.token })).status, 200)
})

test('DELETE /v1/me: 删除文档、会话、账号; 再登录是全新账号', async () => {
  const email = 'bye@example.com'
  const s1 = await login(email)
  const s2 = await login(email)
  for (const id of ['d1', 'd2']) {
    assert.equal((await call('PUT', `/v1/docs/${id}`, { token: s1.token, body: makeDoc(id) })).status, 204)
  }
  const del = await call('DELETE', '/v1/me', { token: s1.token })
  assert.equal(del.status, 204)
  assert.equal((await call('GET', '/v1/me', { token: s1.token })).status, 401)
  assert.equal((await call('GET', '/v1/docs', { token: s2.token })).status, 401)

  // R2 里确实没有了
  const env = await server.getWorker().getEnv()
  const left = await env.DOCS.list({ prefix: `u/${s1.account.id}/` })
  assert.equal(left.objects.length, 0)

  const fresh = await login(email)
  assert.notEqual(fresh.account.id, s1.account.id)
  assert.deepEqual(await jsonOf(await call('GET', '/v1/docs', { token: fresh.token })), { docs: [] })
})

test('发码限流: 同一邮箱每天 10 次, 同一 IP 每天 30 次', async () => {
  const env = await server.getWorker().getEnv()
  const day = new Date().toISOString().slice(0, 10)
  // 直接把计数推到上限, 不用真等 60 秒窗口
  await env.DB.prepare("INSERT INTO counters(key, day, count) VALUES(?1, ?2, 10)")
    .bind('code:email:limit@example.com', day)
    .run()
  const byEmail = await call('POST', '/v1/auth/code', { body: { email: 'limit@example.com' } })
  assert.equal(byEmail.status, 429)
  const body = await jsonOf(byEmail)
  assert.equal(body.error, 'rate_limited')
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400)

  await env.DB.prepare("INSERT INTO counters(key, day, count) VALUES(?1, ?2, 30)")
    .bind('code:ip:192.0.2.1', day)
    .run()
  const byIp = await call('POST', '/v1/auth/code', {
    body: { email: 'fresh-ip@example.com' },
    headers: { 'cf-connecting-ip': '192.0.2.1' },
  })
  assert.equal(byIp.status, 429)
  assert.equal((await jsonOf(byIp)).error, 'rate_limited')
})

test('同步限流: 每账号每天 PUT 2000 次', async () => {
  const { token, account } = await login('puts@example.com')
  const env = await server.getWorker().getEnv()
  const day = new Date().toISOString().slice(0, 10)
  await env.DB.prepare("INSERT INTO counters(key, day, count) VALUES(?1, ?2, 2000)")
    .bind(`put:${account.id}`, day)
    .run()
  const res = await call('PUT', '/v1/docs/dev', { token, body: makeDoc('dev') })
  assert.equal(res.status, 429)
  assert.equal((await jsonOf(res)).error, 'rate_limited')
})

test('定时清理: 删过期验证码与两天前的计数', async () => {
  const env = await server.getWorker().getEnv()
  await env.DB.batch([
    env.DB.prepare("INSERT INTO codes(email, code_hash, expires_at, attempts, sent_at) VALUES('old@example.com', 'x', 1, 0, 1)"),
    env.DB.prepare("INSERT INTO counters(key, day, count) VALUES('code:ip:old', '2000-01-01', 1)"),
  ])
  const res = await server.getWorker().scheduled({ cron: '17 3 * * *', scheduledTime: new Date() })
  assert.equal(res.outcome, 'ok')
  assert.equal(await env.DB.prepare("SELECT 1 FROM codes WHERE email = 'old@example.com'").first(), null)
  assert.equal(await env.DB.prepare("SELECT 1 FROM counters WHERE day = '2000-01-01'").first(), null)
  // 今天的计数保留
  const kept = await env.DB.prepare('SELECT COUNT(*) AS n FROM counters WHERE day = ?1')
    .bind(new Date().toISOString().slice(0, 10))
    .first()
  assert.ok(kept.n > 0)
})

// 本地 .dev.vars 会被 wrangler 读入 (会打开 DEV_EXPOSE_CODE), 此时这条断言不代表生产配置, 跳过
const hasDevVars = existsSync(new URL('../.dev.vars', import.meta.url))

test('默认配置 (未开 DEV_EXPOSE_CODE, 无 RESEND_API_KEY): 不泄露验证码, 502 email_failed, 可立即重试', { skip: hasDevVars && '存在 .dev.vars' }, async () => {
  const prod = createTestHarness({ root, workers: [{ configPath: './wrangler.jsonc' }] })
  try {
    await prod.listen()
    const env = await prod.getWorker().getEnv()
    assert.equal(env.DEV_EXPOSE_CODE, undefined)
    const sql = await readFile(new URL('../schema.sql', import.meta.url), 'utf8')
    await env.DB.batch(sql.replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean).map(s => env.DB.prepare(s)))
    for (let i = 0; i < 2; i++) {
      const res = await prod.fetch(BASE + '/v1/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'prod@example.com' }),
      })
      assert.equal(res.status, 502)
      assert.deepEqual(await jsonOf(res), { error: 'email_failed' })
    }
  } finally {
    await prod.close()
  }
})

// ---- 匿名使用统计 ----

const pingBody = (over = {}) => ({
  id: randomUUID(),
  platform: 'windows',
  version: '1.8.0',
  lang: 'zh',
  reader: false,
  ...over,
})

const admin = (path, token = ADMIN_TOKEN) =>
  call('GET', path, { headers: token === null ? {} : { authorization: `Bearer ${token}` } })

test('北京日切分: UTC 16:00 起算第二天', () => {
  assert.equal(beijingDay(Date.UTC(2026, 9, 4, 15, 59, 59)), '2026-10-04')
  assert.equal(beijingDay(Date.UTC(2026, 9, 4, 16, 0, 0)), '2026-10-05')
  assert.equal(beijingDay(Date.UTC(2026, 11, 31, 16, 30)), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})

test('心跳: 合法 → 204 带 CORS; 预检放行; 严格校验, 多余字段忽略', async () => {
  const pre = await call('OPTIONS', '/v1/ping', {
    headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers.get('access-control-allow-origin'), '*')
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/)
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/)

  const ok = await call('POST', '/v1/ping', { body: pingBody({ extra: 'x', email: 'a@b.c' }) })
  assert.equal(ok.status, 204)
  assert.equal(ok.headers.get('access-control-allow-origin'), '*')

  const bad = [
    {},
    pingBody({ id: undefined }),
    pingBody({ id: 'not-a-uuid' }),
    pingBody({ id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }), // v1
    pingBody({ id: 123 }),
    pingBody({ platform: 'beos' }),
    pingBody({ platform: 'Windows' }),
    pingBody({ version: '1.2' }),
    pingBody({ version: '1.2.3-beta' }),
    pingBody({ version: 'v1.2.3' }),
    pingBody({ version: '01.2.3' }),
    pingBody({ version: 1 }),
    pingBody({ lang: 'fr' }),
    pingBody({ lang: undefined }),
    pingBody({ reader: 'true' }),
    pingBody({ reader: 1 }),
    pingBody({ reader: undefined }),
    [pingBody()],
    null,
    'ping',
  ]
  for (const body of bad) {
    const res = await call('POST', '/v1/ping', { body })
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.deepEqual(await jsonOf(res), { error: 'invalid_ping' })
  }
  const notJson = await call('POST', '/v1/ping', { body: '{oops', raw: true })
  assert.equal(notJson.status, 400)
  const tooBig = await call('POST', '/v1/ping', { body: pingBody({ pad: 'x'.repeat(2000) }) })
  assert.equal(tooBig.status, 400)
  assert.equal((await call('GET', '/v1/ping')).status, 404)

  // 表里只有约定的列, 没有 IP / UA
  const env = await server.getWorker().getEnv()
  const cols = async table =>
    (await env.DB.prepare(`PRAGMA table_info(${table})`).all()).results.map(r => r.name).sort()
  assert.deepEqual(await cols('pings'), ['day', 'install_id', 'lang', 'platform', 'reader', 'version'])
  assert.deepEqual(await cols('installs'), ['first_day', 'install_id', 'last_day', 'platform', 'version'])
})

test('心跳: 同一安装同一天一行; reader 取或; 平台 / 版本取最新; 按北京日入库', async () => {
  const env = await server.getWorker().getEnv()
  const id = randomUUID()
  const before = beijingDay()
  for (const [over, status] of [
    [{ reader: false, version: '1.7.0', platform: 'android' }, 204],
    [{ reader: true, version: '1.7.0', platform: 'android' }, 204],
    [{ reader: false, version: '1.8.0', platform: 'android', lang: 'en' }, 204],
  ]) {
    // 大写 UUID 也接受, 统一存小写
    const res = await call('POST', '/v1/ping', { body: pingBody({ id: id.toUpperCase(), ...over }) })
    assert.equal(res.status, status)
  }
  const after = beijingDay()
  const rows = (await env.DB.prepare('SELECT * FROM pings WHERE install_id = ?1').bind(id).all()).results
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.ok([before, after].includes(row.day), `day ${row.day}`)
  assert.equal(row.reader, 1)
  assert.equal(row.version, '1.8.0')
  assert.equal(row.lang, 'en')
  const inst = await env.DB.prepare('SELECT * FROM installs WHERE install_id = ?1').bind(id).first()
  assert.equal(inst.first_day, row.day)
  assert.equal(inst.last_day, row.day)
  assert.equal(inst.version, '1.8.0')
  assert.equal(inst.platform, 'android')
})

test('心跳限流: 每个 IP 每天 120 次; 限流键不含原始 IP', async () => {
  const env = await server.getWorker().getEnv()
  const ip = '203.0.113.77'
  const keysBefore = new Set(
    (await env.DB.prepare("SELECT key FROM counters WHERE key LIKE 'ping:%'").all()).results.map(r => r.key),
  )
  assert.equal((await call('POST', '/v1/ping', { body: pingBody(), headers: { 'cf-connecting-ip': ip } })).status, 204)
  const fresh = (await env.DB.prepare("SELECT key, day, count FROM counters WHERE key LIKE 'ping:%'").all()).results.filter(
    r => !keysBefore.has(r.key),
  )
  assert.equal(fresh.length, 1)
  assert.match(fresh[0].key, /^ping:[0-9a-f]{32}$/)
  assert.equal(fresh[0].count, 1)
  const all = (await env.DB.prepare('SELECT key FROM counters').all()).results
  assert.ok(!all.some(r => r.key.includes(ip)))

  await env.DB.prepare('UPDATE counters SET count = 120 WHERE key = ?1 AND day = ?2').bind(fresh[0].key, fresh[0].day).run()
  const limited = await call('POST', '/v1/ping', { body: pingBody(), headers: { 'cf-connecting-ip': ip } })
  assert.equal(limited.status, 429)
  const body = await jsonOf(limited)
  assert.equal(body.error, 'rate_limited')
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400)
  // 非法请求不计数, 其它 IP 不受影响
  assert.equal((await call('POST', '/v1/ping', { body: pingBody(), headers: { 'cf-connecting-ip': '203.0.113.78' } })).status, 204)
})

test('统计接口鉴权: 无令牌 / 错令牌 → 401; days 越界 → 400; /admin 返回统计页', async () => {
  for (const token of [null, 'wrong-token', ADMIN_TOKEN + 'x', '']) {
    const res = await admin('/v1/admin/stats', token)
    assert.equal(res.status, 401, String(token))
    assert.deepEqual(await jsonOf(res), { error: 'unauthorized' })
  }
  const basic = await call('GET', '/v1/admin/stats', { headers: { authorization: `Basic ${ADMIN_TOKEN}` } })
  assert.equal(basic.status, 401)
  const ok = await admin('/v1/admin/stats')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('cache-control'), 'no-store')
  for (const d of ['0', '366', 'abc', '-1', '7.5']) {
    assert.equal((await admin(`/v1/admin/stats?days=${d}`)).status, 400, d)
  }
  const page = await call('GET', '/admin')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/)
  const html = await page.text()
  assert.match(html, /轻阅使用统计/)
  assert.match(html, /数据只含随机安装 ID、平台、版本、语言/)
  assert.doesNotMatch(html, /<script[^>]+src=/)
})

/** 清空统计表并写入一组相对今天 (北京日) 的固定数据 */
async function seedStats(env, T) {
  await env.DB.batch(['pings', 'installs', 'ping_daily'].map(t => env.DB.prepare(`DELETE FROM ${t}`)))
  const A = randomUUID(), B = randomUUID(), C = randomUUID(), D = randomUUID()
  const ins = (id, first, last, platform, version) =>
    env.DB.prepare('INSERT INTO installs VALUES(?1, ?2, ?3, ?4, ?5)').bind(id, first, last, platform, version)
  const p = (day, id, platform, version, reader = 0, lang = 'zh') =>
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(day, id, platform, version, lang, reader)
  await env.DB.batch([
    ins(A, addDays(T, -8), addDays(T, -1), 'windows', '1.7.0'),
    ins(B, addDays(T, -8), addDays(T, -8), 'android', '1.6.0'),
    ins(C, addDays(T, -1), addDays(T, -1), 'android', '1.7.0'),
    ins(D, addDays(T, -100), addDays(T, -40), 'linux', '1.0.0'),
    p(addDays(T, -8), A, 'windows', '1.7.0'),
    p(addDays(T, -7), A, 'windows', '1.7.0', 1),
    p(addDays(T, -1), A, 'windows', '1.7.0', 0, 'en'),
    p(addDays(T, -8), B, 'android', '1.6.0'),
    p(addDays(T, -1), C, 'android', '1.7.0'),
    p(addDays(T, -40), D, 'linux', '1.0.0'),
  ])
  return { A, B, C, D }
}

test('统计: 装机 / 日活 / 周活 / 月活 / 黏性 / 每日序列 / 分布 / 留存', async () => {
  const env = await server.getWorker().getEnv()
  const T = beijingDay()
  const { C } = await seedStats(env, T)
  // 今天: C 再次出现 (打开了阅读器, 升级到 1.8.0), E 首次出现
  assert.equal((await call('POST', '/v1/ping', { body: pingBody({ id: C, platform: 'android', version: '1.8.0', reader: true }) })).status, 204)
  assert.equal((await call('POST', '/v1/ping', { body: pingBody({ platform: 'web', version: '1.8.0' }) })).status, 204)

  const s = await jsonOf(await admin('/v1/admin/stats'))
  assert.equal(s.today, T)
  assert.equal(s.timezone, 'Asia/Shanghai')
  assert.equal(s.days, 30)
  assert.match(s.note, /安装/)
  assert.deepEqual(s.totals, { installs: 5, newToday: 1, new7d: 2, new30d: 4 })
  assert.deepEqual(s.active, { dau: 2, dauYesterday: 2, wau: 3, mau: 4, avgDau30: 0.6, stickiness: 0.1563 })

  assert.equal(s.daily.length, 30)
  assert.equal(s.daily[0].day, addDays(T, -29))
  assert.equal(s.daily.at(-1).day, T)
  const at = k => s.daily.find(d => d.day === addDays(T, k))
  assert.deepEqual(at(-8), { day: addDays(T, -8), actives: 2, readers: 0, newInstalls: 2 })
  assert.deepEqual(at(-7), { day: addDays(T, -7), actives: 1, readers: 1, newInstalls: 0 })
  assert.deepEqual(at(-1), { day: addDays(T, -1), actives: 2, readers: 0, newInstalls: 1 })
  assert.deepEqual(at(0), { day: T, actives: 2, readers: 1, newInstalls: 1 })
  assert.deepEqual(at(-2), { day: addDays(T, -2), actives: 0, readers: 0, newInstalls: 0 })

  assert.equal(s.platforms[0].name, 'android')
  assert.deepEqual(Object.fromEntries(s.platforms.map(p => [p.name, p.installs])), { android: 2, web: 1, windows: 1 })
  assert.deepEqual(s.versions, [{ name: '1.8.0', installs: 2 }, { name: '1.7.0', installs: 1 }])
  assert.deepEqual(
    Object.fromEntries(s.langs.map(l => [l.name, l.installs])),
    { zh: 3, en: 1 }, // A 最近一天是 en
  )

  const r = s.retention
  assert.deepEqual(r.d1, { rate: 0.5, cohortSize: 2 })
  assert.deepEqual(r.d7, { rate: 0.5, cohortSize: 2 })
  assert.deepEqual(r.d30, { rate: null, cohortSize: 0 })
  assert.deepEqual(r.cohorts, [
    { day: addDays(T, -1), size: 1, d1n: null, d7n: null, d30n: null, d1: null, d7: null, d30: null },
    { day: addDays(T, -8), size: 2, d1n: 1, d7n: 1, d30n: null, d1: 0.5, d7: 0.5, d30: null },
  ])

  // 90 天视图能看到 40 天前的那次活跃
  const s90 = await jsonOf(await admin('/v1/admin/stats?days=90'))
  assert.equal(s90.daily.length, 90)
  assert.equal(s90.daily.find(d => d.day === addDays(T, -40)).actives, 1)
})

test('定时任务: 90 天前的心跳聚合进 ping_daily 后删除, installs 保留, 统计仍可见', async () => {
  const env = await server.getWorker().getEnv()
  const T = beijingDay()
  const { A, B, D } = await seedStats(env, T)
  const old = addDays(T, -95)
  await env.DB.batch([
    env.DB.prepare('UPDATE installs SET first_day = ?1 WHERE install_id = ?2').bind(old, A),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(old, A, 'windows', '1.5.0', 'zh', 1),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(old, B, 'windows', '1.5.0', 'zh', 0),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(old, D, 'linux', '1.0.0', 'en', 0),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(addDays(T, -91), D, 'linux', '1.0.0', 'en', 0),
    env.DB.prepare('INSERT INTO pings VALUES(?1, ?2, ?3, ?4, ?5, ?6)').bind(addDays(T, -90), D, 'linux', '1.0.0', 'en', 0),
  ])
  const res = await server.getWorker().scheduled({ cron: '17 3 * * *', scheduledTime: new Date() })
  assert.equal(res.outcome, 'ok')

  const daily = (await env.DB.prepare('SELECT * FROM ping_daily ORDER BY day, platform').all()).results
  assert.deepEqual(daily, [
    { day: old, platform: 'linux', version: '1.0.0', actives: 1, readers: 0, new_installs: 0 },
    { day: old, platform: 'windows', version: '1.5.0', actives: 2, readers: 1, new_installs: 1 },
    { day: addDays(T, -91), platform: 'linux', version: '1.0.0', actives: 1, readers: 0, new_installs: 0 },
  ])
  const left = await env.DB.prepare('SELECT MIN(day) AS d FROM pings').first()
  assert.equal(left.d, addDays(T, -90)) // 正好 90 天前的保留
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM installs').first()).n, 4)

  // 重跑不重复累计
  await server.getWorker().scheduled({ cron: '17 3 * * *', scheduledTime: new Date() })
  assert.equal((await env.DB.prepare('SELECT SUM(actives) AS n FROM ping_daily').first()).n, 4)

  const s = await jsonOf(await admin('/v1/admin/stats?days=120'))
  assert.deepEqual(
    s.daily.find(d => d.day === old),
    { day: old, actives: 3, readers: 1, newInstalls: 1 },
  )
})

// ---- 互传: 账号通道 ----

const utcDay = () => new Date().toISOString().slice(0, 10)
const near = (actual, expected, slack = 10_000) =>
  assert.ok(Math.abs(actual - expected) <= slack, `${actual} ≉ ${expected}`)

async function listFor(token, device, extra = '') {
  const res = await call('GET', `/v1/transfers?device=${device}${extra}`, { token })
  assert.equal(res.status, 200)
  const body = await jsonOf(res)
  assert.equal(typeof body.now, 'number')
  return body.items
}

const sendTransfer = (token, body) => call('POST', '/v1/transfers', { token, body })

function testBytes(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 255
  return out
}

test('互传: 文字发给全部 / 链接发给指定设备; 本机看得到自己发的; 其他账号看不到; since; 设备列表', async () => {
  const a = await login('xfer@example.com')
  const b = await login('xfer@example.com')
  const c = await login('xfer-other@example.com')
  const devA = randomUUID(), devB = randomUUID(), devD = randomUUID()
  assert.deepEqual(await listFor(a.token, devA, '&name=' + encodeURIComponent('  手机 A  ')), [])
  assert.deepEqual(await listFor(b.token, devB, '&name=PC%20B'), [])

  const t0 = Date.now()
  const textRes = await sendTransfer(a.token, { kind: 'text', fromDevice: devA, fromName: '手机 A', text: '你好 hello' })
  assert.equal(textRes.status, 201)
  assert.equal(textRes.headers.get('access-control-allow-origin'), '*')
  const { item: text } = await jsonOf(textRes)
  assert.match(text.id, /^[0-9a-f-]{36}$/)
  const { id: _id, createdAt, expiresAt, ...rest } = text
  assert.deepEqual(rest, { kind: 'text', fromDevice: devA, fromName: '手机 A', toDevice: null, title: '', text: '你好 hello' })
  near(createdAt, t0)
  assert.equal(expiresAt - createdAt, 7 * 86400_000)

  const linkRes = await sendTransfer(a.token, {
    kind: 'link', fromDevice: devA, toDevice: devB, url: ' https://example.com/a?b=1 ', title: ' 例子 ',
  })
  assert.equal(linkRes.status, 201)
  const { item: link } = await jsonOf(linkRes)
  assert.equal(link.url, 'https://example.com/a?b=1')
  assert.equal(link.title, '例子')
  assert.equal(link.toDevice, devB)
  assert.equal(link.fromName, '')
  assert.ok(!('text' in link))
  // 没给标题的链接用网址作标题
  const untitled = await jsonOf(await sendTransfer(a.token, { kind: 'link', fromDevice: devA, toDevice: devA, url: 'http://x.test/' }))
  assert.equal(untitled.item.title, 'http://x.test/')

  // B: 收到文字和发给它的链接, 新到旧; 看不到 A 发给自己的
  const forB = await listFor(b.token, devB)
  assert.deepEqual(forB.map(i => i.id).sort(), [text.id, link.id].sort())
  assert.ok(forB[0].createdAt >= forB[1].createdAt)
  assert.deepEqual(forB.find(i => i.id === text.id), text)
  // 同账号的 D: 只有发给全部的文字
  assert.deepEqual((await listFor(b.token, devD)).map(i => i.id), [text.id])
  // A 自己: 发出的都在
  assert.deepEqual((await listFor(a.token, devA)).map(i => i.id).sort(), [text.id, link.id, untitled.item.id].sort())
  // 其他账号: 即便用同一个设备 id 也看不到
  assert.deepEqual(await listFor(c.token, devA), [])
  assert.deepEqual(await listFor(c.token, devB), [])

  // since: 只返回 created_at > since 的
  assert.deepEqual((await listFor(b.token, devB, `&since=${link.createdAt}`)).map(i => i.id), [])
  const sinceItems = await listFor(b.token, devB, `&since=${link.createdAt - 1}`)
  assert.ok(sinceItems.some(i => i.id === link.id))
  assert.ok(sinceItems.every(i => i.createdAt > link.createdAt - 1))

  // 设备列表: 名字 trim, 改名立即生效; 只列本账号
  await listFor(b.token, devB, '&name=PC%20B2')
  const devRes = await call('GET', '/v1/devices', { token: a.token })
  assert.equal(devRes.status, 200)
  const { devices } = await jsonOf(devRes)
  const byId = Object.fromEntries(devices.map(d => [d.id, d]))
  assert.equal(byId[devA].name, '手机 A')
  assert.equal(byId[devB].name, 'PC B2')
  assert.equal(byId[devD].name, '')
  assert.equal(typeof byId[devA].lastSeenAt, 'number')
  // C 只有自己轮询过的设备 (同一个设备 id 在各账号下各自登记)
  const cDevices = (await jsonOf(await call('GET', '/v1/devices', { token: c.token }))).devices
  assert.deepEqual(cDevices.map(d => d.id).sort(), [devA, devB].sort())
  assert.ok(cDevices.every(d => d.name === ''))
  // 不带 name 的轮询不清掉名字
  await listFor(a.token, devA)
  assert.equal((await jsonOf(await call('GET', '/v1/devices', { token: a.token }))).devices.find(d => d.id === devA).name, '手机 A')

  // device 缺失 / 非法
  for (const q of ['', '?device=', '?device=bad.id', `?device=${'x'.repeat(65)}`]) {
    const res = await call('GET', `/v1/transfers${q}`, { token: a.token })
    assert.equal(res.status, 400, q)
    assert.deepEqual(await jsonOf(res), { error: 'invalid_device' })
  }

  // 未登录一律 401 (先鉴权再校验路径参数)
  for (const [m, p] of [
    ['GET', '/v1/devices'], ['GET', `/v1/transfers?device=${devA}`], ['POST', '/v1/transfers'],
    ['DELETE', `/v1/transfers/${text.id}`], ['PUT', '/v1/transfers/x/blob'], ['GET', '/v1/transfers/bad.id/blob'],
  ]) {
    const res = await call(m, p)
    assert.equal(res.status, 401, `${m} ${p}`)
    assert.deepEqual(await jsonOf(res), { error: 'unauthorized' })
  }
})

test('互传: 文件先建记录 → 上传前不可见 → PUT 本体 → 下载原样字节; 长度不符 400; 删除对所有设备生效', async () => {
  const a = await login('xfer-file@example.com')
  const b = await login('xfer-file@example.com')
  const c = await login('xfer-file-other@example.com')
  const devA = randomUUID(), devB = randomUUID()
  const bytes = testBytes(3000)

  const res = await sendTransfer(a.token, {
    kind: 'file', fromDevice: devA, fromName: 'A', filename: '../dir\\书 "x".epub', size: bytes.length, mime: 'application/epub+zip',
  })
  assert.equal(res.status, 201)
  const { item } = await jsonOf(res)
  assert.equal(item.filename, '书 "x".epub')
  assert.equal(item.title, '书 "x".epub')
  assert.equal(item.size, 3000)
  assert.equal(item.mime, 'application/epub+zip')
  assert.equal(item.expiresAt - item.createdAt, 86400_000) // 24 小时内要传完
  assert.ok(!('text' in item) && !('url' in item))

  // 上传完之前谁都看不到, 也下载不了
  assert.ok(!(await listFor(b.token, devB)).some(i => i.id === item.id))
  assert.ok(!(await listFor(a.token, devA)).some(i => i.id === item.id))
  assert.equal((await call('GET', `/v1/transfers/${item.id}/blob`, { token: b.token })).status, 404)

  const put = (body, token = a.token) => call('PUT', `/v1/transfers/${item.id}/blob`, { token, body, raw: true })
  const short = await put(bytes.slice(0, 100))
  assert.equal(short.status, 400)
  assert.deepEqual(await jsonOf(short), { error: 'invalid_length' })
  assert.equal((await put(new Uint8Array(0))).status, 400)
  // 其他账号上传 → 404
  assert.equal((await put(bytes, c.token)).status, 404)
  assert.equal((await put(bytes)).status, 204)
  const again = await put(bytes)
  assert.equal(again.status, 409)
  assert.deepEqual(await jsonOf(again), { error: 'already_uploaded' })

  const listed = (await listFor(b.token, devB)).find(i => i.id === item.id)
  assert.ok(listed)
  near(listed.expiresAt, Date.now() + 7 * 86400_000)

  const got = await call('GET', `/v1/transfers/${item.id}/blob`, { token: b.token })
  assert.equal(got.status, 200)
  assert.equal(got.headers.get('content-type'), 'application/octet-stream')
  assert.equal(got.headers.get('content-length'), '3000')
  assert.equal(
    got.headers.get('content-disposition'),
    `attachment; filename="_ _x_.epub"; filename*=UTF-8''%E4%B9%A6%20%22x%22.epub`,
  )
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(got.headers.get('cache-control'), 'no-store')
  assert.equal(got.headers.get('access-control-allow-origin'), '*')
  assert.match(got.headers.get('access-control-expose-headers'), /content-disposition/)
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes)

  // 其他账号下载 / 删除 → 404
  assert.equal((await call('GET', `/v1/transfers/${item.id}/blob`, { token: c.token })).status, 404)
  assert.equal((await call('DELETE', `/v1/transfers/${item.id}`, { token: c.token })).status, 404)

  const env = await server.getWorker().getEnv()
  const key = `transfer/${a.account.id}/${item.id}`
  assert.ok(await env.DOCS.get(key))

  // B 删除: 对所有设备生效, R2 对象一起删
  assert.equal((await call('DELETE', `/v1/transfers/${item.id}`, { token: b.token })).status, 204)
  assert.ok(!(await listFor(a.token, devA)).some(i => i.id === item.id))
  assert.equal(await env.DOCS.get(key), null)
  assert.equal((await call('DELETE', `/v1/transfers/${item.id}`, { token: b.token })).status, 404)
  assert.equal((await call('GET', `/v1/transfers/${item.id}/blob`, { token: a.token })).status, 404)

  // 文字条目不能 PUT 本体
  const { item: txt } = await jsonOf(await sendTransfer(a.token, { kind: 'text', fromDevice: devA, text: 'x' }))
  assert.equal((await call('PUT', `/v1/transfers/${txt.id}/blob`, { token: a.token, body: 'x', raw: true })).status, 404)
})

test('互传: 字段校验 → 400 invalid_transfer; 超限 → 413 too_large', async () => {
  const { token } = await login('xfer-valid@example.com')
  const dev = randomUUID()
  const bad = [
    {},
    { kind: 'image', fromDevice: dev, text: 'x' },
    { kind: 'text', text: 'x' },
    { kind: 'text', fromDevice: 'bad.id', text: 'x' },
    { kind: 'text', fromDevice: dev, toDevice: 'a b', text: 'x' },
    { kind: 'text', fromDevice: dev, toDevice: 5, text: 'x' },
    { kind: 'text', fromDevice: dev },
    { kind: 'text', fromDevice: dev, text: '   ' },
    { kind: 'text', fromDevice: dev, text: 5 },
    { kind: 'text', fromDevice: dev, text: 'x', title: 'x'.repeat(301) },
    { kind: 'text', fromDevice: dev, text: 'x', title: 7 },
    { kind: 'text', fromDevice: dev, text: 'x', fromName: 7 },
    { kind: 'link', fromDevice: dev },
    { kind: 'link', fromDevice: dev, url: 'javascript:alert(1)' },
    { kind: 'link', fromDevice: dev, url: 'data:text/html,<b>x</b>' },
    { kind: 'link', fromDevice: dev, url: 'not a url' },
    { kind: 'link', fromDevice: dev, url: 'https://e.com/' + 'x'.repeat(4096) },
    { kind: 'file', fromDevice: dev, size: 10 },
    { kind: 'file', fromDevice: dev, filename: '../', size: 10 },
    { kind: 'file', fromDevice: dev, filename: '..', size: 10 },
    { kind: 'file', fromDevice: dev, filename: 'a.epub' },
    { kind: 'file', fromDevice: dev, filename: 'a.epub', size: 0 },
    { kind: 'file', fromDevice: dev, filename: 'a.epub', size: 1.5 },
    { kind: 'file', fromDevice: dev, filename: 'a.epub', size: '10' },
    { kind: 'file', fromDevice: dev, filename: 'x'.repeat(256), size: 10 },
    { kind: 'file', fromDevice: dev, filename: 'a.epub', size: 10, mime: 'x'.repeat(101) },
    [],
  ]
  for (const body of bad) {
    const res = await sendTransfer(token, body)
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80))
    assert.deepEqual(await jsonOf(res), { error: 'invalid_transfer' })
  }
  assert.equal((await call('POST', '/v1/transfers', { token, body: '{oops', raw: true })).status, 400)

  // 正好 64 KB 可以; 多 1 字节 / 按 UTF-8 计超限 → 413
  assert.equal((await sendTransfer(token, { kind: 'text', fromDevice: dev, text: 'x'.repeat(64 * 1024) })).status, 201)
  for (const body of [
    { kind: 'text', fromDevice: dev, text: 'x'.repeat(64 * 1024 + 1) },
    { kind: 'text', fromDevice: dev, text: '中'.repeat(22000) }, // 66000 字节
    { kind: 'file', fromDevice: dev, filename: 'a.pdf', size: 50 * 1024 * 1024 + 1 },
    { kind: 'text', fromDevice: dev, text: 'x', pad: 'x'.repeat(81 * 1024) }, // 请求体超 80 KB
  ]) {
    const res = await sendTransfer(token, body)
    assert.equal(res.status, 413)
    assert.deepEqual(await jsonOf(res), { error: 'too_large' })
  }
  assert.equal((await sendTransfer(token, { kind: 'file', fromDevice: dev, filename: 'a.pdf', size: 50 * 1024 * 1024 })).status, 201)
  // 上传本体时 content-length 超过 50 MB → 413 (不读请求体)
  const huge = await call('PUT', `/v1/transfers/${randomUUID()}/blob`, {
    token, body: new Uint8Array(50 * 1024 * 1024 + 1), raw: true,
  })
  assert.equal(huge.status, 413)
})

test('互传限流: 每账号每天 200 条 / 500 MB → 429 + retryAfter; 超限的字节不计入', async () => {
  const { token, account } = await login('xfer-limit@example.com')
  const env = await server.getWorker().getEnv()
  const day = utcDay()
  const dev = randomUUID()
  await env.DB.prepare('INSERT INTO counters(key, day, count) VALUES(?1, ?2, 500 * 1024 * 1024 - 10)')
    .bind(`xfer:b:${account.id}`, day)
    .run()
  const tooMuch = await sendTransfer(token, { kind: 'file', fromDevice: dev, filename: 'a', size: 11 })
  assert.equal(tooMuch.status, 429)
  const body = await jsonOf(tooMuch)
  assert.equal(body.error, 'rate_limited')
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400)
  assert.equal(tooMuch.headers.get('retry-after'), String(body.retryAfter))
  assert.equal((await sendTransfer(token, { kind: 'file', fromDevice: dev, filename: 'a', size: 10 })).status, 201)
  const used = await env.DB.prepare('SELECT count FROM counters WHERE key = ?1 AND day = ?2').bind(`xfer:b:${account.id}`, day).first()
  assert.equal(used.count, 500 * 1024 * 1024)
  // 字节用完后文字还能发
  assert.equal((await sendTransfer(token, { kind: 'text', fromDevice: dev, text: 'x' })).status, 201)

  await env.DB.prepare('UPDATE counters SET count = 200 WHERE key = ?1 AND day = ?2').bind(`xfer:n:${account.id}`, day).run()
  const items = await sendTransfer(token, { kind: 'text', fromDevice: dev, text: 'x' })
  assert.equal(items.status, 429)
  assert.equal((await jsonOf(items)).error, 'rate_limited')
})

test('DELETE /v1/me: 一并删除互传条目、设备登记与 R2 文件', async () => {
  const s = await login('xfer-bye@example.com')
  const dev = randomUUID()
  await listFor(s.token, dev, '&name=x')
  const { item } = await jsonOf(await sendTransfer(s.token, { kind: 'file', fromDevice: dev, filename: 'a.bin', size: 5 }))
  assert.equal((await call('PUT', `/v1/transfers/${item.id}/blob`, { token: s.token, body: testBytes(5), raw: true })).status, 204)
  assert.equal((await sendTransfer(s.token, { kind: 'text', fromDevice: dev, text: 'x' })).status, 201)
  const env = await server.getWorker().getEnv()
  assert.equal((await env.DOCS.list({ prefix: `transfer/${s.account.id}/` })).objects.length, 1)

  assert.equal((await call('DELETE', '/v1/me', { token: s.token })).status, 204)
  assert.equal((await env.DOCS.list({ prefix: `transfer/${s.account.id}/` })).objects.length, 0)
  for (const table of ['transfers', 'devices']) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?1`).bind(s.account.id).first()
    assert.equal(row.n, 0, table)
  }
})

// ---- 互传: 临时取件码 ----

const createDrop = (body, opts = {}) => call('POST', '/v1/drops', { body, ...opts })
const lookup = (code, ip) => call('GET', `/v1/drops/${code}`, ip ? { headers: { 'cf-connecting-ip': ip } } : {})

/** 与 Worker 的 ipRateKey 相同: <prefix>:HMAC-SHA256('lightread-ping:' + ADMIN_TOKEN, 日期|IP) 前 32 位十六进制 */
const ipKey = (prefix, ip, day = utcDay()) =>
  `${prefix}:` + createHmac('sha256', `lightread-ping:${ADMIN_TOKEN}`).update(`${day}|${ip}`).digest('hex').slice(0, 32)

/** 库里不存在的 6 位取件码 */
async function unusedCodes(n) {
  const env = await server.getWorker().getEnv()
  const used = new Set((await env.DB.prepare('SELECT code FROM drops').all()).results.map(r => r.code))
  const out = []
  for (let i = 0; out.length < n; i++) {
    const code = String(100000 + i * 7919)
    if (!used.has(code)) out.push(code)
  }
  return out
}

test('取件码: 匿名文字取件, 每次查看算一次领取, 10 次后 410; 链接默认 1 小时; 过期 410', async () => {
  const t0 = Date.now()
  const res = await createDrop({ kind: 'text', text: '取件内容', ttl: 600 })
  assert.equal(res.status, 201)
  const drop = await jsonOf(res)
  assert.match(drop.code, /^\d{6}$/)
  assert.match(drop.ownerToken, /^[A-Za-z0-9_-]{43}$/)
  assert.match(drop.id, /^[0-9a-f-]{36}$/)
  assert.equal(drop.maxDownloads, 10)
  near(drop.expiresAt, t0 + 600_000)

  for (let i = 1; i <= 10; i++) {
    const got = await lookup(drop.code)
    assert.equal(got.status, 200, `lookup ${i}`)
    assert.equal(got.headers.get('cache-control'), 'no-store')
    const body = await jsonOf(got)
    assert.equal(body.downloadsLeft, 10 - i)
    if (i === 1) {
      const { createdAt, ...rest } = body
      assert.deepEqual(rest, { kind: 'text', title: '', text: '取件内容', expiresAt: drop.expiresAt, downloadsLeft: 9 })
      near(createdAt, t0)
    }
  }
  const gone = await lookup(drop.code)
  assert.equal(gone.status, 410)
  assert.deepEqual(await jsonOf(gone), { error: 'gone' })

  const link = await jsonOf(await createDrop({ kind: 'link', url: 'https://example.com/x' }))
  near(link.expiresAt, Date.now() + 3600_000)
  const got = await jsonOf(await lookup(link.code))
  assert.equal(got.url, 'https://example.com/x')
  assert.equal(got.title, 'https://example.com/x')
  assert.ok(!('text' in got) && !('filename' in got))

  // 过期 → 410
  const env = await server.getWorker().getEnv()
  await env.DB.prepare('UPDATE drops SET expires_at = ?1 WHERE id = ?2').bind(Date.now() - 1, link.id).run()
  assert.equal((await lookup(link.code)).status, 410)
})

test('取件码: 校验 → 400 invalid_drop; 匿名文件 20 MB, 登录后 50 MB; 无效 token 按匿名处理', async () => {
  for (const body of [
    { kind: 'text', text: 'x', ttl: 60 },
    { kind: 'text', text: 'x', ttl: '600' },
    { kind: 'text', text: 'x', ttl: 7200 },
    { kind: 'note', text: 'x' },
    { kind: 'text' },
    { kind: 'link', url: 'javascript:alert(1)' },
    { kind: 'file', filename: 'a', size: 0 },
    'x',
  ]) {
    const res = await createDrop(body)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.deepEqual(await jsonOf(res), { error: 'invalid_drop' })
  }
  assert.equal((await createDrop({ kind: 'text', text: 'x'.repeat(64 * 1024 + 1) })).status, 413)

  const file = size => ({ kind: 'file', filename: 'big.pdf', size })
  assert.equal((await createDrop(file(20 * 1024 * 1024))).status, 201)
  const anon = await createDrop(file(25 * 1024 * 1024))
  assert.equal(anon.status, 413)
  assert.deepEqual(await jsonOf(anon), { error: 'too_large' })
  assert.equal((await createDrop(file(25 * 1024 * 1024), { token: 'x'.repeat(43) })).status, 413)
  const { token, account } = await login('drop-sender@example.com')
  const authed = await createDrop(file(25 * 1024 * 1024), { token })
  assert.equal(authed.status, 201)
  assert.equal((await createDrop(file(50 * 1024 * 1024 + 1), { token })).status, 413)
  const env = await server.getWorker().getEnv()
  const row = await env.DB.prepare('SELECT account_id, owner_hash FROM drops WHERE id = ?1').bind((await jsonOf(authed)).id).first()
  assert.equal(row.account_id, account.id)
  assert.match(row.owner_hash, /^[0-9a-f]{64}$/)
})

test('取件码: 文件上传凭 x-drop-token; 查看元数据不算领取, 下载算; 撤回删文件', async () => {
  const bytes = testBytes(1234)
  const drop = await jsonOf(await createDrop({ kind: 'file', filename: 'notes.txt', size: bytes.length, mime: 'text/plain' }))
  // 上传前查不到 (算一次输错)
  assert.equal((await lookup(drop.code)).status, 404)

  const put = (body, tokenHeader) =>
    call('PUT', `/v1/drops/${drop.id}/blob`, { body, raw: true, headers: tokenHeader === undefined ? {} : { 'x-drop-token': tokenHeader } })
  assert.equal((await put(bytes)).status, 403)
  const wrong = await put(bytes, 'x'.repeat(43))
  assert.equal(wrong.status, 403)
  assert.deepEqual(await jsonOf(wrong), { error: 'forbidden' })
  assert.equal((await call('PUT', `/v1/drops/${randomUUID()}/blob`, { body: bytes, raw: true, headers: { 'x-drop-token': drop.ownerToken } })).status, 404)
  assert.equal((await put(bytes.slice(1), drop.ownerToken)).status, 400)
  assert.equal((await put(bytes, drop.ownerToken)).status, 204)
  assert.equal((await put(bytes, drop.ownerToken)).status, 409)

  const meta = await jsonOf(await lookup(drop.code))
  assert.equal(meta.kind, 'file')
  assert.equal(meta.filename, 'notes.txt')
  assert.equal(meta.title, 'notes.txt')
  assert.equal(meta.size, 1234)
  assert.equal(meta.mime, 'text/plain')
  assert.equal(meta.downloadsLeft, 10)
  assert.equal((await lookup(drop.code)).status, 200)

  const blob = await call('GET', `/v1/drops/${drop.code}/blob`)
  assert.equal(blob.status, 200)
  assert.equal(blob.headers.get('content-type'), 'application/octet-stream')
  assert.equal(blob.headers.get('content-disposition'), `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`)
  assert.equal(blob.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(blob.headers.get('cache-control'), 'no-store')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes)
  assert.equal((await jsonOf(await lookup(drop.code))).downloadsLeft, 9)

  // 文字取件没有 blob
  const text = await jsonOf(await createDrop({ kind: 'text', text: 'hi' }))
  assert.equal((await call('GET', `/v1/drops/${text.code}/blob`)).status, 404)
  assert.equal((await call('PUT', `/v1/drops/${text.id}/blob`, { body: 'x', raw: true, headers: { 'x-drop-token': text.ownerToken } })).status, 409)

  // 撤回: 错 token 403, 对的 204, 文件一起删
  const env = await server.getWorker().getEnv()
  assert.ok(await env.DOCS.get(`drop/${drop.id}`))
  assert.equal((await call('DELETE', `/v1/drops/${drop.id}`, { headers: { 'x-drop-token': text.ownerToken } })).status, 403)
  assert.equal((await call('DELETE', `/v1/drops/${drop.id}`, { headers: { 'x-drop-token': drop.ownerToken } })).status, 204)
  assert.equal(await env.DOCS.get(`drop/${drop.id}`), null)
  assert.equal((await call('DELETE', `/v1/drops/${drop.id}`, { headers: { 'x-drop-token': drop.ownerToken } })).status, 404)
  assert.equal((await lookup(drop.code)).status, 404)
})

test('取件码限流: 每 IP 每天建 20 次; 查询 60 次; 输错 10 次后当天全部 429; 计数键不含 IP', async () => {
  const ip = '198.51.100.7'
  for (let i = 1; i <= 20; i++) {
    const res = await createDrop({ kind: 'text', text: `n${i}` }, { headers: { 'cf-connecting-ip': ip } })
    assert.equal(res.status, 201, `create ${i}`)
  }
  const limited = await createDrop({ kind: 'text', text: 'x' }, { headers: { 'cf-connecting-ip': ip } })
  assert.equal(limited.status, 429)
  const body = await jsonOf(limited)
  assert.equal(body.error, 'rate_limited')
  assert.ok(body.retryAfter > 0 && body.retryAfter <= 86400)
  const env = await server.getWorker().getEnv()
  const row = await env.DB.prepare('SELECT count FROM counters WHERE key = ?1 AND day = ?2').bind(ipKey('drop:c', ip), utcDay()).first()
  assert.equal(row.count, 21)
  const all = (await env.DB.prepare('SELECT key FROM counters').all()).results
  assert.ok(!all.some(r => r.key.includes(ip)))

  // 输错: 格式错与查无都算; 满 10 次后连正确的码也 429, 别的 IP 不受影响
  const target = await jsonOf(await createDrop({ kind: 'text', text: 'target' }))
  const guesser = '198.51.100.8'
  const misses = ['abcdef', '12345', '1234567', ...(await unusedCodes(7))]
  for (const [i, code] of misses.entries()) {
    const res = await lookup(code, guesser)
    assert.equal(res.status, i < 3 ? 400 : 404, code)
    assert.deepEqual(await jsonOf(res), { error: i < 3 ? 'invalid_code' : 'not_found' })
  }
  const locked = await lookup(target.code, guesser)
  assert.equal(locked.status, 429)
  assert.equal((await jsonOf(locked)).error, 'rate_limited')
  assert.equal((await lookup(target.code, '198.51.100.9')).status, 200)

  // 查询次数: 推到 60 次后 429
  const heavy = '198.51.100.10'
  await env.DB.prepare('INSERT INTO counters(key, day, count) VALUES(?1, ?2, 60)').bind(ipKey('drop:q', heavy), utcDay()).run()
  assert.equal((await lookup(target.code, heavy)).status, 429)
  assert.equal((await call('GET', `/v1/drops/${target.code}/blob`, { headers: { 'cf-connecting-ip': heavy } })).status, 429)
})

test('取件码分享链接 /d/<code>: 未配 WEB_APP_URL 时纯文本说明; 预检放行 x-drop-token', async () => {
  const res = await call('GET', '/d/123456')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  const text = await res.text()
  assert.match(text, /123456/)
  assert.match(text, /互传/)
  assert.doesNotMatch(text, /</)
  for (const p of ['/d/abc', '/d/1234567', '/d/123456/x']) assert.equal((await call('GET', p)).status, 404, p)

  const pre = await call('OPTIONS', '/v1/drops/abc/blob', {
    headers: { origin: 'https://app.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-drop-token' },
  })
  assert.equal(pre.status, 204)
  assert.match(pre.headers.get('access-control-allow-headers'), /x-drop-token/)
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/)
  // 未知方法 / 路径
  assert.equal((await call('PATCH', '/v1/drops/abc')).status, 404)
  assert.equal((await call('GET', '/v1/drops')).status, 404)
})

test('取件码分享链接: 配了 WEB_APP_URL 时 302 到网页版互传页', async () => {
  const web = createTestHarness({
    root,
    workers: [{ configPath: './wrangler.jsonc', vars: { WEB_APP_URL: 'https://read.example/app/#/library' } }],
  })
  try {
    await web.listen()
    const res = await web.fetch(BASE + '/d/012345', { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), 'https://read.example/app/#/transfer?code=012345')
  } finally {
    await web.close()
  }
})

test('定时清理: 过期的互传 / 取件连同 R2 文件删除, 未过期的保留; 90 天没见过的设备删除', async () => {
  const env = await server.getWorker().getEnv()
  const now = Date.now()
  const acct = randomUUID()
  const ins = (id, expiresAt) =>
    env.DB.prepare(
      "INSERT INTO transfers(id, account_id, from_device, kind, title, r2_key, size, filename, ready, created_at, expires_at) " +
        "VALUES(?1, ?2, 'dev', 'file', 't', ?3, 1, 'f', 1, ?4, ?5)",
    ).bind(id, acct, `transfer/${acct}/${id}`, now - 8 * 86400_000, expiresAt)
  const insDrop = (id, code, expiresAt) =>
    env.DB.prepare(
      "INSERT INTO drops(id, code, owner_hash, kind, r2_key, size, filename, created_at, expires_at) " +
        "VALUES(?1, ?2, 'h', 'file', ?3, 1, 'f', ?4, ?5)",
    ).bind(id, code, `drop/${id}`, now - 7200_000, expiresAt)
  const [oldT, newT, oldD, newD] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const [codeOld, codeNew] = await unusedCodes(2)
  await env.DB.batch([
    ins(oldT, now - 1000),
    ins(newT, now + 86400_000),
    insDrop(oldD, codeOld, now - 1000),
    insDrop(newD, codeNew, now + 600_000),
    env.DB.prepare("INSERT INTO devices VALUES(?1, 'old-dev', 'x', ?2)").bind(acct, now - 91 * 86400_000),
    env.DB.prepare("INSERT INTO devices VALUES(?1, 'new-dev', 'x', ?2)").bind(acct, now - 89 * 86400_000),
  ])
  for (const key of [`transfer/${acct}/${oldT}`, `transfer/${acct}/${newT}`, `drop/${oldD}`, `drop/${newD}`]) {
    await env.DOCS.put(key, 'x')
  }

  const res = await server.getWorker().scheduled({ cron: '17 3 * * *', scheduledTime: new Date() })
  assert.equal(res.outcome, 'ok')

  const ids = async table =>
    (await env.DB.prepare(`SELECT id FROM ${table} WHERE id IN (?1, ?2, ?3, ?4)`).bind(oldT, newT, oldD, newD).all()).results.map(r => r.id)
  assert.deepEqual(await ids('transfers'), [newT])
  assert.deepEqual(await ids('drops'), [newD])
  assert.equal(await env.DOCS.get(`transfer/${acct}/${oldT}`), null)
  assert.equal(await env.DOCS.get(`drop/${oldD}`), null)
  assert.ok(await env.DOCS.get(`transfer/${acct}/${newT}`))
  assert.ok(await env.DOCS.get(`drop/${newD}`))
  const devs = (await env.DB.prepare('SELECT device_id FROM devices WHERE account_id = ?1').bind(acct).all()).results.map(r => r.device_id)
  assert.deepEqual(devs, ['new-dev'])
})

test('心跳: 点睛汇总 dj 可选; 合法的日子入库, 不合法的那天丢掉, 心跳照常; 统计接口给出合计', async () => {
  const env = await server.getWorker().getEnv()
  await env.DB.prepare('DELETE FROM dj_daily').run()
  const T = beijingDay()
  const id = randomUUID()
  const day = n => addDays(T, -n)
  const good = { d: day(1), m: [30, 0, 45, 15], lv: [0, 45, 15], ai: [9, 10], nf: [1, 40] }
  const res = await call('POST', '/v1/ping', {
    body: pingBody({
      id,
      dj: [
        good,
        { ...good, d: day(1), m: [1, 1, 1, 1] }, // 同一天第二条: 忽略
        { ...good, d: T }, // 今天还没过完: 丢掉
        { ...good, d: day(9) }, // 太旧: 丢掉
      ],
    }),
  })
  assert.equal(res.status, 204)
  const rows = (await env.DB.prepare('SELECT * FROM dj_daily WHERE install_id = ?1').bind(id).all()).results
  assert.equal(rows.length, 1)
  assert.equal(rows[0].day, day(1))
  assert.deepEqual([rows[0].min_off, rows[0].min_words, rows[0].min_key, rows[0].min_smart], [30, 0, 45, 15])
  assert.deepEqual([rows[0].lv_low, rows[0].lv_mid, rows[0].lv_high, rows[0].ai_ok, rows[0].ai_all, rows[0].kw_missing, rows[0].kw_all], [0, 45, 15, 9, 10, 1, 40])
  // 不合法的 dj 不影响心跳本身
  for (const dj of ['x', [{ d: day(1), m: [1, 2, 3] }], [{ ...good, m: [2000, 0, 0, 0] }], [{ ...good, ai: [11, 10] }], [{ ...good, nf: [-1, 3] }]]) {
    const other = randomUUID()
    assert.equal((await call('POST', '/v1/ping', { body: pingBody({ id: other, dj }) })).status, 204, JSON.stringify(dj))
    assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM dj_daily WHERE install_id = ?1').bind(other).first()).n, 0)
  }
  // 体积: 3 天的汇总在上限内
  const three = await call('POST', '/v1/ping', { body: pingBody({ dj: [1, 2, 3].map(n => ({ ...good, d: day(n) })) }) })
  assert.equal(three.status, 204)
  const stats = await jsonOf(await admin('/v1/admin/stats?days=7'))
  assert.ok(stats.dianjing)
  const t = stats.dianjing.totals
  assert.ok(t.minutes.key >= 45)
  assert.ok(t.keyAdoption > 0 && t.keyAdoption <= 1)
  assert.ok(t.aiUsable > 0 && t.aiUsable <= 1)
  assert.equal(stats.dianjing.daily.find(r => r.day === day(1)).usersKey, 2)
})

// ---- 读者反馈 ----

/** 最小的合法 zip (空归档: 只有中央目录结束记录, 以 PK 开头) */
const EMPTY_ZIP = Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])

test('反馈: 匿名提交文字 → 201; 管理接口能看到, 状态 new; 字段校验 → 400', async () => {
  const ok = await call('POST', '/v1/feedback', {
    body: { kind: 'bug', text: '  翻页卡住  ', contact: 'wx: reader1', version: '2.10.8', platform: 'android', extra: 1 },
  })
  assert.equal(ok.status, 201)
  assert.equal(ok.headers.get('access-control-allow-origin'), '*')
  const { id } = await jsonOf(ok)
  assert.match(id, /^[0-9a-f-]{36}$/)

  for (const [body, error] of [
    [{ kind: 'nope', text: 'x' }, 'invalid_kind'],
    [{ kind: 'bug', text: '   ' }, 'invalid_text'],
    [{ kind: 'bug', text: 'x'.repeat(4001) }, 'invalid_text'],
    [{ kind: 'bug', text: 'x', log: 'bm90IGEgemlw' }, 'invalid_log'],
    [{ kind: 'bug', text: 'x', log: 42 }, 'invalid_log'],
    ['not json', 'invalid_feedback'],
  ]) {
    const res = await call('POST', '/v1/feedback', typeof body === 'string' ? { body, raw: true } : { body })
    assert.equal(res.status, 400, error)
    assert.equal((await jsonOf(res)).error, error)
  }

  const list = await jsonOf(await admin('/v1/admin/feedback?status=new'))
  const item = list.items.find(i => i.id === id)
  assert.deepEqual(
    { kind: item.kind, text: item.text, contact: item.contact, version: item.version, platform: item.platform, logSize: item.logSize, status: item.status, accountEmail: item.accountEmail },
    { kind: 'bug', text: '翻页卡住', contact: 'wx: reader1', version: '2.10.8', platform: 'android', logSize: 0, status: 'new', accountEmail: null },
  )
  assert.ok(list.counts.new >= 1)
})

test('反馈: 登录后附带账号; 日志 zip 存 R2, 管理员可下载原样字节; 无效 token 按匿名', async () => {
  const { token } = await login('feedback-user@example.com')
  const res = await call('POST', '/v1/feedback', {
    token,
    body: { kind: 'feature', text: '想要单手模式', log: EMPTY_ZIP.toString('base64') },
  })
  assert.equal(res.status, 201)
  const { id } = await jsonOf(res)
  const anon = await call('POST', '/v1/feedback', { token: 'x'.repeat(43), body: { kind: 'other', text: 'hi' } })
  assert.equal(anon.status, 201)
  const anonId = (await jsonOf(anon)).id

  const { items } = await jsonOf(await admin('/v1/admin/feedback'))
  const mine = items.find(i => i.id === id)
  assert.equal(mine.accountEmail, 'feedback-user@example.com')
  assert.equal(mine.logSize, EMPTY_ZIP.length)
  assert.equal(items.find(i => i.id === anonId).accountEmail, null)

  const log = await admin(`/v1/admin/feedback/${id}/log`)
  assert.equal(log.status, 200)
  assert.equal(log.headers.get('content-type'), 'application/zip')
  assert.deepEqual(Buffer.from(await log.arrayBuffer()), EMPTY_ZIP)
  assert.equal((await admin(`/v1/admin/feedback/${anonId}/log`)).status, 404)

  // 注销账号: 反馈留下, 与账号脱钩
  assert.equal((await call('DELETE', '/v1/me', { token })).status, 204)
  const after = (await jsonOf(await admin('/v1/admin/feedback'))).items.find(i => i.id === id)
  assert.equal(after.accountEmail, null)
  assert.equal(after.text, '想要单手模式')
})

test('反馈管理: 鉴权; 改状态 / 备注; 按状态与时间筛选; 非法值 400', async () => {
  for (const token of [null, 'wrong-token']) {
    const headers = token ? { authorization: `Bearer ${token}` } : {}
    assert.equal((await call('GET', '/v1/admin/feedback', { headers })).status, 401)
    assert.equal((await call('POST', `/v1/admin/feedback/${randomUUID()}`, { headers, body: { status: 'seen' } })).status, 401)
  }
  const before = Date.now()
  const { id } = await jsonOf(await call('POST', '/v1/feedback', { body: { kind: 'bug', text: '状态测试' } }))
  const upd = (body) => call('POST', `/v1/admin/feedback/${id}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, body })
  const r = await upd({ status: 'planned', note: '下个版本修' })
  assert.equal(r.status, 200)
  assert.deepEqual([(await jsonOf(r)).status, (await jsonOf(await upd({ note: '已排期' }))).note], ['planned', '已排期'])
  assert.equal((await upd({ status: 'bogus' })).status, 400)
  assert.equal((await upd({})).status, 400)
  assert.equal((await call('POST', `/v1/admin/feedback/${randomUUID()}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, body: { status: 'seen' } })).status, 404)

  const planned = await jsonOf(await admin(`/v1/admin/feedback?status=planned&since=${before}`))
  assert.deepEqual(planned.items.map(i => i.id), [id])
  assert.equal((await jsonOf(await admin('/v1/admin/feedback?status=new'))).items.some(i => i.id === id), false)
  assert.equal((await admin('/v1/admin/feedback?status=bogus')).status, 400)
  assert.equal((await admin('/v1/admin/feedback/../x/log')).status === 200, false)
})

test('反馈限流: 每个 IP 每天 10 条 → 429 + retryAfter', async () => {
  const headers = { 'cf-connecting-ip': '203.0.113.77' }
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('POST', '/v1/feedback', { headers, body: { kind: 'other', text: `第 ${i} 条` } })).status, 201)
  }
  const res = await call('POST', '/v1/feedback', { headers, body: { kind: 'other', text: '超了' } })
  assert.equal(res.status, 429)
  assert.ok((await jsonOf(res)).retryAfter > 0)
})
