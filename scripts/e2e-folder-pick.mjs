/** 选择文件夹: 添加书籍 + 上传到私人书库 (浏览器端到端).
 * 先构建并起预览: npm run build && npx vite preview --port 4173 --strictPort
 * 再跑: E2E_BASE=http://localhost:4173 node scripts/e2e-folder-pick.mjs
 * 文件夹用 Playwright 的目录上传 (webkitdirectory 输入框) 模拟。
 */
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { zipSync, strToU8 } from 'fflate'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const base = process.env.E2E_BASE ?? 'http://localhost:4173'
const tmp = '/tmp/lightread-folder-pick'
rmSync(tmp, { recursive: true, force: true })

const epub = title => Buffer.from(zipSync({
  mimetype: [strToU8('application/epub+zip'), { level: 0 }],
  'META-INF/container.xml': strToU8('<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
  'OEBPS/package.opf': strToU8(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">${encodeURIComponent(title)}</dc:identifier><dc:title>${title}</dc:title><dc:creator>目录测试</dc:creator><dc:language>zh</dc:language><meta property="dcterms:modified">2026-10-07T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>`),
  'OEBPS/nav.xhtml': strToU8('<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">第一章</a></li></ol></nav></body></html>'),
  'OEBPS/chapter.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>正文</title></head><body><h1>${title}</h1><p>正文</p></body></html>`),
}))
const junk = (label, size = 4096) => { const b = Buffer.alloc(size, 0x20); b.write(label); return b }
function writeTree(root, files) {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), data)
  }
}

// 添加书籍用的文件夹: 三种格式的同一本书 + 「(1)」+ 隐藏文件 + TXT + 分卷 + 不支持的图片
const importDir = join(tmp, '我的书')
writeTree(importDir, {
  'book.epub': epub('目录书 EPUB'),
  'book.mobi': junk('MOBI'),
  'sub/book.pdf': junk('%PDF-1.4'),
  'other (1).epub': epub('另一本书'),
  '.hidden.epub': epub('隐藏的书'),
  'notes.txt': Buffer.from('读书笔记\n\n第一段文字。'),
  '分卷/卷1.epub': epub('分卷 卷1'),
  '分卷/卷2.epub': epub('分卷 卷2'),
  'sub/cover.jpg': junk('JPEG'),
})
// 上传用的文件夹: 书库只收 EPUB/PDF/AZW/AZW3, 单本上限 1 MB
const uploadDir = join(tmp, '待上传')
writeTree(uploadDir, {
  'a.epub': epub('上传 A'),
  'a.azw3': junk('BOOKMOBI'),
  'big.pdf': junk('%PDF-1.4', 2 * 1024 * 1024),
  'notes.txt': Buffer.from('不支持'),
  'sub/卷3.epub': epub('上传 卷3'),
})

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
const page = await context.newPage()
page.setDefaultTimeout(15_000)
const errors = [], uploads = []
page.on('pageerror', error => errors.push(error.message))
await context.route('https://api.github.com/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tag_name: 'v0.0.0', assets: [] }) }))
await context.route('**/__folder_e2e/**', async route => {
  const req = route.request(), path = new URL(req.url()).pathname
  if (path.endsWith('/opds')) return route.fulfill({ contentType: 'application/atom+xml', body: '<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:lightread:folder-e2e</id><title>Folder</title><updated>2026-10-07T00:00:00Z</updated><link rel="self" href="opds" type="application/atom+xml;profile=opds-catalog"/><link rel="https://lightread.app/rel/library" href="capabilities"/><link rel="https://lightread.app/rel/upload" href="upload"/></feed>' })
  if (path.endsWith('/capabilities')) return route.fulfill({ json: { version: 1, uploadUrl: 'upload', formats: ['epub', 'pdf', 'azw', 'azw3'], maxFileBytes: 1024 * 1024 } })
  if (path.endsWith('/upload') && req.method() === 'POST') {
    const name = decodeURIComponent(req.headers()['x-file-name'])
    uploads.push({ name, size: req.postDataBuffer()?.length ?? 0 })
    return route.fulfill({ json: { bookId: name, title: name, format: name.split('.').pop(), duplicate: false } })
  }
  return route.fulfill({ status: 404, body: 'not found' })
})

const folderDialog = page.getByRole('dialog', { name: /从文件夹添加/ })
try {
  await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  // 入口: 「添加书籍」旁的菜单和空书架都有「选择文件夹…」
  await page.getByRole('button', { name: '选择文件夹…', exact: true }).waitFor()
  await page.locator('.import-caret').click()
  await page.getByRole('menuitem', { name: '选择文件夹…' }).waitFor()
  await page.locator('.import-caret').click()
  assert.equal(await page.locator('input[type=file][multiple]').count(), 1, 'folder input must not match the e2e file-input selector')

  await page.locator('header input[data-folder-input]').setInputFiles(importDir)
  await folderDialog.waitFor()
  assert.equal(await folderDialog.locator('.folder-name').innerText(), '我的书')
  assert.equal(await folderDialog.locator('.folder-summary').innerText(), '找到 5 本书（另有 2 个重复格式已跳过、1 个不支持的文件）')
  await folderDialog.getByText('将添加的书（5）').click()
  assert.deepEqual(await folderDialog.locator('.folder-selected .folder-path').allInnerTexts(),
    ['book.epub', 'notes.txt', 'other (1).epub', '分卷/卷1.epub', '分卷/卷2.epub'])
  await folderDialog.getByText('跳过的重复格式（2）').click()
  assert.equal(await folderDialog.locator('.folder-duplicates strong').innerText(), 'book.epub')
  assert.equal(await folderDialog.locator('.folder-duplicates small').innerText(), '跳过：book.mobi、sub/book.pdf')
  assert.equal(await folderDialog.getByRole('checkbox', { name: '按文件夹建立书单' }).isChecked(), true)
  await page.screenshot({ path: `${tmp}/import-summary.png` })
  await folderDialog.getByRole('button', { name: '添加 5 本', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 5, null, { timeout: 45_000 })
  const titles = (await page.locator('.book-card').allInnerTexts()).join('\n')
  for (const title of ['目录书 EPUB', '另一本书', '分卷 卷1', '分卷 卷2']) assert.ok(titles.includes(title), `missing ${title}`)
  assert.ok(!titles.includes('隐藏的书'), 'hidden files must not be imported')
  console.log('PASS folder import: format dedupe, hidden/unsupported filtering, volumes kept, 5 books imported')
  const nestedList = page.locator('.booklist-chip').filter({ hasText: '我的书/分卷' })
  await nestedList.waitFor()
  await nestedList.click()
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 2)
  assert.match((await page.locator('.book-card').allInnerTexts()).join(' '), /分卷 卷1/)
  await page.locator('.booklist-chip').filter({ hasText: /^全部藏书/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 5)
  await page.reload({ waitUntil: 'networkidle' })
  await page.locator('.booklist-chip').filter({ hasText: '我的书/分卷' }).waitFor()
  assert.equal(await page.locator('.booklist-chip').filter({ hasText: '我的书' }).count(), 2)
  console.log('PASS folder paths become persistent, filterable booklists')


  // 再选一次同一个文件夹: 已在藏书里的不重复导入
  await page.locator('header input[data-folder-input]').setInputFiles(importDir)
  await folderDialog.waitFor()
  assert.equal(await folderDialog.locator('.folder-summary').innerText(), '找到 0 本书（另有 2 个重复格式已跳过、1 个不支持的文件、5 本已在藏书中）')
  assert.equal(await folderDialog.getByRole('button', { name: '添加 0 本', exact: true }).isDisabled(), true)
  await folderDialog.getByRole('button', { name: '取消', exact: true }).click()
  await folderDialog.waitFor({ state: 'detached' })
  assert.equal(await page.locator('.book-card').count(), 5)
  console.log('PASS re-picking the same folder skips books already in the library')

  // 取消分类仍能导入书籍, 不额外创建书单。
  const flatDir = join(tmp, '不分类')
  writeTree(flatDir, { 'extra.epub': epub('取消分类的书') })
  await page.locator('header input[data-folder-input]').setInputFiles(flatDir)
  await folderDialog.waitFor()
  await folderDialog.getByRole('checkbox', { name: '按文件夹建立书单' }).uncheck()
  await folderDialog.getByRole('button', { name: '添加 1 本', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 6)
  await page.locator('.import-bar').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.booklist-chip').filter({ hasText: '不分类' }).count(), 0)
  console.log('PASS folder booklists can be disabled')

  // 上传到私人书库
  await page.goto(`${base}/#/catalogs`, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '添加书源' }).click()
  await page.locator('#src-name').fill('目录E2E书库')
  await page.locator('#src-url').fill(`${new URL(base).origin}/__folder_e2e/opds`)
  await page.locator('.modal .btn-primary').click()
  await page.locator('.source-card', { hasText: '目录E2E书库' }).waitFor()
  await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  await page.locator('.import-caret').click()
  await page.getByRole('menuitem', { name: '加入私人书库' }).click()
  const uploadDialog = page.getByRole('dialog', { name: '添加到私人书库' })
  await uploadDialog.waitFor()
  await uploadDialog.locator('.upload-field .app-select-trigger').click()
  await page.locator('.app-select-option', { hasText: '目录E2E书库' }).click()
  await uploadDialog.locator('.upload-device input').waitFor({ state: 'attached' })
  assert.equal(await uploadDialog.locator('input[type=file]').count(), 1, 'dialog keeps exactly one file input')
  await uploadDialog.getByRole('checkbox', { name: /上传前转换为 EPUB/ }).uncheck()
  await uploadDialog.getByRole('button', { name: '选择文件夹…', exact: true }).waitFor()
  await page.locator('.upload-overlay > input[data-folder-input]').setInputFiles(uploadDir)
  await folderDialog.waitFor()
  assert.equal(await folderDialog.locator('.folder-summary').innerText(), '找到 2 本书（另有 1 个重复格式已跳过、1 个不支持的文件、1 个超过 1 MB）')
  assert.equal(await folderDialog.getByRole('checkbox', { name: '按文件夹建立书单' }).count(), 0)
  await folderDialog.getByText('超过大小上限（1）').click()
  assert.match(await folderDialog.locator('.folder-oversize li').innerText(), /big\.pdf\s+2\.0 MB/)
  await page.screenshot({ path: `${tmp}/upload-summary.png` })
  await folderDialog.getByRole('button', { name: '上传 2 本', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.upload-task .upload-success').length === 2, null, { timeout: 30_000 })
  assert.deepEqual(uploads.map(u => u.name).sort(), ['a.epub', '卷3.epub'])
  assert.match(await uploadDialog.locator('.upload-task').innerText(), /sub\/卷3\.epub/)
  console.log('PASS folder upload: only supported, deduped, within-limit books are enqueued in the background task')

  // 手机 (Android / iOS) 选不了文件夹: 不显示入口
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', userAgent: 'Mozilla/5.0 (Linux; Android 14; K70) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' })
  const phone = await mobile.newPage()
  await phone.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  await phone.getByText('书架还是空的').waitFor()
  assert.equal(await phone.getByRole('button', { name: '选择文件夹…' }).count(), 0)
  assert.equal(await phone.locator('input[data-folder-input]').count(), 0)
  await mobile.close()
  console.log('PASS folder entry hidden on Android')
  assert.deepEqual(errors, [])
  console.log(`PASS all folder-pick assertions; screenshots: ${tmp}`)
} catch (error) {
  await page.screenshot({ path: `${tmp}/failure.png`, fullPage: true }).catch(() => {})
  console.error('FAIL', error)
  console.error('Page errors:', errors)
  process.exitCode = 1
} finally { await browser.close() }
