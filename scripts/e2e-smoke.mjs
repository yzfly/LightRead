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

// 2. 四页最小合法 PDF（覆盖默认滚动、小字号清晰度、适配、双页与书籍视图）
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
1 0 obj << /Type /Catalog /Pages 2 0 R /Outlines 12 0 R /PageMode /UseOutlines >> endobj
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
12 0 obj << /Type /Outlines /First 13 0 R /Last 14 0 R /Count 2 >> endobj
13 0 obj << /Title (Chapter One) /Parent 12 0 R /Next 14 0 R /Dest [3 0 R /XYZ null 792 null] >> endobj
14 0 obj << /Title (Chapter Three) /Parent 12 0 R /Prev 13 0 R /Dest [8 0 R /XYZ null 792 null] >> endobj
trailer << /Root 1 0 R /Size 15 >>
%%EOF`
const pdfPath = join(TMP, 'test-doc.pdf')
writeFileSync(pdfPath, pdfContent)
const shortcutPdfPath = join(TMP, 'shortcut-open.pdf')
writeFileSync(shortcutPdfPath, pdfContent)
const stalePdfPath = join(TMP, 'stale-open.pdf')
writeFileSync(stalePdfPath, pdfContent)
const corruptPdfPath = join(TMP, 'corrupt.pdf')
writeFileSync(corruptPdfPath, 'This file only has a PDF extension.', 'utf-8')
const widePdfPath = join(TMP, 'bilingual-wide.pdf')
writeFileSync(widePdfPath, pdfContent.replaceAll('/MediaBox [0 0 612 792]', '/MediaBox [0 0 1224 792]'))

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

await step('新建书单并加入单本书籍', async () => {
  await page.getByRole('button', { name: '新建书单', exact: true }).click()
  await page.getByPlaceholder('例如：2026 阅读计划').fill('产品精读')
  await page.getByRole('button', { name: '创建书单', exact: true }).click()
  await page.getByRole('button', { name: /全部藏书/ }).click()
  const txtCard = page.locator('.book-card:has-text("测试小说")')
  await txtCard.hover()
  await txtCard.locator('.booklist-action').click()
  await page.locator('.booklist-picker-row:has-text("产品精读")').click()
  await page.locator('.booklist-chip:has-text("产品精读")').click()
  await page.waitForFunction(() =>
    document.querySelectorAll('.book-card').length === 1
    && document.querySelector('.book-card')?.textContent?.includes('测试小说'))
})

await step('书单支持移除、批量加入与持久化', async () => {
  await page.getByRole('button', { name: '管理', exact: true }).click()
  await page.locator('.book-card:has-text("测试小说")').click()
  await page.getByRole('button', { name: '从书单移除', exact: true }).click()
  await page.waitForSelector('text=这个书单还是空的')

  await page.getByRole('button', { name: /全部藏书/ }).click()
  await page.getByRole('button', { name: '全选', exact: true }).click()
  await page.getByRole('button', { name: '加入书单', exact: true }).click()
  await page.locator('.booklist-picker-row:has-text("产品精读")').click()
  await page.locator('.booklist-chip:has-text("产品精读")').click()
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 2)

  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.booklist-chip:has-text("产品精读")').click()
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 2)

  await page.getByRole('button', { name: '管理书单', exact: true }).click()
  await page.locator('.booklist-manage-row input').fill('产品深读')
  await page.locator('.booklist-manage-row').getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.waitForSelector('.booklist-chip:has-text("产品深读")')
})
await page.screenshot({ path: join(TMP, 'shots', '02-booklist.png') })

await step('打开 TXT 阅读器并渲染正文', async () => {
  if (await page.locator('.book-card .select-mark').count()) {
    await page.getByRole('button', { name: '完成', exact: true }).last().click()
  }
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
  // 藏书 PDF 统一走 PDF 阅读器，默认 MuPDF 渲染 + 连续滚动 + 适宽
  await page.waitForSelector('.p-holder canvas', { timeout: 15000 })
})
await page.screenshot({ path: join(TMP, 'shots', '06-pdf.png') })

await step('PDF 默认连续滚动与适宽', async () => {
  await page.waitForFunction(() => {
    const box = document.querySelector('.pane-left')
    const canvas = document.querySelector('.pane-left canvas')
    if (!box || !canvas) return false
    return Math.abs(parseFloat(canvas.style.width) - box.clientWidth) <= 1
  }, null, { timeout: 3000 })
  const fit = await page.evaluate(() => {
    const box = document.querySelector('.pane-left')
    const canvas = document.querySelector('.pane-left canvas')
    const boxRect = box?.getBoundingClientRect()
    const canvasRect = canvas?.getBoundingClientRect()
    const clientLeft = (boxRect?.left ?? 0) + (box?.clientLeft ?? 0)
    const clientRight = clientLeft + (box?.clientWidth ?? 0)
    const clientTop = (boxRect?.top ?? 0) + (box?.clientTop ?? 0)
    const style = box ? getComputedStyle(box) : null
    return {
      hasScrollMode: !!document.querySelector('.reader-segment button.active')?.textContent?.includes('滚动'),
      boxW: box?.clientWidth ?? 0,
      canvasW: parseFloat(canvas?.style.width ?? '0'),
      leftGap: (canvasRect?.left ?? 0) - clientLeft,
      rightGap: clientRight - (canvasRect?.right ?? 0),
      topGap: (canvasRect?.top ?? 0) - clientTop,
      paddingLeft: parseFloat(style?.paddingLeft ?? '0'),
      paddingRight: parseFloat(style?.paddingRight ?? '0'),
      paddingTop: parseFloat(style?.paddingTop ?? '0'),
      paddingBottom: parseFloat(style?.paddingBottom ?? '0'),
    }
  })
  if (!fit.hasScrollMode) throw new Error('默认模式不是滚动')
  if (Math.abs(fit.canvasW - fit.boxW) > 1
    || Math.abs(fit.leftGap) > 1
    || Math.abs(fit.rightGap) > 1
    || Math.abs(fit.topGap) > 1
    || fit.paddingLeft !== 0
    || fit.paddingRight !== 0
    || fit.paddingTop !== 0
    || fit.paddingBottom !== 0) {
    throw new Error(`页宽未铺满: ${JSON.stringify(fit)}`)
  }
})

await step('PDF 画布按设备像素显示且文字无彩色雾边', async () => {
  const quality = await page.evaluate(() => {
    const canvas = document.querySelector('.pane-left canvas')
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

await step('PDF 可切换翻页并一键适高', async () => {
  await page.getByRole('button', { name: '翻页', exact: true }).click()
  await page.getByRole('button', { name: '适高', exact: true }).click()
  await page.waitForSelector('.paged-box .p-holder canvas', { timeout: 8000 })
  await page.waitForFunction(() => {
    const box = document.querySelector('.paged-box')
    const canvas = document.querySelector('.spread-host canvas')
    if (!box || !canvas) return false
    return Math.abs(parseFloat(canvas.style.height) - box.clientHeight) <= 1
  }, null, { timeout: 3000 })
  const fit = await page.evaluate(() => {
    const box = document.querySelector('.paged-box')
    const canvas = document.querySelector('.spread-host canvas')
    const boxRect = box?.getBoundingClientRect()
    const canvasRect = canvas?.getBoundingClientRect()
    const clientTop = (boxRect?.top ?? 0) + (box?.clientTop ?? 0)
    const clientBottom = clientTop + (box?.clientHeight ?? 0)
    const style = box ? getComputedStyle(box) : null
    return {
      boxH: box?.clientHeight ?? 0,
      canvasH: parseFloat(canvas?.style.height ?? '0'),
      topGap: (canvasRect?.top ?? 0) - clientTop,
      bottomGap: clientBottom - (canvasRect?.bottom ?? 0),
      paddingTop: parseFloat(style?.paddingTop ?? '0'),
      paddingBottom: parseFloat(style?.paddingBottom ?? '0'),
    }
  })
  if (Math.abs(fit.canvasH - fit.boxH) > 1
    || Math.abs(fit.topGap) > 1
    || Math.abs(fit.bottomGap) > 1
    || fit.paddingTop !== 0
    || fit.paddingBottom !== 0) {
    throw new Error(`页高未铺满: ${JSON.stringify(fit)}`)
  }
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
})

await step('PDF 缩小档位保持整数 CSS 与设备像素一一对应', async () => {
  await page.locator('.dock-zoom').click()
  await page.locator('.zoom-item', { hasText: '66.67%' }).click()
  await page.waitForFunction(() => document.querySelector('.dock-zoom')?.textContent?.includes('66.67%'))
  await page.waitForTimeout(500)
  const quality = await page.locator('.spread-host canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect()
    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      bitmapToCssX: canvas.width / rect.width,
      bitmapToCssY: canvas.height / rect.height,
      physicalLeft: rect.left * window.devicePixelRatio,
      physicalTop: rect.top * window.devicePixelRatio,
      dpr: window.devicePixelRatio,
    }
  })
  if (!Number.isInteger(quality.cssWidth) || !Number.isInteger(quality.cssHeight)) {
    throw new Error(`缩小页面仍使用小数 CSS 尺寸: ${quality.cssWidth}×${quality.cssHeight}`)
  }
  if (Math.abs(quality.bitmapToCssX - quality.dpr) > 1e-6
    || Math.abs(quality.bitmapToCssY - quality.dpr) > 1e-6) {
    throw new Error(`缩小位图发生二次插值: ${quality.bitmapToCssX}/${quality.bitmapToCssY}, DPR ${quality.dpr}`)
  }
  if (Math.abs(quality.physicalLeft - Math.round(quality.physicalLeft)) > 1e-6
    || Math.abs(quality.physicalTop - Math.round(quality.physicalTop)) > 1e-6) {
    throw new Error(`页面边缘未对齐物理像素: ${quality.physicalLeft}, ${quality.physicalTop}`)
  }
  await page.locator('.dock-zoom').click()
  await page.locator('.zoom-item', { hasText: '适合页面' }).click()
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

await step('PDF 已移除流式阅读入口', async () => {
  if (await page.getByRole('button', { name: '流式', exact: true }).count()) {
    throw new Error('仍显示流式阅读入口')
  }
  await page.waitForSelector('.p-holder canvas', { timeout: 10000 })
})

await step('PDF 文件属性可查看', async () => {
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '文件属性', exact: true }).click()
  await page.waitForSelector('.document-dialog')
  const properties = await page.locator('.document-dialog').innerText()
  for (const value of ['test-doc.pdf', '4', 'PDF 版本', '页面尺寸']) {
    if (!properties.includes(value)) throw new Error(`文件属性缺少: ${value}`)
  }
  await page.locator('.document-dialog footer button').click()
})

await step('PDF 网页版可另存为原文件', async () => {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '另存为', exact: true }).click()
  const download = await downloadPromise
  if (download.suggestedFilename() !== 'test-doc.pdf') {
    throw new Error(`另存文件名异常: ${download.suggestedFilename()}`)
  }
})

await step('PDF 标准保存快捷键沿用另存为流程', async () => {
  const primaryKey = process.platform === 'darwin' ? 'Meta' : 'Control'
  const downloadPromise = page.waitForEvent('download')
  await page.keyboard.press(`${primaryKey}+s`)
  const download = await downloadPromise
  if (download.suggestedFilename() !== 'test-doc.pdf') {
    throw new Error(`快捷键另存文件名异常: ${download.suggestedFilename()}`)
  }
})

await step('PDF 标准打开快捷键导入同类藏书并重建阅读器', async () => {
  const primaryKey = process.platform === 'darwin' ? 'Meta' : 'Control'
  const previousUrl = page.url()

  await page.evaluate(() => {
    const originalArrayBuffer = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = function (...args) {
      if (this.name !== 'stale-open.pdf') return originalArrayBuffer.apply(this, args)
      File.prototype.arrayBuffer = originalArrayBuffer
      return new Promise((resolve, reject) => {
        setTimeout(() => originalArrayBuffer.apply(this, args).then(resolve, reject), 500)
      })
    }
  })
  const staleChooserPromise = page.waitForEvent('filechooser')
  await page.keyboard.press(`${primaryKey}+o`)
  const staleChooser = await staleChooserPromise
  await staleChooser.setFiles(stalePdfPath)
  await page.locator('.document-back').click()
  await page.waitForTimeout(800)
  if (!page.url().endsWith('#/library')) throw new Error(`失效导入抢占了后续导航: ${page.url()}`)
  if (await page.locator('.toast.error:has-text("无法打开 PDF")').count()) {
    throw new Error('阅读器失效后仍显示 PDF 打开失败提示')
  }
  if (await page.locator('.book-card:has-text("stale-open")').count()) {
    throw new Error('阅读器失效后仍导入了 PDF')
  }
  await page.click('.book-card:has-text("test-doc")')
  await page.waitForSelector('.p-holder canvas', { timeout: 15000 })

  const invalidChooserPromise = page.waitForEvent('filechooser')
  await page.keyboard.press(`${primaryKey}+o`)
  const invalidChooser = await invalidChooserPromise
  await invalidChooser.setFiles(txtPath)
  await page.waitForSelector('.toast.error:has-text("请选择 PDF 文件")')
  if (page.url() !== previousUrl) throw new Error('选择非 PDF 后阅读器发生跳转')

  const corruptChooserPromise = page.waitForEvent('filechooser')
  await page.keyboard.press(`${primaryKey}+o`)
  const corruptChooser = await corruptChooserPromise
  await corruptChooser.setFiles(corruptPdfPath)
  await page.waitForSelector('.toast.error:has-text("无法打开 PDF")')
  if (page.url() !== previousUrl) throw new Error('选择损坏 PDF 后阅读器发生跳转')

  const chooserPromise = page.waitForEvent('filechooser')
  await page.keyboard.press(`${primaryKey}+o`)
  const chooser = await chooserPromise
  await chooser.setFiles(shortcutPdfPath)
  await page.waitForFunction(() =>
    document.querySelector('.paper-title strong')?.textContent?.trim() === 'shortcut-open',
  null, { timeout: 15000 })
  if (page.url() === previousUrl) throw new Error('打开新 PDF 后阅读器路由未变化')
  const backTitle = await page.locator('.document-back').getAttribute('title')
  if (!backTitle?.includes('藏书')) throw new Error(`新 PDF 未保留藏书归属: ${backTitle || 'missing'}`)
})

await step('PDF 可编辑区域保留原生快捷键', async () => {
  const results = await page.evaluate(() => {
    const fixtures = [
      { name: 'empty', html: '<div contenteditable=""></div>', selector: 'div' },
      { name: 'plaintext', html: '<div contenteditable="plaintext-only"></div>', selector: 'div' },
      { name: 'inherited', html: '<div contenteditable="true"><span></span></div>', selector: 'span' },
    ]
    return fixtures.map(fixture => {
      const host = document.createElement('div')
      host.innerHTML = fixture.html
      document.body.append(host)
      const target = host.querySelector(fixture.selector)
      const event = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })
      const dispatched = target?.dispatchEvent(event) ?? false
      const result = {
        name: fixture.name,
        editable: target instanceof HTMLElement && target.isContentEditable,
        prevented: !dispatched || event.defaultPrevented,
      }
      host.remove()
      return result
    })
  })
  for (const result of results) {
    if (!result.editable || result.prevented) {
      throw new Error(`contenteditable ${result.name} 未保留原生按键: ${JSON.stringify(result)}`)
    }
  }
})

await step('PDF 快捷键面板展示完整操作并适配短视口', async () => {
  await page.setViewportSize({ width: 520, height: 420 })
  await page.keyboard.press('Shift+/')
  await page.waitForSelector('.shortcut-menu')
  const focused = await page.locator('.shortcut-menu').evaluate(element => document.activeElement === element)
  if (!focused) throw new Error('快捷键面板打开后未获得焦点')
  const guideText = await page.locator('.shortcut-menu').innerText()
  for (const label of ['打开 PDF', '下一个 / 上一个搜索结果', '阅读历史后退 / 前进', '开始幻灯片放映', '打开 / 关闭目录']) {
    if (!guideText.includes(label)) throw new Error(`快捷键面板缺少: ${label}`)
  }
  const scrollState = await page.locator('.shortcut-menu').evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }))
  if (scrollState.scrollHeight <= scrollState.clientHeight || scrollState.overflowY !== 'auto') {
    throw new Error(`短视口面板不可滚动: ${JSON.stringify(scrollState)}`)
  }
  const firstRowLayout = await page.locator('.shortcut-row').first().evaluate(row => {
    const [keys, label] = [...row.children].map(child => child.getBoundingClientRect())
    return { keysTop: keys?.top, labelTop: label?.top }
  })
  if (!(firstRowLayout.labelTop > firstRowLayout.keysTop)) {
    throw new Error(`移动窄屏快捷键行未切换为单列: ${JSON.stringify(firstRowLayout)}`)
  }
  const pageBefore = await page.locator('.page-input').inputValue()
  const readerScrollBefore = await page.locator('.pane-left, .paged-box, .reflow-scroll').first().evaluate(element => element.scrollTop)
  await page.keyboard.press('PageDown')
  await page.waitForFunction(() => (document.querySelector('.shortcut-menu')?.scrollTop ?? 0) > 0)
  const panelScrollAfter = await page.locator('.shortcut-menu').evaluate(element => element.scrollTop)
  const readerScrollAfter = await page.locator('.pane-left, .paged-box, .reflow-scroll').first().evaluate(element => element.scrollTop)
  const pageAfter = await page.locator('.page-input').inputValue()
  if (panelScrollAfter <= 0 || readerScrollAfter !== readerScrollBefore || pageAfter !== pageBefore) {
    throw new Error(`键盘滚动未由快捷键面板接管: ${JSON.stringify({ panelScrollAfter, readerScrollBefore, readerScrollAfter, pageBefore, pageAfter })}`)
  }
  await page.keyboard.press('Escape')
  await page.waitForSelector('.shortcut-menu', { state: 'detached' })
  await page.setViewportSize({ width: 1280, height: 800 })
})

await step('PDF 全屏支持目录侧栏与跳转', async () => {
  const pageBefore = await page.locator('.page-input').inputValue()
  await page.getByRole('button', { name: '全屏阅读 (F)', exact: true }).click()
  await page.waitForFunction(() => !!document.fullscreenElement)
  const headerDisplay = await page.locator('.paper-header').evaluate(el => getComputedStyle(el).display)
  if (headerDisplay !== 'none') throw new Error(`全屏仍显示工具栏: ${headerDisplay}`)
  await page.locator('.fullscreen-toc-toggle').click()
  await page.waitForSelector('.fullscreen-toc-drawer .toc-item:has-text("Chapter Three")')
  await page.locator('.fullscreen-toc-drawer .toc-item:has-text("Chapter Three")').click()
  await page.waitForFunction(() => document.querySelector('.page-input')?.value === '3')
  if (!await page.locator('.fullscreen-toc-drawer').isVisible()) throw new Error('目录跳转后侧栏被关闭')
  if (!await page.evaluate(() => !!document.fullscreenElement)) throw new Error('目录跳转后退出了全屏')
  await page.locator('.fullscreen-toc-drawer .drawer-head .icon-btn').click()
  await page.waitForSelector('.fullscreen-exit')
  await page.locator('.fullscreen-exit').click()
  await page.waitForFunction(() => !document.fullscreenElement)
  await page.locator('.page-input').fill(pageBefore)
  await page.locator('.page-input').press('Enter')
  await page.waitForFunction(value => document.querySelector('.page-input')?.value === value, pageBefore)
})

await step('PDF 幻灯片支持逐页与退出', async () => {
  await page.getByRole('button', { name: '幻灯片放映 (F5)', exact: true }).click()
  await page.waitForSelector('.paper.is-presentation .presentation-controls')
  const before = await page.locator('.page-input').inputValue()
  await page.locator('.presentation-controls button').last().click()
  await page.waitForFunction(value => document.querySelector('.page-input')?.value !== value, before)
  await page.locator('.fullscreen-exit').click()
  await page.waitForSelector('.paper.is-presentation', { state: 'detached' })
})

await step('PDF 书籍视图支持连续滚动双页', async () => {
  await page.getByRole('button', { name: '滚动', exact: true }).click()
  await page.getByRole('button', { name: '书籍视图', exact: true }).click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.scroll-spread-host')]
      .some(group => group.querySelectorAll('.p-holder').length === 2),
  null, { timeout: 8000 })
  await page.getByRole('button', { name: '单页', exact: true }).click()
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
  await page.getByRole('button', { name: '对页', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.spread-host canvas').length === 2, null, { timeout: 8000 })
  await page.screenshot({ path: join(TMP, 'shots', '06b-pdf-two-page.png') })
  await page.locator('.paper-actions').screenshot({ path: join(TMP, 'shots', '06c-pdf-toolbar.png') })
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelector('.page-input')?.value === '3', null, { timeout: 5000 })
})

await step('PDF Sumatra 单页、对页与书籍视图快捷键', async () => {
  const primaryKey = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${primaryKey}+8`)
  await page.waitForFunction(() => {
    const pages = [...document.querySelectorAll('.spread-host .p-holder')].map(el => el.getAttribute('data-page'))
    return pages.join(',') === '2,3'
  }, null, { timeout: 5000 })
  await page.keyboard.press(`${primaryKey}+6`)
  await page.waitForFunction(() => document.querySelectorAll('.spread-host canvas').length === 1, null, { timeout: 5000 })
  await page.keyboard.press(`${primaryKey}+7`)
  await page.waitForFunction(() => document.querySelectorAll('.spread-host canvas').length === 2, null, { timeout: 5000 })
  await page.keyboard.press(`${primaryKey}+6`)
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

await step('双语横版 PDF 适宽后四周和页间均无接缝', async () => {
  await page.goto('http://localhost:4173/#/library', { waitUntil: 'networkidle' })
  await page.setInputFiles('input[type=file][multiple]', widePdfPath)
  await page.waitForSelector('.book-card:has-text("bilingual-wide")', { timeout: 15000 })
  await page.click('.book-card:has-text("bilingual-wide")')
  await page.waitForSelector('.p-holder canvas', { timeout: 15000 })
  await page.getByRole('button', { name: '滚动', exact: true }).click()
  await page.getByRole('button', { name: '单页', exact: true }).click()
  await page.getByRole('button', { name: '适宽', exact: true }).click()
  await page.waitForFunction(() => {
    const box = document.querySelector('.pane-left')
    const canvas = document.querySelector('.pane-left canvas')
    if (!box || !canvas) return false
    const boxRect = box.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    const clientLeft = boxRect.left + box.clientLeft
    const clientRight = clientLeft + box.clientWidth
    const clientTop = boxRect.top + box.clientTop
    return Math.abs(canvasRect.left - clientLeft) <= 1
      && Math.abs(canvasRect.right - clientRight) <= 1
      && Math.abs(canvasRect.top - clientTop) <= 1
  }, null, { timeout: 5000 })
  const geometry = await page.evaluate(() => {
    const box = document.querySelector('.pane-left')
    const canvas = document.querySelector('.pane-left canvas')
    const boxRect = box.getBoundingClientRect()
    const canvasRect = canvas.getBoundingClientRect()
    const style = getComputedStyle(box)
    const clientLeft = boxRect.left + box.clientLeft
    const clientRight = clientLeft + box.clientWidth
    const clientTop = boxRect.top + box.clientTop
    return {
      leftGap: canvasRect.left - clientLeft,
      rightGap: clientRight - canvasRect.right,
      topGap: canvasRect.top - clientTop,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
    }
  })
  if (geometry.padding.some(value => parseFloat(value) !== 0)) {
    throw new Error(`双语横版仍有容器 padding: ${JSON.stringify(geometry)}`)
  }
  const seam = await page.evaluate(() => {
    const groups = [...document.querySelectorAll('.pane-left .scroll-spread-host')]
    if (groups.length < 2) return null
    const firstRect = groups[0].getBoundingClientRect()
    const secondRect = groups[1].getBoundingClientRect()
    return {
      gap: secondRect.top - firstRect.bottom,
      firstMarginBottom: getComputedStyle(groups[0]).marginBottom,
      firstPageBoxShadow: getComputedStyle(groups[0].querySelector('.p-holder')).boxShadow,
    }
  })
  if (!seam || Math.abs(seam.gap) > 1 || seam.firstPageBoxShadow !== 'none') {
    throw new Error(`PDF 两页之间仍有接缝: ${JSON.stringify(seam)}`)
  }
  await page.screenshot({ path: join(TMP, 'shots', '06f-bilingual-wide-fit.png') })
  await page.evaluate(() => {
    const box = document.querySelector('.pane-left')
    const firstGroup = document.querySelector('.pane-left .scroll-spread-host')
    if (box && firstGroup) box.scrollTop = Math.max(0, firstGroup.scrollHeight - box.clientHeight / 2)
  })
  await page.screenshot({ path: join(TMP, 'shots', '06g-bilingual-wide-page-seam.png') })
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
