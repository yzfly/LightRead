// 应用内反馈的纯函数 (src/services/feedbackCore.ts): 校验 / 请求体 / 错误文案 / base64
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEEDBACK_MAX_TEXT, bytesToBase64, feedbackErrorKey, feedbackPayload, feedbackProblem,
} from '../src/services/feedbackCore.ts'
import zh from '../src/i18n/zh.ts'
import en from '../src/i18n/en.ts'
import mobileZh from '../src/mobile/i18n/zh.ts'
import mobileEn from '../src/mobile/i18n/en.ts'

// App 构建用 src/mobile/i18n 整份替换共享字典 (vite.platform.ts), 两边都要有
const DICTS = { zh, en, mobileZh, mobileEn }

test('提交前校验: 空 / 过长 / 联系方式过长', () => {
  assert.equal(feedbackProblem({ text: '   ', contact: '' }), 'feedback.errEmpty')
  assert.equal(feedbackProblem({ text: 'x'.repeat(FEEDBACK_MAX_TEXT + 1), contact: '' }), 'feedback.errTooLong')
  assert.equal(feedbackProblem({ text: '  ' + 'x'.repeat(FEEDBACK_MAX_TEXT) + '  ', contact: '' }), null)
  assert.equal(feedbackProblem({ text: 'ok', contact: 'c'.repeat(201) }), 'feedback.errContact')
  assert.equal(feedbackProblem({ text: 'ok', contact: '' }), null)
})

test('请求体: 去首尾空白; 只有勾选且有日志时才带 log', () => {
  const env = { version: '2.10.8', platform: 'android' }
  const draft = { kind: 'bug', text: '  卡住了 ', contact: ' a@b.c ', includeLogs: true }
  assert.deepEqual(feedbackPayload(draft, env, 'UEsFBg=='), {
    kind: 'bug', text: '卡住了', contact: 'a@b.c', version: '2.10.8', platform: 'android', log: 'UEsFBg==',
  })
  assert.equal('log' in feedbackPayload({ ...draft, includeLogs: false }, env, 'UEsFBg=='), false)
  assert.equal('log' in feedbackPayload(draft, env, undefined), false)
})

test('错误码 → 文案键; 桌面与 App 的中英字典都有全部反馈文案', () => {
  const keys = [0, 400, 413, 429, 500, 502].map(feedbackErrorKey)
  assert.deepEqual(keys, [
    'feedback.errOffline', 'feedback.errInvalid', 'feedback.errLogTooLarge', 'feedback.errRateLimited',
    'feedback.errServer', 'feedback.errServer',
  ])
  const used = [...keys, 'feedback.errEmpty', 'feedback.errTooLong', 'feedback.errContact']
  for (const dict of Object.values(DICTS)) for (const k of used) assert.ok(dict[k], k)
  for (const kind of ['bug', 'feature', 'other']) {
    for (const dict of Object.values(DICTS)) {
      assert.ok(dict[`feedback.kind.${kind}`])
      assert.ok(dict[`feedback.placeholder.${kind}`])
    }
  }
  const sharedKeys = Object.keys(zh).filter(k => k.startsWith('feedback.'))
  for (const [name, dict] of Object.entries(DICTS)) {
    assert.deepEqual(Object.keys(dict).filter(k => k.startsWith('feedback.')).sort(), sharedKeys.sort(), name)
  }
})

test('base64: 与 Buffer 一致, 大数组分块不爆栈', () => {
  const small = new Uint8Array([0x50, 0x4b, 5, 6, 255, 0])
  assert.equal(bytesToBase64(small), Buffer.from(small).toString('base64'))
  const big = new Uint8Array(300_000).map((_, i) => (i * 31) & 255)
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'))
})
