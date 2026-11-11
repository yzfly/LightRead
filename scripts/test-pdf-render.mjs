// PDF 页面渲染 (Worker): 栅格化尺寸与底色 (真实 MuPDF) / 排队与插队 / 作废 / 失败后整体回退 / 关闭 / 位图内存预算.
// 运行: npm run test:pdf-render
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as mupdfNs from 'mupdf'
import { rasterPage } from '../src/services/pdfRender/raster.ts'
import { PdfRenderClient, PdfRenderDropped } from '../src/services/pdfRender/client.ts'
import { PAGE_BITMAP_BUDGET, pageWindow } from '../src/services/pdfRender/budget.ts'

const mupdf = mupdfNs.default ?? mupdfNs

function samplePdf() {
  const doc = new mupdf.PDFDocument()
  const page = doc.addPage([0, 0, 200, 300], 0, {}, 'q 1 0 0 rg 20 20 100 100 re f Q')
  doc.insertPage(-1, page)
  const bytes = doc.saveToBuffer('').asUint8Array().slice()
  doc.destroy()
  return bytes
}

test('rasterPage: exact target size, opaque white background, content drawn', () => {
  const doc = mupdf.Document.openDocument(samplePdf(), 'application/pdf')
  const view = rasterPage(mupdf, doc, { page: 0, targetW: 400, targetH: 600, pageW: 200, pageH: 300 })
  try {
    assert.equal(view.width, 400)
    assert.equal(view.height, 600)
    assert.equal(view.pixels.length, 400 * 600 * 4)
    // 左上角是白底、不透明
    assert.deepEqual([...view.pixels.slice(0, 4)], [255, 255, 255, 255])
    // PDF 原点在左下: 红块 (20..120, 20..120 pt) 落在位图下半部
    const at = (x, y) => [...view.pixels.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 4)]
    assert.deepEqual(at(140, 600 - 140), [255, 0, 0, 255])
  } finally {
    view.release()
    doc.destroy()
  }
})

test('rasterPage: a bad page index throws and leaves the document usable', () => {
  const doc = mupdf.Document.openDocument(samplePdf(), 'application/pdf')
  assert.throws(() => rasterPage(mupdf, doc, { page: 9, targetW: 10, targetH: 10, pageW: 200, pageH: 300 }))
  const view = rasterPage(mupdf, doc, { page: 0, targetW: 20, targetH: 30, pageW: 200, pageH: 300 })
  assert.equal(view.width, 20)
  view.release()
  doc.destroy()
})

/** 假 Worker: 记录收到的消息, 由测试决定何时回复 */
class FakeWorker {
  sent = []
  terminated = false
  postMessage(msg) { this.sent.push(msg) }
  terminate() { this.terminated = true }
  reply(msg) { this.onmessage?.({ data: msg }) }
  renders() { return this.sent.filter(m => m.type === 'render') }
}
globalThis.Worker ??= FakeWorker
const req = page => ({ page, targetW: 10, targetH: 10, pageW: 10, pageH: 10 })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function start() {
  const worker = new FakeWorker()
  const client = PdfRenderClient.create(new ArrayBuffer(8), () => worker)
  return { worker, client }
}

test('client: one render at a time, priority jumps the queue, results map to callers', async () => {
  const { worker, client } = start()
  assert.equal(worker.sent[0].type, 'load')
  const a = client.render(req(1))
  const b = client.render(req(2))
  const c = client.render(req(3), { priority: true })
  await tick()
  assert.equal(worker.renders().length, 0, 'nothing is rendered before load finishes')
  worker.reply({ id: worker.sent[0].id, type: 'ok' })
  await tick()
  // 页 3 带 priority, 插到页 1 / 2 前面
  assert.deepEqual(worker.renders().map(m => m.req.page), [3])
  worker.reply({ id: worker.renders()[0].id, type: 'ok', width: 3, height: 3, pixels: new ArrayBuffer(36) })
  assert.equal((await c).width, 3)
  await tick()
  assert.deepEqual(worker.renders().map(m => m.req.page), [3, 1])
  worker.reply({ id: worker.renders()[1].id, type: 'ok', width: 1, height: 1, pixels: new ArrayBuffer(4) })
  assert.equal((await a).width, 1)
  await tick()
  worker.reply({ id: worker.renders()[2].id, type: 'ok', width: 2, height: 2, pixels: new ArrayBuffer(16) })
  assert.equal((await b).width, 2)
})

test('client: drop() rejects queued requests but not the one being rendered', async () => {
  const { worker, client } = start()
  worker.reply({ id: worker.sent[0].id, type: 'ok' })
  const a = client.render(req(1))
  await tick()
  const b = client.render(req(2))
  const c = client.render(req(3))
  client.drop(r => r.page === 2)
  await assert.rejects(b, PdfRenderDropped)
  worker.reply({ id: worker.renders()[0].id, type: 'ok', width: 1, height: 1, pixels: new ArrayBuffer(4) })
  await a
  await tick()
  assert.deepEqual(worker.renders().map(m => m.req.page), [1, 3])
  worker.reply({ id: worker.renders()[1].id, type: 'ok', width: 1, height: 1, pixels: new ArrayBuffer(4) })
  await c
})

test('client: a render error retires the worker and fails everything after it', async () => {
  const { worker, client } = start()
  worker.reply({ id: worker.sent[0].id, type: 'ok' })
  const a = client.render(req(1))
  const b = client.render(req(2))
  await tick()
  worker.reply({ id: worker.renders()[0].id, type: 'error', message: 'memory access out of bounds' })
  await assert.rejects(a, /memory access out of bounds/)
  await assert.rejects(b, /memory access out of bounds/)
  assert.equal(worker.terminated, true)
  assert.equal(client.alive, false)
  await assert.rejects(client.render(req(3)), /memory access out of bounds/)
})

test('client: load failure, worker crash event and close() all reject pending renders', async () => {
  let s = start()
  let p = s.client.render(req(1))
  s.worker.reply({ id: s.worker.sent[0].id, type: 'error', message: 'bad pdf' })
  await assert.rejects(p, /bad pdf/)

  s = start()
  p = s.client.render(req(1))
  s.worker.onerror?.({ message: 'script failed' })
  await assert.rejects(p, /script failed/)
  assert.equal(s.worker.terminated, true)

  s = start()
  s.worker.reply({ id: s.worker.sent[0].id, type: 'ok' })
  p = s.client.render(req(1))
  s.client.close()
  await assert.rejects(p, /closed/)
})

test('client: create() returns null when the worker cannot be constructed', () => {
  const bytes = new ArrayBuffer(8)
  assert.equal(PdfRenderClient.create(bytes, () => { throw new Error('blocked') }), null)
  assert.equal(bytes.byteLength, 8, 'bytes stay usable for the main-thread fallback')
})

test('pageWindow: normal zoom keeps the old ±4 pages; heavy zoom shrinks to fit the budget', () => {
  const MB = 1024 * 1024
  // A4 @100% DPR 2 ≈ 14MB: 与改动前一致
  assert.deepEqual(pageWindow(14 * MB, PAGE_BITMAP_BUDGET.desktop), { keep: 4, ahead: 2, behind: 1 })
  assert.deepEqual(pageWindow(7 * MB, PAGE_BITMAP_BUDGET.app), { keep: 4, ahead: 2, behind: 1 })
  // A4 @300% DPR 2 ≈ 124MB: 只留前后各一页, 预载也只到下一页
  assert.deepEqual(pageWindow(124 * MB, PAGE_BITMAP_BUDGET.desktop), { keep: 1, ahead: 1, behind: 1 })
  // 再大也保留相邻页, 不能翻一页白一页
  assert.deepEqual(pageWindow(900 * MB, PAGE_BITMAP_BUDGET.app), { keep: 1, ahead: 1, behind: 1 })
  for (const bytes of [1, 14 * MB, 60 * MB, 124 * MB]) {
    const w = pageWindow(bytes, PAGE_BITMAP_BUDGET.desktop)
    if (w.keep > 1) assert.ok((2 * w.keep + 1) * bytes <= PAGE_BITMAP_BUDGET.desktop, `${bytes} within budget`)
  }
})

test('pageWindow: spreads keep whole groups and never evict what prefetch just rendered', () => {
  const MB = 1024 * 1024
  const normal = pageWindow(14 * MB, PAGE_BITMAP_BUDGET.desktop, 2)
  assert.deepEqual(normal, { keep: 5, ahead: 2, behind: 1 })
  // 预载到后面第 ahead 组的最后一页 = 当前页 + ahead*2 + 1, 必须在保留范围内
  assert.ok(normal.ahead * 2 + 1 <= normal.keep)
  const zoomed = pageWindow(124 * MB, PAGE_BITMAP_BUDGET.desktop, 2)
  assert.deepEqual(zoomed, { keep: 3, ahead: 1, behind: 1 })
  assert.ok(zoomed.ahead * 2 + 1 <= zoomed.keep)
})
