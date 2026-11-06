// PDF 引擎崩溃自愈 (需 vite dev; E2E_BASE 指定地址):
// 实例损坏后小文件也能打开 / 已打开文档退化不抛错 / MuPDF 崩溃回退 PDFium / 诊断包含崩溃记录
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const BASE = process.env.E2E_BASE ?? 'http://localhost:5173'
const TMP = '/tmp/lightread-e2e-pdf-crash'
mkdirSync(TMP, { recursive: true })
const pdf = (rotate = 0) => `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >> endobj
4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 500] /CropBox [10 10 210 410] /Rotate ${rotate} /Contents 5 0 R /Resources << /Font << /F1 6 0 R >> >> >> endobj
5 0 obj << /Length 44 >> stream
BT /F1 24 Tf 20 100 Td (Hello crash) Tj ET
endstream endobj
6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 7 >>
%%EOF`
const fixture = join(TMP, 'crash-fixture.pdf')
writeFileSync(fixture, pdf(90))

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(e.message))
await page.goto(BASE)
await page.waitForSelector('input[type=file][multiple]', { state: 'attached', timeout: 60000 })

const result = await page.evaluate(async source => {
  const { PdfiumDoc } = await import('/src/services/pdfium.ts')
  const bytes = () => new TextEncoder().encode(source).buffer
  const out = {}
  const d1 = await PdfiumDoc.open(bytes())
  out.sizes = d1.pages
  // 与逐页加载的尺寸一致 (含 CropBox 与旋转)
  out.loadedSizes = d1.pages.map((_, i) => {
    const pg = d1.m.FPDF_LoadPage(d1.doc, i)
    const size = { w: d1.m.FPDF_GetPageWidthF(pg), h: d1.m.FPDF_GetPageHeightF(pg) }
    d1.m.FPDF_ClosePage(pg)
    return size
  })
  out.textBefore = d1.pagePlainText(0).trim()
  // 注入 wasm trap: 真实写坏内存可能跑飞拖垮渲染进程, 这里只验证崩溃后的处理
  const trap = () => { throw new WebAssembly.RuntimeError('memory access out of bounds') }
  d1.textCache.clear()
  d1.m.FPDF_LoadPage = trap
  out.textAfter = d1.text(0).count
  out.alive = d1.alive
  out.links = d1.links(0).length
  out.outline = d1.outline().length
  try {
    d1.renderToSize(0, 100, 100)
    out.render = 'no throw'
  } catch (e) {
    out.render = e.name
  }
  d1.close()
  const d2 = await PdfiumDoc.open(bytes())
  out.reopenedPages = d2.pages.length
  out.reopenedText = d2.pagePlainText(0).trim()
  out.freshInstance = d2.m !== d1.m
  // 实例已悄悄损坏 (崩溃被吞掉), 下一次 open 要靠重试恢复
  const poisoned = d2.m
  d2.m.FPDF_LoadMemDocument = () => { throw new Error('Aborted(native code called abort())') }
  const d3 = await PdfiumDoc.open(bytes())
  out.retryPages = d3.pages.length
  out.retryFresh = d3.m !== poisoned
  d3.close()
  // 不是 PDF: 普通错误, 不算崩溃, 实例继续用
  const m3 = d3.m
  try {
    await PdfiumDoc.open(new TextEncoder().encode('not a pdf').buffer)
    out.bad = 'no throw'
  } catch (e) {
    out.bad = e.name
  }
  const d4 = await PdfiumDoc.open(bytes())
  out.keptInstance = d4.m === m3
  d4.close()
  const { buildDiagnosticsBundle } = await import('/src/services/diagnostics.ts')
  const { blob, fileName } = await buildDiagnosticsBundle()
  const { unzipSync, strFromU8 } = await import('/node_modules/.vite/deps/fflate.js').catch(() => import('fflate'))
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  out.fileName = fileName
  out.bundleFiles = Object.keys(files).sort()
  out.sessionHasCrash = strFromU8(files['logs/session.log']).includes('engine crashed in text page 1')
  out.sessionHasRetry = strFromU8(files['logs/session.log']).includes('open crashed attempt=1')
  return out
}, pdf(90))

assert.deepEqual(result.sizes.map(s => [Math.round(s.w), Math.round(s.h)]), result.loadedSizes.map(s => [Math.round(s.w), Math.round(s.h)]))
assert.deepEqual(result.sizes.map(s => [Math.round(s.w), Math.round(s.h)]), [[612, 792], [400, 200]])
assert.match(result.textBefore, /Hello crash/)
assert.equal(result.textAfter, 0)
assert.equal(result.alive, false)
assert.equal(result.links, 0)
assert.equal(result.outline, 0)
assert.equal(result.render, 'PdfEngineError')
assert.equal(result.reopenedPages, 2)
assert.match(result.reopenedText, /Hello crash/)
assert.equal(result.freshInstance, true)
assert.equal(result.retryPages, 2)
assert.equal(result.retryFresh, true)
assert.equal(result.bad, 'Error')
assert.equal(result.keptInstance, true)
assert.match(result.fileName, /^lightread-diagnostics-.+\.zip$/)
assert.deepEqual(result.bundleFiles, ['logs/session.log', 'system.json'])
assert.equal(result.sessionHasCrash, true)
assert.equal(result.sessionHasRetry, true)
console.log('ok  引擎: 崩溃后退化 + 新实例恢复 + 静默损坏重试 + 普通错误不换实例 + 诊断包')

// MuPDF 崩溃时阅读器要回退 PDFium, 释放时再次 trap 也不能变成错误页
await page.evaluate(async () => {
  const mupdf = await (await import('/src/services/mupdf.ts')).initMupdf()
  const boom = () => { throw new WebAssembly.RuntimeError('memory access out of bounds') }
  mupdf.Pixmap.prototype.clear = boom
  mupdf.Pixmap.prototype.destroy = boom
})
await page.setInputFiles('input[type=file][multiple]', fixture)
await page.locator('.book-card').filter({ hasText: 'crash-fixture' }).first().click({ timeout: 30000 })
await page.waitForFunction(() => document.querySelector('canvas')?.dataset.renderer, null, { timeout: 30000 })
const renderer = await page.evaluate(() => document.querySelector('canvas').dataset.renderer)
assert.equal(renderer, 'pdfium')
assert.equal(await page.locator('.paper-state').count(), 0)
console.log('ok  阅读器: MuPDF 崩溃回退 PDFium, 没有错误页')

// 真打不开时: 报错页不露原始错误, 能导出日志, 能直达读者群
await page.evaluate(async () => {
  const { PdfiumDoc } = await import('/src/services/pdfium.ts')
  PdfiumDoc.load = () => { throw new WebAssembly.RuntimeError('memory access out of bounds') }
})
await page.goBack()
await page.locator('.book-card').filter({ hasText: 'crash-fixture' }).first().click({ timeout: 30000 })
await page.waitForSelector('.paper-state p', { timeout: 30000 })
assert.match(await page.locator('.paper-state p').innerText(), /PDF 引擎崩溃/)
assert.ok(!(await page.locator('.paper-state').innerText()).includes('out of bounds'))
assert.equal(await page.getByRole('button', { name: '导出诊断日志' }).count(), 1)
await page.getByRole('button', { name: '加读者群反馈' }).click()
await page.waitForSelector('#about-community-title', { timeout: 15000 })
// 反馈入口与群二维码 / 作者微信在同一模块, 并已定位到视口内
const community = page.locator('section[aria-labelledby="about-community-title"]')
await community.getByRole('button', { name: '复制微信号' }).waitFor({ timeout: 20000 })
assert.equal(await community.getByRole('button', { name: '导出诊断日志' }).count(), 1)
assert.equal(await community.getByText('也可以到 GitHub 反馈').count(), 1)
await page.waitForTimeout(300)
assert.ok(await page.locator('#about-community-title').evaluate(el => {
  const r = el.getBoundingClientRect()
  return r.top >= 0 && r.top < innerHeight
}), '读者群标题不在视口内')
console.log('ok  报错页: 友好文案 + 导出 + 直达读者群')
assert.ok(!pageErrors.some(e => /out of bounds|Aborted/.test(e)), pageErrors.join('\n'))
await browser.close()
console.log('e2e-pdf-crash passed')
