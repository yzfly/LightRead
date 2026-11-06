// 诊断日志纯函数与 wasm 崩溃判定。运行: npm run test:diagnostics
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RingBuffer, bundleName, feedbackUrl, formatLine, makeLine, redact } from '../src/services/diagnosticsCore.ts'
import { isWasmCrash } from '../src/services/wasmCrash.ts'

test('redact removes secrets, identity and book file names', () => {
  const cases = [
    ['Authorization: Bearer abcdefghijkl123', 'abcdefghijkl123'],
    ['{"apiKey":"topsecretvalue"}', 'topsecretvalue'],
    ['x-api-key=doubao-key-1234', 'doubao-key-1234'],
    ['key sk-abcDEF123456789', 'sk-abcDEF123456789'],
    ['GET https://sync.example.com/v1?token=abc123&x=1', 'abc123'],
    ['webdav://alice:hunter22@dav.example.com/x', 'hunter22'],
    ['mail me at reader@example.com please', 'reader@example.com'],
    ['C:\\Users\\张三\\AppData\\Roaming\\x', '张三'],
    ['/home/alice/.config/x', 'alice'],
    ['/Users/alice/Library/x', 'alice'],
    ['open C:\\data\\books\\abc-123\\我的秘密日记.pdf', '我的秘密日记'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghij', 'eyJhbGci'],
  ]
  for (const [input, secret] of cases) assert.ok(!redact(input).includes(secret), `${input} -> ${redact(input)}`)
})

test('redact keeps what diagnosis needs', () => {
  const crash = 'RuntimeError: Aborted(native code called abort()) at http://tauri.localhost/assets/pdfium-a1b2.js:2:822'
  assert.equal(redact(crash), crash)
  assert.equal(redact('open crashed size=75000KB heap=512MB'), 'open crashed size=75000KB heap=512MB')
  assert.match(redact('GET https://api.minimax.cn/v1/t2a_v2?GroupId=1'), /api\.minimax\.cn\/v1\/t2a_v2/)
})

test('makeLine redacts, keeps Error type and stack, and caps length', () => {
  const e = new Error('failed for reader@example.com')
  const line = makeLine('error', 'pdf', ['open', e], new Date('2026-11-06T00:00:00Z'))
  assert.match(line.message, /^open Error: failed for <email>/)
  assert.match(line.message, /test-diagnostics/)
  assert.ok(makeLine('info', 'x', ['a'.repeat(9000)]).message.length < 4100)
  assert.equal(formatLine({ at: 'T', level: 'warn', area: 'x', message: 'm' }), 'T WARN  [x] m')
  const circular = {}
  circular.self = circular
  assert.ok(makeLine('info', 'x', [circular]).message.length > 0)
})

test('ring buffer keeps the newest entries', () => {
  const ring = new RingBuffer(2)
  for (const v of [1, 2, 3]) ring.push(v)
  assert.deepEqual(ring.toArray(), [2, 3])
})

test('feedback link carries version only and bundle name is stable', () => {
  const url = new URL(feedbackUrl({ version: '2.7.1', platform: 'Windows App', userAgent: 'secret-ua', webview: '156' }))
  assert.equal(url.pathname, '/yzfly/LightRead/issues/new')
  assert.equal(url.searchParams.get('template'), 'bug-report.yml')
  assert.equal(url.searchParams.get('version'), '2.7.1 · Windows App · WebView 156')
  assert.ok(!url.href.includes('secret-ua'))
  assert.equal(bundleName('2.7.1', new Date('2026-11-06T01:02:03Z')), 'lightread-diagnostics-2.7.1-20261106-010203.zip')
})

test('isWasmCrash recognizes engine crashes only', () => {
  assert.ok(isWasmCrash(new WebAssembly.RuntimeError('memory access out of bounds')))
  assert.ok(isWasmCrash(new Error('Aborted(native code called abort())')))
  assert.ok(isWasmCrash(new Error('memory access out of bounds')))
  assert.ok(!isWasmCrash(new Error('PDFium load failed (3)')))
  assert.ok(!isWasmCrash(new RangeError('offset is out of bounds')))
  assert.ok(!isWasmCrash(null))
})
