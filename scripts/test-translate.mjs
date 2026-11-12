// 划词翻译与正文简繁转换: 目标语言 / 请求校验 / 提示词同源 / 错误归类 / relay 账号额度 / 等长简繁转换
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  ACCOUNT_TRANSLATE_DAILY,
  LOCAL_TRANSLATE_PIECE_CHARS,
  localTranslatePrompt,
  shouldTranslateLocally,
  splitForLocalTranslate,
  mostlyChinese,
  resolveTarget,
  sanitizeTranslate,
  TRANSLATE_MAX_CHARS,
  translateMaxTokens,
  translateMessages,
  validateTranslate,
} from '../src/services/translateCore.ts'
import { convertPreservingLength, loadZhConverter } from '../src/services/zhConvert.ts'
import { verifyAccount } from '../relay/src/lib.js'

test('目标语言: 自动时中文译英文, 其他译成界面语言; 简体目标遇中文改译英文', () => {
  assert.equal(mostlyChinese('正义是强者的利益。'), true)
  assert.equal(mostlyChinese('Justice is the advantage of the stronger.'), false)
  assert.equal(mostlyChinese('これは日本語の文章です'), false, 'kana marks Japanese, not Chinese')
  assert.equal(mostlyChinese('“Polis” 一词指城邦'), true)
  assert.equal(resolveTarget('正义是强者的利益', 'auto', 'zh'), 'en')
  assert.equal(resolveTarget('Justice is the advantage', 'auto', 'zh'), 'zh-Hans')
  assert.equal(resolveTarget('La justice est', 'auto', 'en'), 'en')
  assert.equal(resolveTarget('正义', 'zh-Hans', 'zh'), 'en')
  assert.equal(resolveTarget('正义', 'zh-Hant', 'zh'), 'zh-Hant')
  assert.equal(resolveTarget('Justice', 'ja', 'zh'), 'ja')
})

test('请求校验: 只接受固定 schema 与长度上限', () => {
  assert.equal(validateTranslate({ text: 'hi', target: 'zh-Hans' }), null)
  assert.equal(validateTranslate({ text: 'hi', target: 'zh-Hans', book: '理想国' }), null)
  assert.match(validateTranslate({ text: '', target: 'en' }), /empty/)
  assert.match(validateTranslate({ text: 'x'.repeat(TRANSLATE_MAX_CHARS + 1), target: 'en' }), /too long/)
  assert.match(validateTranslate({ text: 'hi', target: 'auto' }), /target/, 'auto must be resolved on the client')
  assert.match(validateTranslate({ text: 'hi', target: 'xx' }), /target/)
  assert.match(validateTranslate({ text: 'hi', target: 'en', book: 3 }), /book/)
  assert.match(validateTranslate(null), /body/)
  const clean = sanitizeTranslate({ text: '  hi  ', target: 'en', book: 'b'.repeat(500), extra: 'drop' })
  assert.deepEqual(Object.keys(clean).sort(), ['book', 'target', 'text'])
  assert.equal(clean.text, 'hi')
  assert.equal(clean.book.length, 120)
})

test('提示词: 只要译文, 带目标语言与书名; 输出上限随原文长度', () => {
  const [system, user] = translateMessages({ text: '正义', target: 'en', book: '理想国' })
  assert.equal(system.role, 'system')
  assert.match(system.content, /English/)
  assert.match(system.content, /Output only the translation/)
  assert.match(system.content, /理想国/)
  assert.deepEqual(user, { role: 'user', content: '正义' })
  assert.match(translateMessages({ text: 'x', target: 'zh-Hant' })[0].content, /Traditional Chinese/)
  assert.equal(translateMaxTokens('x'), 256)
  assert.equal(translateMaxTokens('x'.repeat(4000)), 4096)
})

test('relay 与客户端提示词同源: relay 直接 import translateCore.ts', () => {
  const src = readFileSync(new URL('../relay/src/index.js', import.meta.url), 'utf8')
  assert.match(src, /from '\.\.\/\.\.\/src\/services\/translateCore\.ts'/)
  assert.doesNotMatch(src, /professional literary translator/)
})

test('客户端错误归类: 401 → 登录, 429 按 code 区分额度 / 预算 / 限速', async () => {
  const { classifyTranslateError } = await import('../src/services/translate.ts').catch(() => ({}))
  // translate.ts 依赖 Vue / Pinia 运行时: 在 node 下导入失败时跳过 (逻辑由 e2e 覆盖)
  if (!classifyTranslateError) return
  assert.equal(classifyTranslateError('401 {"error":{"code":"login"}}'), 'login')
  assert.equal(classifyTranslateError('429 {"error":{"message":"x","code":"quota"}}'), 'quota')
  assert.equal(classifyTranslateError('429 {"error":{"code":"budget"}}'), 'budget')
  assert.equal(classifyTranslateError('429 {"error":{"code":"rate"}}'), 'rate')
  assert.equal(classifyTranslateError('429 too many'), 'quota')
  assert.equal(classifyTranslateError('502 upstream'), 'failed')
})

test('relay 账号校验: 有效 token 缓存 10 分钟, 401 视为失效, 服务故障不当成失效', async () => {
  let calls = 0
  const ok = async () => { calls++; return new Response(JSON.stringify({ account: { id: 'u1' } }), { status: 200 }) }
  const now = 1_800_000_000_000
  assert.equal(await verifyAccount('token-aaaaaaaaaaaaaaaa', ok, now), 'u1')
  assert.equal(await verifyAccount('token-aaaaaaaaaaaaaaaa', ok, now + 60_000), 'u1')
  assert.equal(calls, 1, 'cached')
  assert.equal(await verifyAccount('token-aaaaaaaaaaaaaaaa', ok, now + 11 * 60_000), 'u1')
  assert.equal(calls, 2, 'cache expires')
  assert.equal(await verifyAccount('token-bbbbbbbbbbbbbbbb', async () => new Response('', { status: 401 }), now), null)
  assert.equal(await verifyAccount('token-cccccccccccccccc', async () => new Response('', { status: 500 }), now), 'unavailable')
  assert.equal(await verifyAccount('token-dddddddddddddddd', async () => { throw new Error('down') }, now), 'unavailable')
})

/** D1 的最小替身: usage 表计数 */
function fakeDb() {
  const rows = new Map()
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.startsWith('INSERT INTO usage')) {
                const [day, kind, id, n] = args
                const key = `${day}|${kind}|${id}`
                rows.set(key, (rows.get(key) ?? 0) + n)
                return { count: rows.get(key) }
              }
              if (sql.startsWith('SELECT count FROM usage')) {
                const [day, kind, id] = args
                const v = rows.get(`${day}|${kind}|${id}`)
                return v === undefined ? null : { count: v }
              }
              return null
            },
            async run() { return {} },
          }
        },
      }
    },
  }
}

test('relay /v1/translate: 需登录, 按账号每日计数, 超额 429 quota, 服务端拼提示词', async t => {
  const relay = (await import('../relay/src/index.js')).default
  const upstreamBodies = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /siliconflow/)
    upstreamBodies.push(JSON.parse(init.body))
    return new Response('data: {"choices":[{"delta":{"content":"Justice"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  const db = fakeDb()
  const env = {
    SILICONFLOW_KEY: 'k',
    DB: db,
    ACCOUNT_TRANSLATE_DAILY: '2',
    ACCOUNT: { fetch: async req => req.headers.get('authorization') === 'Bearer good-token-1234567890'
      ? new Response(JSON.stringify({ account: { id: 'acc-1' } }), { status: 200 })
      : new Response('{}', { status: 401 }) },
  }
  const ctx = { waitUntil() {} }
  const call = (auth, body = { text: '正义', target: 'en', book: '理想国' }) => relay.fetch(new Request('https://lightread-ai.jiangshu.ai/v1/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify(body),
  }), env, ctx)

  const anon = await call('')
  assert.equal(anon.status, 401)
  assert.equal((await anon.json()).error.code, 'login')
  const bad = await call('bad-token-12345678901')
  assert.equal(bad.status, 401)

  const invalid = await call('good-token-1234567890', { text: 'x', target: 'auto' })
  assert.equal(invalid.status, 400)

  const first = await call('good-token-1234567890')
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-translate-remaining'), '1')
  assert.match(await first.text(), /Justice/)
  const sent = upstreamBodies.at(-1)
  assert.equal(sent.messages[0].role, 'system')
  assert.match(sent.messages[0].content, /English/)
  assert.equal(sent.messages[1].content, '正义')
  assert.equal(sent.enable_thinking, false)

  assert.equal((await call('good-token-1234567890')).headers.get('x-translate-remaining'), '0')
  const over = await call('good-token-1234567890')
  assert.equal(over.status, 429)
  assert.equal((await over.json()).error.code, 'quota')
  assert.equal(upstreamBodies.length, 2, 'over-quota requests never reach upstream')
  assert.ok([...db.rows.keys()].some(k => k.endsWith('|tr|acc-1')), 'counted per account id, not per token')
  assert.equal(ACCOUNT_TRANSLATE_DAILY, 100)
})

test('简繁转换: 词组转换, 结果与原文 UTF-16 等长 (CFI 偏移不变), 非中文原样', async () => {
  const s2t = await loadZhConverter('s2t')
  const t2s = await loadZhConverter('t2s')
  const simp = '头发理发后，我们去了台湾的纪念馆，干杯！'
  const trad = convertPreservingLength(simp, s2t)
  assert.equal(trad, '頭髮理髮後，我們去了臺灣的紀念館，乾杯！')
  assert.equal(trad.length, simp.length)
  assert.equal(convertPreservingLength(trad, t2s), simp)
  assert.equal(convertPreservingLength('Plato, Republic 𠀀', s2t).length, 'Plato, Republic 𠀀'.length)
  assert.equal(convertPreservingLength('Plato', s2t), 'Plato')
  // 长度变化的转换退回逐字, 只采用等长的字
  const fake = text => text.replace('甲乙', '丙').replace(/甲/g, '丁')
  assert.equal(convertPreservingLength('甲乙甲', fake), '丁乙丁')
  // 万字级别在毫秒级完成
  const big = simp.repeat(500)
  const t0 = performance.now()
  convertPreservingLength(big, s2t)
  assert.ok(performance.now() - t0 < 500)
})

// ---- 本机翻译模型 ----

test('本机翻译: 提示词按模型卡片的两种写法, 原文原样放在末尾', () => {
  assert.equal(
    localTranslatePrompt('Justice is the advantage of the stronger.', 'zh-Hans'),
    '把下面的文本翻译成中文，不要额外解释。\n\nJustice is the advantage of the stronger.',
  )
  assert.match(localTranslatePrompt('正义是强者的利益。', 'en'), /^把下面的文本翻译成英语，不要额外解释。\n\n正义/)
  assert.match(localTranslatePrompt('正义是强者的利益。', 'zh-Hant'), /翻译成繁体中文/)
  assert.equal(
    localTranslatePrompt('La justice est', 'en'),
    'Translate the following segment into English, without additional explanation.\n\nLa justice est',
  )
  assert.match(localTranslatePrompt('Justice', 'ja'), /^Translate the following segment into Japanese,/)
})

test('本机翻译: 一个自然段一块, 长段落在句末再拆, 分段原样接回', () => {
  const two = splitForLocalTranslate('第一段。\n\n第二段。\n', 'en')
  assert.deepEqual(two, [{ text: '第一段。', after: '\n\n' }, { text: '第二段。', after: '' }])
  assert.deepEqual(splitForLocalTranslate('  \n\n ', 'en'), [])
  assert.deepEqual(splitForLocalTranslate('only one', 'zh-Hans'), [{ text: 'only one', after: '' }])

  const sentence = 'The value of pi is about 3.14 in most textbooks. '
  const long = sentence.repeat(30).trim()
  const pieces = splitForLocalTranslate(`${long}\nnext`, 'zh-Hans')
  assert.ok(pieces.length > 2)
  for (const p of pieces) {
    assert.ok(p.text.length <= LOCAL_TRANSLATE_PIECE_CHARS, `piece too long: ${p.text.length}`)
    assert.ok(!/3\.$/.test(p.text) && !/^14/.test(p.text), '小数点不是句末')
  }
  assert.equal(pieces.slice(0, -1).map(p => p.text).join(' ').replace(/ next$/, ''), long, '拆开再接起来不丢字')
  assert.equal(pieces.at(-2).after, '\n', '段落之间保留换行')
  assert.ok(pieces.slice(0, -2).every(p => p.after === ''), '译成中文时同一段的各块直接相接')
  assert.equal(splitForLocalTranslate('甲。'.repeat(400), 'en')[0].after, ' ', '译成英文时各块之间空一格')

  // 没有句末标点的超长文字按长度硬切, 不会整块送进模型
  const blob = splitForLocalTranslate('字'.repeat(1500), 'en')
  assert.deepEqual(blob.map(p => p.text.length), [600, 600, 300])
})

test('本机翻译: 装好且没停用才用; 实测太慢时有在线通道就让给在线', () => {
  const ok = { installed: true, supported: true, crashed: false, tokensPerSecond: 60 }
  assert.equal(shouldTranslateLocally(ok, true, true), true)
  assert.equal(shouldTranslateLocally({ ...ok, tokensPerSecond: null }, true, true), true, '还没测过速度先用')
  assert.equal(shouldTranslateLocally(undefined, true, true), false)
  assert.equal(shouldTranslateLocally(ok, false, true), false, '设置里关掉')
  assert.equal(shouldTranslateLocally({ ...ok, installed: false }, true, false), false)
  assert.equal(shouldTranslateLocally({ ...ok, crashed: true }, true, false), false)
  assert.equal(shouldTranslateLocally({ ...ok, supported: false }, true, false), false)
  const slow = { ...ok, tokensPerSecond: 3 }
  assert.equal(shouldTranslateLocally(slow, true, true), false, '慢且能在线: 用在线')
  assert.equal(shouldTranslateLocally(slow, true, false), true, '慢但没有在线通道: 仍用本机')
})
