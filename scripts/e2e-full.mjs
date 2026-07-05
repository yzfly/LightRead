/**
 * LightRead 全功能回归测试
 * 前置: npm run build && npm run preview -- --port 4173
 * 运行: node scripts/e2e-full.mjs
 */
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TMP = join(tmpdir(), 'lightread-e2e')
mkdirSync(join(TMP, 'shots'), { recursive: true })

// ---- 测试文件 ----
const txtPath = join(TMP, '测试小说.txt')
{
  const chapters = []
  for (let i = 1; i <= 5; i++) {
    chapters.push(`第${['一', '二', '三', '四', '五'][i - 1]}章 风起于青萍之末\n\n`
      + '夜色像一块浸了水的墨布，慢慢压下来。他把灯芯挑亮了一点，书页上的字便站得直了些。\n'.repeat(40))
  }
  writeFileSync(txtPath, chapters.join('\n\n'), 'utf-8')
}
const pdfPath = process.env.PDF_FIXTURE ?? join(TMP, 'fixture.pdf')

let pass = 0
let fail = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', e => errors.push(e.message))

// 打桩语音引擎 (headless 无音频后端)
await page.addInitScript(() => {
  const fakeVoice = { name: '婷婷 (测试)', lang: 'zh-CN', default: true, localService: true, voiceURI: 'test' }
  let current = null
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      getVoices: () => [fakeVoice],
      speak: u => { current = u; setTimeout(() => { current = null; u.onend?.() }, 100) },
      cancel: () => { const u = current; current = null; u?.onerror?.({ error: 'canceled' }) },
      pause: () => {}, resume: () => {}, addEventListener: () => {},
    },
    configurable: true,
  })
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t } }
})

const BASE = 'http://localhost:4173'

// ================= 藏书 =================
console.log('\n== 藏书管理 ==')
await page.goto(BASE, { waitUntil: 'networkidle' })
check('空书架提示', await page.locator('text=书架还是空的').count() === 1)
await page.setInputFiles('input[type=file][multiple]', [txtPath, pdfPath])
await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 25000 })
check('批量导入 TXT+PDF', true, '2 本')
await page.fill('.search', '测试')
await page.waitForTimeout(300)
check('搜索过滤', await page.locator('.book-card').count() === 1)
await page.fill('.search', '')
await page.waitForTimeout(300)

// ================= EPUB/TXT 阅读器 =================
console.log('\n== 文本阅读器 (foliate) ==')
await page.click('.book-card:has-text("测试小说")')
await page.waitForSelector('foliate-view', { timeout: 15000 })
await page.waitForFunction(() => {
  const v = document.querySelector('foliate-view')
  return !!v?.renderer?.getContents?.()?.[0]?.doc?.body?.textContent?.includes('夜色')
}, null, { timeout: 15000 })
check('正文渲染', true)

await page.click('button[title="目录"]')
check('目录: 章节数', await page.locator('.toc-item').count() === 5, '5 章')
await page.click('.toc-item:has-text("第三章")')
const tocOk = await page.waitForFunction(
  () => document.querySelector('.chapter')?.textContent?.includes('第三章'),
  null, { timeout: 6000 }).then(() => true).catch(() => false)
check('目录跳转', tocOk)
if (!tocOk) {
  console.log('    [诊断] chapter=', await page.textContent('.chapter').catch(() => '(无)'),
    'percent=', await page.textContent('.percent'),
    'toc面板=', await page.locator('.panel').count())
  await page.screenshot({ path: join(TMP, 'shots', 'toc-fail.png') })
}

const pctBefore = await page.textContent('.percent')
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(500)
check('键盘翻页', (await page.textContent('.percent')) !== pctBefore)

// 排版设置
await page.click('button[title="排版设置"]')
check('主题数量', await page.locator('.theme-btn').count() === 4, '白/米黄/护眼绿/夜间')
await page.click('.theme-btn:nth-child(3)')
await page.waitForTimeout(400)
const bg = await page.evaluate(() => document.querySelector('.reader')?.getAttribute('style') ?? '')
check('护眼绿主题生效', bg.includes('199, 237, 204') || bg.includes('#c7edcc'), bg.slice(0, 60))
await page.click('.seg button:has-text("滚动")')
await page.waitForTimeout(600)
check('滚动模式切换', true)
await page.click('.seg button:has-text("翻页")')
await page.waitForTimeout(600)
await page.keyboard.press('Escape')

// 高亮 + 想法
await page.evaluate(() => {
  const view = document.querySelector('foliate-view')
  const doc = view.renderer.getContents()[0].doc
  const p = doc.querySelector('p')
  const range = doc.createRange()
  range.selectNodeContents(p)
  doc.getSelection().removeAllRanges()
  doc.getSelection().addRange(range)
  doc.dispatchEvent(new Event('mouseup'))
})
await page.waitForSelector('.highlight-bar', { timeout: 5000 })
check('选区浮条出现', true)
await page.click('.highlight-bar .btn:has-text("写想法")')
await page.fill('.note-input', '测试想法')
await page.click('.btn:has-text("保存想法")')
await page.waitForTimeout(400)
await page.click('button[title="标注与书签"]')
check('划线想法入面板', (await page.locator('.anno-note').first().textContent().catch(() => ''))?.includes('测试想法'))

// 书签
await page.keyboard.press('Escape')
await page.click('[title="添加书签"]')
await page.waitForTimeout(300)
check('书签添加', await page.locator('[title="移除书签"]').count() === 1)
await page.click('button[title="标注与书签"]')
await page.click('.anno-tabs button:has-text("书签")')
check('书签入面板', await page.locator('.panel-body .anno-item').count() >= 1)
await page.keyboard.press('Escape')

// 书内搜索
await page.click('button[title="书内搜索"]')
await page.fill('.search-form input', '墨布')
await page.press('.search-form input', 'Enter')
await page.waitForSelector('.search-item', { timeout: 10000 })
check('书内搜索', await page.locator('.search-item').count() > 0)
await page.click('.btn:has-text("清除并关闭")')

// 自动阅读
await page.click('[title="自动阅读"]')
await page.locator('.auto-panel input[type=range]').fill('3')
await page.click('.auto-panel .btn')
const pctAuto = await page.textContent('.percent')
await page.waitForTimeout(3800)
check('自动阅读推进', (await page.textContent('.percent')) !== pctAuto)
await page.click('.auto-panel .icon-btn')

// 听书 (打桩)
await page.click('[title="听书"]')
const pctTts = await page.textContent('.percent')
await page.click('.tts-panel .btn-primary')
let ttsFollowed = false
for (let i = 0; i < 16 && !ttsFollowed; i++) {
  await page.waitForTimeout(500)
  ttsFollowed = (await page.textContent('.percent')) !== pctTts
}
check('听书视图跟随', ttsFollowed)
const stopBtn = page.locator('.tts-panel .btn:has-text("停止")')
if (await stopBtn.isEnabled()) await stopBtn.click()
await page.click('.tts-panel .icon-btn')

// 进度持久化
await page.click('button[title="返回藏书"]')
await page.waitForSelector('.book-card', { timeout: 8000 })
check('返回书架显示进度', await page.locator('.book-card:has-text("测试小说") .progress').count() === 1)

// ================= PDF 阅读器 =================
console.log('\n== PDF 阅读器 ==')
await page.click('.book-card:not(:has-text("测试小说"))')
await page.waitForSelector('.spread-host canvas', { timeout: 20000 })
const fit = await page.evaluate(() => {
  const box = document.querySelector('.paged-box')
  const canvas = document.querySelector('.spread-host canvas')
  return { boxH: box.clientHeight, cH: parseFloat(canvas.style.height) }
})
check('默认翻页+适高', fit.cH <= fit.boxH && fit.cH > fit.boxH * 0.8, `页高 ${Math.round(fit.cH)} / 容器 ${fit.boxH}`)
check('打开在第 1 页', await page.inputValue('.page-input') === '1')

// 双页: 首页立即生效 (bug 回归)
await page.click('.btn:has-text("双页")')
await page.waitForFunction(() => document.querySelectorAll('.spread-host canvas').length === 2, null, { timeout: 8000 })
check('双页在首页生效', true, '1-2 并列')
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(700)
check('双页翻页 1-2 → 3-4', await page.inputValue('.page-input') === '3')
await page.click('.btn:has-text("双页")')
await page.waitForFunction(() => document.querySelectorAll('.spread-host canvas').length === 1, null, { timeout: 8000 })
check('切回单页', true)

// 适宽 + 滚轮到底翻页
await page.click('.seg button:has-text("适宽")')
await page.waitForTimeout(700)
const fitW = await page.evaluate(() => {
  const box = document.querySelector('.paged-box')
  const canvas = document.querySelector('.spread-host canvas')
  return { boxW: box.clientWidth, cW: parseFloat(canvas.style.width) }
})
check('适宽生效', Math.abs(fitW.cW - (fitW.boxW - 32)) < 4, `页宽 ${Math.round(fitW.cW)} / 容器 ${fitW.boxW}`)
await page.click('.seg button:has-text("适高")')
await page.waitForTimeout(500)

// 跳页
await page.fill('.page-input', '10')
await page.press('.page-input', 'Enter')
await page.waitForTimeout(800)
check('跳页到 10', await page.inputValue('.page-input') === '10')

// 滚动模式
await page.click('.seg button:has-text("滚动")')
await page.waitForSelector('.page-holder canvas', { timeout: 15000 })
check('滚动模式保页码', await page.inputValue('.page-input') === '10')
const canvasCount = await page.locator('.page-holder canvas').count()
check('滚动模式 canvas 回收', canvasCount <= 11, `${canvasCount} 个`)
await page.click('.seg button:has-text("翻页")')
await page.waitForSelector('.spread-host canvas', { timeout: 15000 })

// PDF 听书
await page.click('.btn:has-text("听书")')
await page.click('.tts-panel .btn-primary')
await page.waitForTimeout(5000)
check('PDF 听书自动翻页', parseInt(await page.inputValue('.page-input'), 10) > 10)
const stop2 = page.locator('.tts-panel .btn:has-text("停止")')
if (await stop2.isEnabled()) await stop2.click()

// PDF 自动翻页 (打开时应自动关闭听书面板 — 面板互斥)
await page.click('.btn:has-text("自动阅读")')
await page.waitForTimeout(300)
check('面板互斥: 听书面板已关', await page.locator('.tts-panel').count() === 0)
await page.locator('.auto-panel input[type=range]').fill('3')
await page.click('.auto-panel .btn')
const pAuto = parseInt(await page.inputValue('.page-input'), 10)
await page.waitForTimeout(3800)
check('PDF 自动翻页', parseInt(await page.inputValue('.page-input'), 10) > pAuto)
await page.click('.auto-panel .icon-btn')

// ================= 设置与备份 =================
console.log('\n== 设置与备份 ==')
await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
const download = page.waitForEvent('download', { timeout: 30000 })
await page.click('.btn:has-text("导出备份")')
const dl = await download
const backupPath = join(TMP, 'backup.zip')
await dl.saveAs(backupPath)
check('备份导出', true, backupPath)

// 新环境恢复
const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page2.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle' })
await page2.setInputFiles('input[accept=".zip"]', backupPath)
await page2.waitForSelector('.toast.success', { timeout: 30000 })
await page2.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' })
await page2.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 10000 })
check('备份恢复 (新环境)', true, '2 本还原')
const restored = await page2.locator('.book-card:has-text("测试小说") .progress').count()
check('恢复后进度保留', restored === 1)
await page2.close()

// ================= 书源 =================
console.log('\n== 书源 ==')
await page.goto(`${BASE}/#/catalogs`, { waitUntil: 'networkidle' })
await page.waitForSelector('.source-card', { timeout: 8000 })
const sources = await page.locator('.source-title').allTextContents()
check('内置书源', sources.some(s => s.includes('古登堡')) && sources.some(s => s.includes('arXiv')), sources.join(' | '))
await page.click('.source-card:has-text("arXiv")')
await page.waitForSelector('.nav-card', { timeout: 8000 })
check('arXiv 分类页', await page.locator('.nav-card').count() === 12)
await page.click('.btn:has-text("← 返回")')
await page.click('.btn:has-text("添加书源")')
await page.fill('input[placeholder*="我的 Calibre"]', '测试源')
await page.fill('input[placeholder*="example.com"]', 'https://example.com/opds')
await page.click('.modal .btn-primary')
await page.waitForTimeout(400)
check('添加自定义书源', await page.locator('.source-card:has-text("测试源")').count() === 1)
page.once('dialog', d => d.accept())
await page.click('.source-card:has-text("测试源") .btn-danger')
await page.waitForTimeout(400)
check('删除自定义书源', await page.locator('.source-card:has-text("测试源")').count() === 0)

// ================= 移动端布局 =================
console.log('\n== 移动端视口 (390×844) ==')
await page.setViewportSize({ width: 390, height: 844 })
await page.goto(`${BASE}/#/library`, { waitUntil: 'networkidle' })
await page.waitForSelector('.book-card', { timeout: 8000 })
const hOverflowLib = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)
check('藏书页无横向溢出', !hOverflowLib)
await page.click('.book-card:has-text("测试小说")')
await page.waitForSelector('foliate-view', { timeout: 15000 })
await page.waitForTimeout(1000)
const hOverflowReader = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2)
check('阅读页无横向溢出', !hOverflowReader)
await page.screenshot({ path: join(TMP, 'shots', 'mobile-reader.png') })

// ================= 批量管理 =================
console.log('\n== 批量管理 ==')
await page.setViewportSize({ width: 1280, height: 800 })
await page.goto(`${BASE}/#/library`, { waitUntil: 'load' })
await page.waitForSelector('.book-card', { timeout: 8000 })
await page.click('.btn:has-text("管理")')
await page.waitForSelector('.batch-bar', { timeout: 5000 })
check('进入管理模式', true)
await page.click('.batch-bar .btn:has-text("全选")')
await page.waitForTimeout(300)
check('全选', (await page.textContent('.batch-count'))?.includes('2'))
await page.click('.batch-bar .btn:has-text("设置标签")')
await page.fill('.modal .input', '科幻, 待读')
await page.click('.modal .btn-primary')
await page.waitForTimeout(400)
check('批量打标签', await page.locator('.tag-chip:has-text("科幻")').count() === 1)
await page.click('.tag-chip:has-text("待读")')
await page.waitForTimeout(300)
check('标签筛选', await page.locator('.book-card').count() === 2)
await page.click('.tag-chip:has-text("全部")')
page.once('dialog', d => d.accept())
await page.click('.batch-bar .btn:has-text("删除")')
await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 0, null, { timeout: 8000 })
check('批量删除', true)

// ================= 汇总 =================
const fatal = errors.filter(e => !e.includes('ResizeObserver'))
console.log(`\n========= 结果: ${pass} 通过, ${fail} 失败 =========`)
if (failures.length) console.log('失败项:', failures.join(' / '))
console.log('页面错误:', fatal.length ? fatal.slice(0, 5).join(' | ') : '无')
await browser.close()
process.exit(fail > 0 || fatal.length > 0 ? 1 : 0)
