// #26 / #27. Run against a built desktop or mobile UI with E2E_BASE.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { chromium } from 'playwright'

let browser
before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })

async function openBook(t, vertical) {
  const title = vertical ? '縦書きの本' : '页边距测试'
  const text = '庭に出ると、夜の雨が木の葉に残っていた。'.repeat(8)
  const body = Array.from({ length: 60 }, (_, i) => `<p id="p${i}">${i} ${text}</p>`).join('')
  const files = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'book.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">layout-${vertical}</dc:identifier><dc:title>${title}</dc:title><dc:language>ja</dc:language></metadata>
      <manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine${vertical ? ' page-progression-direction="rtl"' : ''}><itemref idref="a"/><itemref idref="b"/></spine></package>`),
  }
  for (const id of ['a', 'b']) {
    files[id + '.xhtml'] = strToU8(`<html xmlns="http://www.w3.org/1999/xhtml" lang="ja"><head><title>${id}</title>
      <style>${vertical ? 'html, body, .chapter { writing-mode: vertical-rl; }' : ''}</style></head>
      <body><section class="chapter">${body}</section></body></html>`)
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(async () => {
    await page.close()
    assert.deepEqual(errors, [])
  })
  page.setDefaultTimeout(10000)
  await page.goto((process.env.E2E_BASE ?? 'http://localhost:4173') + '/#/library')
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: title + '.epub', mimeType: 'application/epub+zip', buffer: Buffer.from(zipSync(files)),
  })
  await page.locator('.book-card', { hasText: title }).click()
  await page.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc?.querySelector('#p0'))
  await page.locator('.nav.next').waitFor({ state: 'attached' })
  await openTypography(page)
  return page
}

async function openTypography(page) {
  const peek = page.locator('.bar-peek.top')
  if (await peek.isVisible()) await peek.hover()
  const toolbar = page.getByTitle('排版设置', { exact: true })
  if (await toolbar.isVisible()) await toolbar.click()
  else await page.locator('.dock button', { hasText: '排版' }).click()
}

async function tab(page, name) {
  const button = page.getByRole('tab', { name, exact: true })
  if (await button.count()) await button.click()
}

test('#26 滚动时增大边距，正文两侧同时向内移动', async t => {
  const page = await openBook(t, false)
  for (const flow of ['按章滚动', '连续滚动']) {
    await tab(page, '页面')
    await page.getByRole('button', { name: flow, exact: true }).click()
    await tab(page, '文字')
    const bounds = []
    for (const value of ['2', '6', '16']) {
      await page.getByRole('slider', { name: '边距', exact: true }).fill(value)
      await page.waitForFunction(value => {
        const r = document.querySelector('foliate-view').renderer
        return r.getAttribute('gap') === value + '%' && r.getAttribute('flow') === 'scrolled'
      }, value)
      bounds.push(await page.evaluate(() => {
        const { doc } = document.querySelector('foliate-view').renderer.getContents()[0]
        const { left, right } = doc.querySelector('p').getBoundingClientRect()
        return { left, right }
      }))
    }
    assert.ok(bounds.slice(1).every((b, i) => b.left > bounds[i].left && b.right < bounds[i].right), flow + ' ' + JSON.stringify(bounds))
  }
})

async function expectWritingMode(page, mode, index) {
  await page.waitForFunction(({ mode, index }) => {
    const view = document.querySelector('foliate-view')
    const content = view?.renderer?.getContents?.().find(c => c.index === index)
    const p = content?.doc?.querySelector('p')
    const location = view?.lastLocation
    return location?.section?.current === index && p && location.range.startContainer.ownerDocument === content.doc
      && getComputedStyle(p).writingMode === mode
  }, { mode, index })
}

test('#27 竖排 EPUB 可切为横排、跨章、重开并恢复原书', async t => {
  const page = await openBook(t, true)
  await expectWritingMode(page, 'vertical-rl', 0)
  await page.evaluate(() => document.querySelector('foliate-view').goTo('a.xhtml#p30'))
  const anchor = await page.evaluate(() => {
    const { range } = document.querySelector('foliate-view').lastLocation
    const node = range.startContainer
    return (node.nodeType === 1 ? node : node.parentElement).closest('p')?.id
  })
  assert.ok(anchor && anchor !== 'p0', '已定位到章中段')
  await tab(page, '文字')
  const group = page.getByRole('group', { name: '书写方向' })
  await group.getByRole('button', { name: '横排', exact: true }).click()
  await expectWritingMode(page, 'horizontal-tb', 0)
  await page.waitForFunction(id => {
    const { range } = document.querySelector('foliate-view').lastLocation
    return range.intersectsNode(range.startContainer.ownerDocument.getElementById(id))
  }, anchor)
  await tab(page, '页面')
  await page.getByRole('button', { name: '连续滚动', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('foliate-view').renderer.continuous)
  await page.locator('.tp-close').click()
  await page.evaluate(() => document.querySelector('foliate-view').goTo(1))
  await expectWritingMode(page, 'horizontal-tb', 1)
  await page.evaluate(() => { location.hash = '#/library' })
  const book = page.locator('.book-card', { hasText: '縦書きの本' })
  await book.waitFor()
  await page.reload()
  await book.click()
  await expectWritingMode(page, 'horizontal-tb', 1)
  await openTypography(page)
  await tab(page, '文字')
  await group.getByRole('button', { name: '原书', exact: true }).click()
  await expectWritingMode(page, 'vertical-rl', 1)
  await page.waitForFunction(() => !document.querySelector('foliate-view').renderer.continuous)
  await group.getByRole('button', { name: '横排', exact: true }).click()
  await expectWritingMode(page, 'horizontal-tb', 1)
  await page.waitForFunction(() => document.querySelector('foliate-view').renderer.continuous)
})
