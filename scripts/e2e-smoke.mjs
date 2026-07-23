// LightRead 端到端冒烟: 导入 TXT → 书架出现 → 打开阅读器 → 目录/翻页 → PDF 导入打开
import { chromium, webkit } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const TMP = '/tmp/lightread-e2e'
mkdirSync(join(TMP, 'shots'), { recursive: true })

// 1. 测试 TXT (带中文章节)
const txtPath = join(TMP, '测试小说.txt')
const chapters = []
for (let i = 1; i <= 5; i++) {
  chapters.push(`第${['一', '二', '三', '四', '五'][i - 1]}章 风起于青萍之末\n\n` +
    `这是第 ${i} 章的正文内容。`.repeat(3) + '\n\n' +
    '夜色像一块浸了水的墨布，慢慢压下来。他把灯芯挑亮了一点，书页上的字便站得直了些。\n'.repeat(40))
}
writeFileSync(txtPath, chapters.join('\n\n'), 'utf-8')

// 2. 四页最小合法 PDF（覆盖小字号清晰度、适高、双页与双页翻页）
const pdfPageText = page => `BT
/F1 24 Tf 100 700 Td (Hello LightRead PDF ${page}) Tj
/F1 10 Tf 0 -36 Td (The quick brown fox jumps over the lazy dog 0123456789.) Tj
0 -14 Td (Small body text should keep neutral gray antialiasing.) Tj
ET`
const pdfStream = page => {
  const body = pdfPageText(page)
  return `<< /Length ${body.length} >> stream\n${body}\nendstream`
}
const pdfContent = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 6 0 R 8 0 R 10 0 R] /Count 4 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj ${pdfStream(1)} endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
6 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
7 0 obj ${pdfStream(2)} endobj
8 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 9 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
9 0 obj ${pdfStream(3)} endobj
10 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
11 0 obj ${pdfStream(4)} endobj
trailer << /Root 1 0 R /Size 12 >>
%%EOF`
const pdfPath = join(TMP, 'test-doc.pdf')
writeFileSync(pdfPath, pdfContent)

const browserType = process.env.ENGINE === 'webkit' ? webkit : chromium
const browser = await browserType.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', e => errors.push('PAGE_ERROR: ' + (e.stack || e.message)))
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()) })
await page.addInitScript(() => {
  // 固定一个缓存中的新版，避免 UI 回归测试依赖 GitHub 网络。
  localStorage.setItem('lightread-update-check', JSON.stringify({
    at: Date.now(),
    info: {
      version: '99.0.0',
      hasUpdate: true,
      notes: 'E2E update fixture',
      publishedAt: '2099-01-01',
      pageUrl: 'about:blank#lightread-release',
      assets: [
        { name: 'LightRead_99.0.0_aarch64.dmg', url: 'about:blank#lightread-aarch64.dmg', size: 1024 },
        { name: 'LightRead_99.0.0_x64.dmg', url: 'about:blank#lightread-x64.dmg', size: 1024 },
        { name: 'LightRead_99.0.0_setup.exe', url: 'about:blank#lightread-setup.exe', size: 1024 },
        { name: 'LightRead_99.0.0.AppImage', url: 'about:blank#lightread.AppImage', size: 1024 },
      ],
    },
  }))
})

const step = async (name, fn) => {
  try {
    await fn()
    console.log('✅', name)
  } catch (e) {
    console.log('❌', name, '—', e.message.split('\n')[0])
    await page.screenshot({ path: join(TMP, 'shots', `fail-${name.replace(/\W+/g, '_')}.png`) })
  }
}

// 沉浸式阅读: 翻页后工具栏自动隐藏 (pointer-events: none), 点工具栏按钮前先悬停顶部呼出条
const revealBars = async () => {
  if (await page.locator('.bar-peek.top').count()) {
    await page.hover('.bar-peek.top')
    await page.waitForSelector('header.bar.top:not(.hidden)', { timeout: 3000 })
  }
}

await step('打开应用', async () => {
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' })
  await page.waitForSelector('text=书架还是空的', { timeout: 8000 })
})

await step('侧栏更新按钮收起、悬停展开并下载', async () => {
  const button = page.locator('.sidebar-update')
  await button.waitFor({ state: 'visible', timeout: 5000 })
  const collapsed = await button.boundingBox()
  if (!collapsed || collapsed.width > 42) throw new Error(`收起宽度异常: ${collapsed?.width}`)

  await button.hover()
  await page.waitForFunction(() => {
    const el = document.querySelector('.sidebar-update')
    return el && el.getBoundingClientRect().width >= 108 && el.textContent?.includes('更新')
  })

  const popupPromise = page.waitForEvent('popup')
  await button.click()
  const popup = await popupPromise
  await popup.close()
  await page.waitForSelector('.toast.success:has-text("已在浏览器中开始下载")')
})
await page.screenshot({ path: join(TMP, 'shots', '01-empty-library.png') })

await step('导入 TXT', async () => {
  await page.setInputFiles('input[type=file][multiple]', txtPath)
  await page.waitForSelector('.book-card', { timeout: 15000 })
})

await step('导入 PDF', async () => {
  await page.setInputFiles('input[type=file][multiple]', pdfPath)
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 15000 })
})
await page.screenshot({ path: join(TMP, 'shots', '02-library.png') })

await step('打开 TXT 阅读器并渲染正文', async () => {
  await page.click('.book-card:has-text("测试小说")')
  await page.waitForSelector('foliate-view', { timeout: 15000 })
  // foliate 渲染在 paginator 的 shadow DOM iframe 里, 通过 view API 取内容
  await page.waitForFunction(() => {
    const view = document.querySelector('foliate-view')
    const doc = view?.renderer?.getContents?.()?.[0]?.doc
    return !!doc?.body?.textContent?.includes('夜色像一块浸了水的墨布')
  }, null, { timeout: 15000 })
})
await page.screenshot({ path: join(TMP, 'shots', '03-reader.png') })

await step('目录面板显示章节', async () => {
  await page.click('button[title="目录"]')
  await page.waitForSelector('.toc-item:has-text("第一章")', { timeout: 5000 })
  await page.waitForSelector('.toc-item:has-text("第五章")', { timeout: 5000 })
})
await page.screenshot({ path: join(TMP, 'shots', '04-toc.png') })

await step('目录跳转到第三章', async () => {
  await page.click('.toc-item:has-text("第三章")')
  await page.waitForTimeout(800)
})

await step('键盘翻页更新进度', async () => {
  const before = await page.textContent('.percent')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(600)
  const after = await page.textContent('.percent')
  if (before === after) throw new Error(`进度未变化: ${before} -> ${after}`)
})

await step('书内搜索', async () => {
  await revealBars()
  await page.click('button[title="书内搜索"]')
  await page.fill('.search-form input', '墨布')
  await page.press('.search-form input', 'Enter')
  await page.waitForSelector('.search-item', { timeout: 10000 })
})
await page.screenshot({ path: join(TMP, 'shots', '05-search.png') })

await step('返回书架并打开 PDF', async () => {
  await revealBars()
  await page.click('button[title="返回藏书"]')
  await page.waitForSelector('.book-card', { timeout: 8000 })
  await page.click('.book-card:has-text("test-doc")')
  // 藏书 PDF 统一走 PDF 阅读器，默认 MuPDF 渲染 + 翻页 + 适高
  await page.waitForSelector('.p-holder canvas', { timeout: 15000 })
})
await page.screenshot({ path: join(TMP, 'shots', '06-pdf.png') })

await step('PDF 默认适高', async () => {
  const fit = await page.evaluate(() => {
    const box = document.querySelector('.paged-box')
    const canvas = document.querySelector('.spread-host canvas')
    return { boxH: box?.clientHeight ?? 0, canvasH: parseFloat(canvas?.style.height ?? '0') }
  })
  if (!(fit.canvasH <= fit.boxH && fit.canvasH > fit.boxH * 0.8)) {
    throw new Error(`页高未适高: ${Math.round(fit.canvasH)} / ${fit.boxH}`)
  }
})

await step('PDF 画布按设备像素显示且文字无彩色雾边', async () => {
  const quality = await page.evaluate(() => {
    const canvas = document.querySelector('.spread-host canvas')
    if (!(canvas instanceof HTMLCanvasElement)) return null
    const rect = canvas.getBoundingClientRect()
    const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
    let colored = 0
    if (pixels) {
      for (let i = 0; i < pixels.length; i += 4) {
        const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
        const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2])
        if (max - min > 1) colored++
      }
    }
    return {
      bitmapToCss: canvas.width / rect.width,
      dpr: window.devicePixelRatio,
      colored,
      renderer: canvas.dataset.renderer,
    }
  })
  if (!quality) throw new Error('找不到 PDF canvas')
  if (Math.abs(quality.bitmapToCss - quality.dpr) > 0.01) {
    throw new Error(`画布发生二次缩放: ${quality.bitmapToCss.toFixed(4)} / DPR ${quality.dpr}`)
  }
  if (quality.renderer !== 'mupdf') throw new Error(`清晰渲染引擎未启用: ${quality.renderer || 'unknown'}`)
  if (quality.colored) throw new Error(`文字存在 ${quality.colored} 个 LCD 彩色雾边像素`)
})

await step('PDF 200% 使用 96 DPI 百分比语义且不放大位图', async () => {
  await page.locator('.dock-zoom').click()
  await page.locator('.zoom-item', { hasText: '200%' }).click()
  await page.waitForFunction(() => document.querySelector('.dock-zoom')?.textContent?.includes('200%'))
  await page.waitForTimeout(500)
  const quality = await page.locator('.spread-host canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect()
    return {
      cssWidth: rect.width,
      bitmapToCss: canvas.width / rect.width,
      dpr: window.devicePixelRatio,
    }
  })
  const expectedCssWidth = 612 * 2 * (96 / 72)
  if (Math.abs(quality.cssWidth - expectedCssWidth) > 0.1) {
    throw new Error(`200% 缩放未按 96 DPI 换算: ${quality.cssWidth.toFixed(2)} / ${expectedCssWidth.toFixed(2)}`)
  }
  if (quality.bitmapToCss + 0.01 < quality.dpr) {
    throw new Error(`200% 位图被浏览器放大: ${quality.bitmapToCss.toFixed(4)} / DPR ${quality.dpr}`)
  }
  await page.locator('.dock-zoom').click()
  await page.locator('.zoom-item', { hasText: '适高' }).click()
})

await step('翻页 PDF 支持 Ctrl/Cmd+F 搜索与结果导航', async () => {
  const primaryKey = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${primaryKey}+f`)
  await page.waitForSelector('.pdf-search-input')
  await page.fill('.pdf-search-input', 'Small body text')
  await page.waitForFunction(
    () => document.querySelector('.pdf-search-status')?.textContent?.trim() === '1 / 4',
    null,
    { timeout: 8000 },
  )
  await page.waitForSelector('.spread-host .p-search-rect.active', { timeout: 5000 })
  await page.press('.pdf-search-input', 'Enter')
  await page.waitForFunction(
    () => document.querySelector('.pdf-search-status')?.textContent?.trim() === '2 / 4'
      && document.querySelector('.page-input')?.value === '2',
    null,
    { timeout: 5000 },
  )
  await page.press('.pdf-search-input', 'Escape')
  await page.waitForSelector('.pdf-search', { state: 'detached', timeout: 3000 })
})

await step('PDF 渲染引擎可切换为 PDFium', async () => {
  await page.goto('http://localhost:4173/#/settings', { waitUntil: 'networkidle' })
  const reading = page.locator('.section').filter({ hasText: '阅读偏好' })
  await reading.getByRole('button', { name: 'PDFium', exact: true }).click()
  await page.waitForTimeout(400)
  await page.goto('http://localhost:4173/#/library', { waitUntil: 'networkidle' })
  await page.click('.book-card:has-text("test-doc")')
  await page.waitForSelector('.p-holder canvas', { timeout: 15000 })
  const renderer = await page.locator('.p-holder canvas').first().getAttribute('data-renderer')
  if (renderer !== 'pdfium') throw new Error(`PDFium 渲染引擎未启用: ${renderer || 'unknown'}`)
})

await step('PDF 可切换流式阅读并返回原页', async () => {
  await page.getByRole('button', { name: '流式', exact: true }).click()
  await page.waitForSelector('.reflow-page', { timeout: 10000 })
  const text = await page.locator('.reflow-article').innerText()
  if (!text.includes('Hello LightRead PDF 1') || !text.includes('Small body text')) {
    throw new Error('流式正文未按 PDF 文本层生成')
  }
  if (await page.locator('.pane-left-wrap canvas').count()) throw new Error('流式模式仍在显示 PDF 位图')

  await page.locator('.dock-zoom', { hasText: 'Aa' }).click()
  await page.locator('.reflow-settings input[type="range"]').first().fill('22')
  const fontSize = await page.locator('.reflow-article').evaluate(el => getComputedStyle(el).fontSize)
  if (fontSize !== '22px') throw new Error(`流式字号未生效: ${fontSize}`)
  await page.locator('.zoom-backdrop').click({ position: { x: 4, y: 4 } })

  await page.getByRole('button', { name: '第 1 页 · 查看原版', exact: true }).click()
  await page.waitForSelector('.p-holder canvas', { timeout: 10000 })
})

await step('PDF 自动阅读按模式滚动或翻页', async () => {
  await page.click('.paper-actions .reader-segment button:has-text("滚动")')
  await page.waitForSelector('.pane-left .p-holder canvas', { timeout: 8000 })
  await page.click('.paper-actions .reader-tool:has-text("自动阅读")')
  await page.fill('.auto-panel input[type="range"]', '3')
  const before = await page.locator('.pane-left').evaluate(el => el.scrollTop)
  await page.click('.auto-panel .auto-toggle')
  await page.waitForTimeout(600)
  const after = await page.locator('.pane-left').evaluate(el => el.scrollTop)
  if (after <= before + 1) throw new Error(`滚动模式没有连续下移: ${before} -> ${after}`)
  await page.click('.auto-panel button[title="停止"]')

  await page.click('.paper-actions .reader-segment button:has-text("翻页")')
  await page.waitForSelector('.paged-box .p-holder canvas', { timeout: 8000 })
  const pageBefore = await page.locator('.page-input').inputValue()
  await page.click('.paper-actions .reader-tool:has-text("自动阅读")')
  await page.click('.auto-panel .auto-toggle')
  await page.waitForFunction(before => document.querySelector('.page-input')?.value !== before, pageBefore, { timeout: 4000 })
  await page.click('.paper-actions .reader-tool:has-text("自动阅读中")')
  await page.click('.auto-panel button[title="停止"]')
})

await step('PDF 双页与翻页', async () => {
  await page.click('.paper-actions .reader-tool:has-text("双页")')
  await page.waitForFunction(() => document.querySelectorAll('.spread-host canvas').length === 2, null, { timeout: 8000 })
  await page.screenshot({ path: join(TMP, 'shots', '06b-pdf-two-page.png') })
  await page.locator('.paper-actions').screenshot({ path: join(TMP, 'shots', '06c-pdf-toolbar.png') })
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.page-input')?.value === '3', null, { timeout: 5000 })
})

await step('PDF 自动阅读控制条自动与手动收起', async () => {
  await page.click('.paper-actions .reader-tool:has-text("自动阅读")')
  await page.waitForSelector('.auto-panel')
  await page.locator('.auto-panel').screenshot({ path: join(TMP, 'shots', '06d-pdf-auto-controls.png') })
  await page.click('.auto-panel .auto-toggle')
  await page.waitForSelector('.auto-panel', { state: 'hidden', timeout: 4000 })
  await page.waitForSelector('.paper-actions .reader-tool:has-text("自动阅读中")')
  await page.locator('.paper-actions').screenshot({ path: join(TMP, 'shots', '06e-pdf-auto-collapsed.png') })

  // 自动收起后可从顶部状态按钮重新展开；手动收起不应停止阅读。
  await page.click('.paper-actions .reader-tool:has-text("自动阅读中")')
  await page.waitForSelector('.auto-panel')
  await page.click('.auto-panel .auto-collapse')
  await page.waitForSelector('.auto-panel', { state: 'hidden' })
  await page.waitForSelector('.paper-actions .reader-tool:has-text("自动阅读中")')

  // 清理运行状态，避免定时器影响后续持久化断言。
  await page.click('.paper-actions .reader-tool:has-text("自动阅读中")')
  await page.click('.auto-panel button[title="停止"]')
  await page.waitForSelector('.paper-actions .reader-tool:has-text("自动阅读")')
})

await step('刷新后藏书与进度仍在 (持久化)', async () => {
  await page.goto('http://localhost:4173/#/library', { waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 8000 })
  const hasProgress = await page.locator('.book-card:has-text("测试小说") .progress').count()
  if (!hasProgress) throw new Error('TXT 书籍没有显示阅读进度')
})
await page.screenshot({ path: join(TMP, 'shots', '07-persisted.png') })

const expectedPdfRepairLogs = [
  'format error: cannot find startxref',
  'warning: trying to repair broken xref',
  'warning: repairing PDF document',
]
const fatal = errors.filter(e =>
  !e.includes('favicon') &&
  !e.includes('sw.js') &&
  !expectedPdfRepairLogs.some(message => e.includes(message)),
)
if (fatal.length) {
  console.log('\n--- 页面错误 ---')
  for (const e of fatal.slice(0, 10)) console.log(e)
} else {
  console.log('\n无页面错误')
}
await browser.close()
