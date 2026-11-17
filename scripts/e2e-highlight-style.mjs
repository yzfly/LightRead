/**
 * 写死字号的 EPUB 也能调字号 (issue #22) + 划线风格 色块 / 下划线 / 波浪线 (issue #21)。
 *
 * 连接 Vite 开发服务器 (用到 /src/storage/index.ts 动态导入):
 *   npm run dev                                         # 桌面界面
 *   E2E_BASE=http://localhost:5173 node scripts/e2e-highlight-style.mjs
 *   LIGHTREAD_UI=mobile npm run dev                     # App 界面 (只测划线风格)
 *   E2E_MOBILE=1 E2E_BASE=http://localhost:5173 node scripts/e2e-highlight-style.mjs
 * 截图在 E2E_OUT (默认 /tmp/lightread-highlight-style)。
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { zipSync, strToU8 } from 'fflate'

const base = process.env.E2E_BASE || 'http://localhost:5173'
const mobile = process.env.E2E_MOBILE === '1'
const out = process.env.E2E_OUT || `/tmp/lightread-highlight-style/${mobile ? 'app' : 'desktop'}`
await mkdir(out, { recursive: true })

/** 出版社式 EPUB: 正文、标题、注释全用 pt / px / 关键字写死字号, 还有一处 style 属性 */
function fixedSizeEpub() {
  const para = 'The allure of strong growth has probably led more investors into temptation than anything else. '
  const body = Array.from({ length: 12 }, (_, i) => `<p class="tx">${para.repeat(3)} (${i + 1})</p>`).join('\n')
  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Ch 1</title>
<link rel="stylesheet" type="text/css" href="style.css"/><style>.note { font-size: x-small; }</style></head>
<body><h1 class="ct">Analyzing a Company</h1>${body}<p class="note" style="font-size: 9pt">Inline note</p></body></html>`
  const css = 'body { font-size: 12pt; font-family: serif; }\np.tx { font-size: 16px; margin: 0; text-indent: 1.5em; }\nh1.ct { font: bold 18pt/1.2 serif; }\n'
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">urn:uuid:lightread-e2e-fixed-size</dc:identifier><dc:title>Fixed Size</dc:title><dc:language>en</dc:language>
<meta property="dcterms:modified">2026-11-16T00:00:00Z</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="css" href="style.css" media-type="text/css"/></manifest>
<spine><itemref idref="c1"/></spine></package>`
  const nav = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head>
<body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Ch 1</a></li></ol></nav></body></html>`
  return Buffer.from(zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/c1.xhtml': strToU8(xhtml),
    'OEBPS/style.css': strToU8(css),
  }))
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: mobile ? { width: 392, height: 850 } : { width: 1360, height: 900 },
  hasTouch: mobile,
  isMobile: mobile,
  locale: 'zh-CN',
  reducedMotion: 'reduce',
})
const p = await context.newPage()
p.setDefaultTimeout(20000)
const errors = []
p.on('pageerror', e => errors.push(e.message))
await p.addInitScript(() => localStorage.setItem('lightread-language', 'zh'))

const step = async (name, fn) => { await fn(); console.log('PASS', name) }
const shot = name => p.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' })
const storage = fn => p.evaluate(async src => {
  const s = await (await import('/src/storage/index.ts')).getStorage()
  const id = location.hash.split('/').at(-1).split('?')[0]
  return (0, eval)(src)(s, id)
}, fn.toString())
const sizes = () => p.evaluate(() => {
  const doc = document.querySelector('foliate-view').renderer.getContents()[0].doc
  const px = el => parseFloat(doc.defaultView.getComputedStyle(el).fontSize)
  return { p: px(doc.querySelector('p.tx')), h1: px(doc.querySelector('h1')), note: px(doc.querySelector('.note')), root: px(doc.documentElement) }
})
const setFontSize = async n => {
  await p.locator('input[type=range][aria-label="字号"]').fill(String(n))
  await p.waitForFunction(n => {
    const doc = document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc
    return doc && parseFloat(doc.defaultView.getComputedStyle(doc.documentElement).fontSize) === n
  }, n)
}

async function selectParagraph(index, end = 40) {
  await p.evaluate(([index, end]) => {
    const doc = document.querySelector('foliate-view').renderer.getContents()[0].doc
    const el = doc.querySelectorAll('p.tx')[index]
    const range = doc.createRange()
    range.setStart(el.firstChild, 4)
    range.setEnd(el.firstChild, end)
    doc.getSelection().removeAllRanges()
    doc.getSelection().addRange(range)
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, [index, end])
  await p.locator('.highlight-bar').waitFor()
}
/** 当前分节 overlayer 里画出来的标注形状: rect 填充 (色块 / 下划线) 或 path (波浪线) */
const overlayShapes = () => p.evaluate(() => {
  const r = document.querySelector('foliate-view').renderer
  const svg = r.getContents()[0].overlayer?.element
  return [...(svg?.querySelectorAll(':scope > g') ?? [])].map(g => ({
    paths: g.querySelectorAll('path').length,
    rects: g.querySelectorAll('rect').length,
    opacity: g.style.opacity,
    height: Math.min(...[...g.querySelectorAll('rect')].map(x => Number(x.getAttribute('height')))),
  }))
})

try {
  await step('import an EPUB with fixed pt / px font sizes and open it', async () => {
    await p.goto(base + '/#/library')
    await p.setInputFiles('input[type=file][multiple]', [{ name: 'fixed-size.epub', mimeType: 'application/epub+zip', buffer: fixedSizeEpub() }])
    await p.locator('.book-card').first().waitFor()
    await p.locator('.book-card').first().click()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc?.querySelector('p.tx'), null, { timeout: 60000 })
  })

  if (!mobile) {
    await step('issue #22: font size setting scales text the book sized in pt / px', async () => {
      await p.locator('button[title="排版设置"]').first().click()
      await setFontSize(14)
      const small = await sizes()
      await setFontSize(28)
      const big = await sizes()
      await shot('font-28')
      assert.equal(small.p, 14, `p follows the setting (16px in the book) → ${small.p}`)
      assert.equal(big.p, 28, `p follows the setting → ${big.p}`)
      assert.ok(Math.abs(big.h1 / big.p - 1.5) < 0.01, `h1 keeps its 18pt : 12pt ratio (${big.h1}/${big.p})`)
      assert.ok(Math.abs(big.note / small.note - 2) < 0.01, `inline style="9pt" scales too (${small.note} → ${big.note})`)
      await p.keyboard.press('Escape')
      await p.locator('.settings-pop').waitFor({ state: 'hidden' }).catch(() => p.locator('.tp-close').click())
    })
  }

  await step('issue #21: picker sets the style of new highlights (remembered)', async () => {
    await selectParagraph(0)
    const picker = p.locator('.highlight-bar .hl-styles')
    await picker.getByRole('button', { name: '色块', exact: true }).waitFor()
    assert.equal(await picker.getByRole('button', { name: '色块', exact: true }).getAttribute('aria-pressed'), 'true')
    await picker.getByRole('button', { name: '波浪线', exact: true }).click()
    assert.equal(await picker.getByRole('button', { name: '波浪线', exact: true }).getAttribute('aria-pressed'), 'true')
    await shot('toolbar-squiggly')
    await p.locator('.highlight-bar .hl-color').nth(3).click()
    await p.locator('.highlight-bar').waitFor({ state: 'hidden' })

    await selectParagraph(2)
    assert.equal(await p.locator('.highlight-bar .hl-styles').getByRole('button', { name: '波浪线', exact: true }).getAttribute('aria-pressed'), 'true', 'last style is remembered')
    await p.locator('.highlight-bar .hl-styles').getByRole('button', { name: '下划线', exact: true }).click()
    await p.locator('.highlight-bar .hl-color').nth(2).click()
    await p.locator('.highlight-bar').waitFor({ state: 'hidden' })

    const saved = await storage((s, id) => s.listAnnotations(id))
    assert.deepEqual(saved.map(a => [a.color, a.style]).sort(), [['blue', 'underline'], ['red', 'squiggly']])
    const shapes = await overlayShapes()
    assert.ok(shapes.some(s => s.paths > 0), 'squiggly draws a path')
    assert.ok(shapes.some(s => s.paths === 0 && s.rects > 0 && s.height <= 3 && s.opacity === ''), 'underline draws thin opaque bars')
    await shot('drawn')
  })

  await step('issue #21: an existing highlight can be switched back to a marker', async () => {
    const target = await storage(async (s, id) => (await s.listAnnotations(id)).find(a => a.style === 'underline'))
    // 点划线 = foliate 的 show-annotation 事件
    await p.evaluate(cfi => {
      const view = document.querySelector('foliate-view')
      const doc = view.renderer.getContents()[0].doc
      const range = doc.createRange()
      range.selectNodeContents(doc.querySelectorAll('p.tx')[2])
      view.dispatchEvent(new CustomEvent('show-annotation', { detail: { value: cfi, index: 0, range } }))
    }, target.cfi)
    const scope = mobile ? p.locator('.highlight-bar') : p.locator('.annotation-pop')
    await scope.locator('.hl-styles').waitFor()
    assert.equal(await scope.locator('.hl-styles').getByRole('button', { name: '下划线', exact: true }).getAttribute('aria-pressed'), 'true')
    await scope.locator('.hl-styles').getByRole('button', { name: '色块', exact: true }).click()
    await p.waitForFunction(async id => {
      const s = await (await import('/src/storage/index.ts')).getStorage()
      const bookId = location.hash.split('/').at(-1).split('?')[0]
      return !(await s.listAnnotations(bookId)).find(a => a.id === id)?.style
    }, target.id)
    const shapes = await overlayShapes()
    assert.ok(shapes.some(s => s.opacity !== ''), 'marker highlight is drawn again')
    await shot('restyled')
  })

  assert.deepEqual(errors, [])
  console.log('ALL PASS', mobile ? 'app' : 'desktop')
} catch (e) {
  await shot('failure').catch(() => {})
  throw e
} finally {
  await browser.close()
}
