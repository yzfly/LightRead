// 桌面正文划词: 左键按住拖选、中途停住时不弹划线工具条, 松开后才弹 (2026-11-15 用户要求)。
//   E2E_BASE=http://localhost:<端口> node scripts/e2e-desktop-select.mjs   (先起 vite dev, 桌面界面)
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE || 'http://localhost:4173'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1180, height: 780 }, locale: 'zh-CN', serviceWorkers: 'block' })
await ctx.addInitScript(() => {
  localStorage.setItem('lightread-language', 'zh')
  if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({ version: 14, language: 'zh' }))
})
const p = await ctx.newPage()
p.setDefaultTimeout(15000)
const errors = []
p.on('pageerror', e => errors.push(e.message))
try {
  await p.goto(base + '/#/library')
  const para = Array.from({ length: 20 }, (_, i) => `第${i + 1}段：这是一段用来验证鼠标划词的文字，按住左键拖动选择时不应该提前弹出工具条。`).join('\n\n')
  await p.setInputFiles('input[type=file][multiple]', { name: '划词验收.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 划词\n\n' + para) })
  await p.locator('.book-card').filter({ hasText: '划词验收' }).click()
  await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length)
  await p.waitForTimeout(800)
  // 无头浏览器里真实拖选选不中分页正文里的字 (改动前同样), 这里用事件模拟一次划选:
  // 左键按下 → 选区随拖动变化 (selectionchange) → 停住不松手 → 松开
  const inDoc = fn => p.evaluate(fn)
  await inDoc(() => {
    const { doc } = document.querySelector('foliate-view').renderer.getContents()[0]
    const el = [...doc.querySelectorAll('p')].find(e => e.textContent.includes('第2段'))
    doc.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }))
    const r = doc.createRange()
    r.setStart(el.firstChild, 0)
    r.setEnd(el.firstChild, 12)
    const sel = doc.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  })
  // 停住不松手, 超过选区稳定的 300ms 判定
  await p.waitForTimeout(900)
  const selected = await inDoc(() => document.querySelector('foliate-view').renderer.getContents()[0].doc.getSelection().toString())
  assert.ok(selected.length > 3, `text is selected: "${selected}"`)
  assert.equal(await p.locator('.highlight-bar').count(), 0, 'no toolbar while the button is held')
  await inDoc(() => document.querySelector('foliate-view').renderer.getContents()[0].doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })))
  await p.locator('.highlight-bar').waitFor()
  // 触屏 / 键盘选字 (没有按着左键): 选区稳定后照样自己弹出
  await p.locator('.highlight-bar .icon-btn').last().click()
  await p.locator('.highlight-bar').waitFor({ state: 'detached' })
  await inDoc(() => {
    const { doc } = document.querySelector('foliate-view').renderer.getContents()[0]
    const el = [...doc.querySelectorAll('p')].find(e => e.textContent.includes('第3段'))
    const r = doc.createRange()
    r.setStart(el.firstChild, 0)
    r.setEnd(el.firstChild, 10)
    doc.getSelection().removeAllRanges()
    doc.getSelection().addRange(r)
  })
  await p.locator('.highlight-bar').waitFor()
  console.log('PASS toolbar waits for mouseup; selected:', selected.slice(0, 20))
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}
