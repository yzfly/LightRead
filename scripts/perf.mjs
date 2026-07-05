/**
 * 性能基准: 打开耗时 / 翻页延迟 / 长任务统计
 * 运行: npm run build && npm run preview -- --port 4173 & node scripts/perf.mjs
 */
import { chromium, webkit } from 'playwright'
const engine = process.env.ENGINE === 'webkit' ? webkit : chromium

const BIG_TXT = process.env.BIG_TXT ?? '/tmp/大部头.txt'
const PDF = process.env.PDF_FIXTURE ?? '/tmp/fixture.pdf'

const browser = await engine.launch()
console.log('引擎:', process.env.ENGINE ?? 'chromium')
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })

// 长任务观察器 (>50ms 的主线程阻塞)
await page.addInitScript(() => {
  window.__frames = []
  let last = performance.now()
  const tick = now => {
    window.__frames.push(now - last)
    last = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})

// 掉帧统计: >33ms 视为掉帧, >100ms 视为严重卡顿
const longtasks = async () => page.evaluate(() => {
  const list = window.__frames
  window.__frames = []
  const dropped = list.filter(d => d > 33)
  return {
    frames: list.length,
    dropped: dropped.length,
    severe: dropped.filter(d => d > 100).length,
    worst: Math.round(Math.max(0, ...list)),
  }
})

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })

// 1. 大书导入耗时
let t0 = Date.now()
await page.setInputFiles('input[type=file][multiple]', BIG_TXT)
await page.waitForSelector('.book-card', { timeout: 60000 })
console.log(`大书(2.5MB/200章) 导入: ${Date.now() - t0}ms`)

// 2. 打开大书耗时
await longtasks()
t0 = Date.now()
await page.click('.book-card')
await page.waitForFunction(() => {
  const v = document.querySelector('foliate-view')
  return !!v?.renderer?.getContents?.()?.[0]?.doc?.body
}, null, { timeout: 60000 })
console.log(`打开大书 (点击→正文可见): ${Date.now() - t0}ms`, '长任务:', JSON.stringify(await longtasks()))

// 3. 连续翻页 20 次
await page.waitForTimeout(1000)
await longtasks()
t0 = Date.now()
for (let i = 0; i < 20; i++) {
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(80)
}
await page.waitForTimeout(500)
console.log(`20 次翻页: 总 ${Date.now() - t0 - 2100}ms (净耗时)`, '长任务:', JSON.stringify(await longtasks()))

// 4. 排版调整 (字号连续变化 8 档, 模拟拖动滑条)
await page.click('button[title="排版设置"]')
await longtasks()
t0 = Date.now()
for (let size = 15; size <= 22; size++) {
  await page.locator('.set-row input[type=range]').first().evaluate((el, v) => {
    el.value = String(v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, size)
  await page.waitForTimeout(60)
}
await page.waitForTimeout(800)
console.log(`字号拖动 8 档: ${Date.now() - t0 - 1280}ms (净)`, '长任务:', JSON.stringify(await longtasks()))
await page.keyboard.press('Escape')

// 5. PDF 打开 + 翻页
await page.goto('http://localhost:4173/#/library', { waitUntil: 'load' })
await page.waitForTimeout(500)
await page.setInputFiles('input[type=file][multiple]', PDF)
await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 30000 })
await longtasks()
t0 = Date.now()
await page.click('.book-card:not(:has-text("大部头"))')
await page.waitForSelector('.spread-host canvas', { timeout: 30000 })
console.log(`打开 PDF (点击→首页渲染): ${Date.now() - t0}ms`, '长任务:', JSON.stringify(await longtasks()))

await page.waitForTimeout(1200)
await longtasks()
// 已预载的翻页 (慢速, 命中缓存)
t0 = Date.now()
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
}
console.log(`PDF 慢速翻 6 页 (应命中预载): 净 ${Date.now() - t0 - 2400}ms`, '长任务:', JSON.stringify(await longtasks()))
// 快速连翻 (缓存跟不上)
t0 = Date.now()
for (let i = 0; i < 10; i++) {
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(60)
}
await page.waitForTimeout(800)
console.log(`PDF 快速连翻 10 页: 净 ${Date.now() - t0 - 1400}ms`, '长任务:', JSON.stringify(await longtasks()))

await browser.close()
