// 本机对话模型 (Qwen3.5): 用哪个模型 / 消息裁进上下文 / 去思考块 (src/services/localChatCore.ts)
import test from 'node:test'
import assert from 'node:assert/strict'
import { chatCharBudget, chatModels, fitChatMessages, pickChatModel, stripThink } from '../src/services/localChatCore.ts'

const m = (id, size, extra = {}) => ({ id, kind: 'chat', size, installed: false, supported: true, crashed: false, recommended: false, speed: null, ...extra })

test('chat models are listed small to large, other kinds left out', () => {
  const list = chatModels([m('b', 2), { ...m('t', 1), kind: 'translate' }, m('a', 1)])
  assert.deepEqual(list.map(x => x.id), ['a', 'b'])
})

test('the model in use: the chosen one if downloaded, else the recommended, else the smallest downloaded', () => {
  const small = m('s', 1, { installed: true })
  const mid = m('m', 2, { installed: true, recommended: true })
  const big = m('l', 3)
  assert.equal(pickChatModel([small, mid, big], 's').id, 's')
  assert.equal(pickChatModel([small, mid, big], 'l').id, 'm', '选的还没下载: 用推荐的')
  assert.equal(pickChatModel([small, { ...mid, crashed: true }, big], 'm').id, 's', '闪退停用的不用')
  assert.equal(pickChatModel([m('s', 1), big], ''), undefined)
})

test('messages are fitted: system and the current question stay, history kept newest first', () => {
  const sys = { role: 'system', content: '系'.repeat(100) }
  const turns = []
  for (let i = 0; i < 6; i++) turns.push({ role: 'user', content: `问${i}` + '问'.repeat(98) }, { role: 'assistant', content: `答${i}` + '答'.repeat(98) })
  const last = { role: 'user', content: '最后的问题' }
  const out = fitChatMessages([sys, ...turns, last], 600)
  assert.equal(out[0].role, 'system')
  assert.deepEqual(out.at(-1), last)
  assert.equal(out[1].role, 'user', '历史从用户的话开始')
  assert.ok(out[1].content.startsWith('问4') || out[1].content.startsWith('问5'), out[1].content.slice(0, 3))
  assert.ok(out.reduce((n, x) => n + x.content.length, 0) <= 600)
  // 一条很长的问题: 留头留尾
  const long = fitChatMessages([{ role: 'user', content: '头' + '长'.repeat(5000) + '尾' }], 1000)
  assert.equal(long.length, 1)
  assert.ok(long[0].content.length <= 1003 && long[0].content.startsWith('头') && long[0].content.endsWith('尾'))
  assert.deepEqual(fitChatMessages([{ role: 'user', content: '  ' }], 100), [])
})

test('budget leaves room for the answer; think blocks are removed', () => {
  assert.ok(chatCharBudget(4096, 768) < 4096 - 768)
  assert.equal(chatCharBudget(512, 768), 600)
  assert.equal(stripThink('<think>\n\n</think>\n\n答案'), '答案')
  assert.equal(stripThink('\n</think>\n\n答案'), '答案')
  assert.equal(stripThink('没有思考块'), '没有思考块')
})
