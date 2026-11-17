/**
 * 轻点分区 (src/services/readerTapZone.ts): 横屏左·中·右 · 竖屏上·中·下 · 自动阅读时无翻页区 ·
 * 单手翻页 (整屏下一页) 与双击识别。
 *
 *   npm run test:reader-tap-zone
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { tapZone, createDoubleTap, DOUBLE_TAP_MS } from '../src/services/readerTapZone.ts'

const land = { width: 1200, height: 800, portrait: false, autoReading: false }
const port = { width: 390, height: 840, portrait: true, autoReading: false }

test('landscape: left / middle / right thirds', () => {
  assert.equal(tapZone({ ...land, x: 100, y: 400 }), 'prev')
  assert.equal(tapZone({ ...land, x: 600, y: 400 }), 'menu')
  assert.equal(tapZone({ ...land, x: 1100, y: 400 }), 'next')
  // 横屏时上下位置不影响
  assert.equal(tapZone({ ...land, x: 600, y: 10 }), 'menu')
})

test('portrait: top / middle / bottom thirds, sides do not turn pages', () => {
  assert.equal(tapZone({ ...port, x: 195, y: 100 }), 'prev')
  assert.equal(tapZone({ ...port, x: 195, y: 420 }), 'menu')
  assert.equal(tapZone({ ...port, x: 195, y: 800 }), 'next')
  assert.equal(tapZone({ ...port, x: 5, y: 420 }), 'menu')
  assert.equal(tapZone({ ...port, x: 385, y: 420 }), 'menu')
})

test('auto reading: no page-turn zones anywhere', () => {
  for (const base of [land, port]) {
    for (const [x, y] of [[0, 0], [base.width - 1, base.height - 1], [base.width / 2, base.height / 2]]) {
      assert.equal(tapZone({ ...base, autoReading: true, x, y }), 'menu')
    }
  }
})

test('zero-size area falls back to menu', () => {
  assert.equal(tapZone({ ...port, height: 0, x: 0, y: 0 }), 'menu')
})

test('one-handed: every tap is next page, auto reading still pauses', () => {
  for (const base of [land, port]) {
    for (const [x, y] of [[0, 0], [base.width / 2, base.height / 2], [base.width - 1, base.height - 1]]) {
      assert.equal(tapZone({ ...base, oneHand: true, x, y }), 'next')
      assert.equal(tapZone({ ...base, oneHand: true, autoReading: true, x, y }), 'menu')
    }
  }
})

/** 假定时器: run() 依次触发到期的回调 */
function fakeTimers() {
  let seq = 0
  const live = new Map()
  return {
    set: (fn) => { live.set(++seq, fn); return seq },
    clear: (id) => { live.delete(id) },
    run: () => { const fns = [...live.values()]; live.clear(); fns.forEach(fn => fn()) },
    get size() { return live.size },
  }
}

test('double tap: single waits, close second tap is a double only', () => {
  const timers = fakeTimers()
  const gate = createDoubleTap(timers)
  const log = []
  const tap = (x, y, at) => gate.tap(x, y, at, () => log.push(`single@${at}`), () => log.push(`double@${at}`))

  tap(100, 100, 0)
  assert.deepEqual(log, [], 'single waits for a possible second tap')
  assert.equal(gate.pending, true)
  timers.run()
  assert.deepEqual(log, ['single@0'])

  tap(100, 100, 1000)
  tap(110, 95, 1000 + DOUBLE_TAP_MS - 10)
  timers.run()
  assert.deepEqual(log, ['single@0', `double@${1000 + DOUBLE_TAP_MS - 10}`], 'no single after a double')
  assert.equal(gate.pending, false)
})

test('double tap: far or late second tap counts as two singles; cancel drops the wait', () => {
  const timers = fakeTimers()
  const gate = createDoubleTap(timers)
  const log = []
  const tap = (x, y, at) => gate.tap(x, y, at, () => log.push(`single@${at}`), () => log.push(`double@${at}`))

  tap(50, 50, 0)
  tap(300, 600, 100)
  assert.deepEqual(log, ['single@0'], 'far second tap flushes the first one at once')
  timers.run()
  assert.deepEqual(log, ['single@0', 'single@100'])

  tap(50, 50, 2000)
  tap(50, 50, 2000 + DOUBLE_TAP_MS + 50)
  assert.deepEqual(log.slice(2), ['single@2000'], 'too late to be a double')
  gate.cancel()
  timers.run()
  assert.deepEqual(log.slice(2), ['single@2000'], 'cancelled single never fires')
  assert.equal(timers.size, 0)
})
