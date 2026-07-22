/** LightRead 藏书交换包的定向端到端测试。 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate'
import { chromium } from 'playwright'

const port = 4177
const base = `http://127.0.0.1:${port}`
const temp = await mkdtemp(join(tmpdir(), 'lightread-archive-'))
const server = spawn(
  'npm',
  ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(base)
      if (response.ok) return
    } catch { /* Vite 尚未监听 */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Vite 启动超时')
}

async function importArchive(context, archivePath) {
  const page = await context.newPage()
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' })
  await page.setInputFiles('input[accept=".lightread,.zip"]', archivePath)
  await page.locator('.toast').waitFor({ timeout: 15_000 })
  return page
}

let browser
try {
  await waitForServer()
  browser = await chromium.launch({ headless: true })

  const sourceContext = await browser.newContext()
  const sourcePage = await sourceContext.newPage()
  await sourcePage.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  await sourcePage.setInputFiles('input[type="file"]', {
    name: 'archive-test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('# 藏书包测试\n\n这是正文。', 'utf8'),
  })
  await sourcePage.locator('.toast.success').waitFor({ timeout: 15_000 })
  await sourcePage.goto(`${base}/#/settings`, { waitUntil: 'networkidle' })

  const downloadPromise = sourcePage.waitForEvent('download')
  await sourcePage.getByRole('button', { name: '导出藏书包' }).click()
  const download = await downloadPromise
  if (!download.suggestedFilename().endsWith('.lightread')) {
    throw new Error(`导出扩展名错误: ${download.suggestedFilename()}`)
  }
  const archivePath = join(temp, 'library.lightread')
  await download.saveAs(archivePath)

  const archiveBytes = new Uint8Array(await readFile(archivePath))
  const entries = unzipSync(archiveBytes)
  const manifest = JSON.parse(strFromU8(entries['manifest.json']))
  if (manifest.format !== 'org.lightread.library' || manifest.version !== 2) {
    throw new Error('v2 格式标识或版本错误')
  }
  if (manifest.books.length !== 1) throw new Error('导出书籍数量错误')
  const asset = manifest.books[0].content
  const content = entries[asset.path]
  const digest = createHash('sha256').update(content).digest('hex')
  if (asset.byteLength !== content.byteLength || asset.sha256 !== digest) {
    throw new Error('载荷长度或 SHA-256 错误')
  }

  // 新环境导入，并验证重复导入不会产生第二本书。
  const targetContext = await browser.newContext()
  let targetPage = await importArchive(targetContext, archivePath)
  if (!(await targetPage.locator('.toast.success').count())) {
    throw new Error(`v2 导入失败: ${await targetPage.locator('.toast').innerText()}`)
  }
  await targetPage.close()
  targetPage = await importArchive(targetContext, archivePath)
  if (!(await targetPage.locator('.toast.success').count())) throw new Error('v2 重复导入失败')
  await targetPage.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  await targetPage.locator('.book-card').waitFor({ timeout: 10_000 })
  if (await targetPage.locator('.book-card').count() !== 1) throw new Error('重复导入不幂等')
  await targetContext.close()

  // 摘要被篡改时必须在写库前拒绝。
  const brokenEntries = unzipSync(archiveBytes)
  brokenEntries[asset.path] = new Uint8Array(brokenEntries[asset.path])
  brokenEntries[asset.path][0] ^= 0xff
  const brokenPath = join(temp, 'broken.lightread')
  await writeFile(brokenPath, zipSync(brokenEntries, { level: 0 }))
  const brokenContext = await browser.newContext()
  const brokenPage = await importArchive(brokenContext, brokenPath)
  if (!(await brokenPage.locator('.toast.error').count())) throw new Error('损坏包未被拒绝')
  await brokenPage.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  if (await brokenPage.locator('.book-card').count() !== 0) throw new Error('损坏包发生了部分写入')
  await brokenContext.close()

  // 把同一份载荷改写成 v1 manifest，确认旧备份仍可导入。
  const legacyEntries = unzipSync(archiveBytes)
  const legacyBooks = manifest.books.map(book => {
    const { content: bookContent, cover, ...meta } = book
    return {
      ...meta,
      fileEntry: bookContent.path,
      coverEntry: cover?.path,
    }
  })
  legacyEntries['manifest.json'] = strToU8(JSON.stringify({
    app: 'lightread',
    version: 1,
    exportedAt: Date.now(),
    books: legacyBooks,
    annotations: manifest.annotations,
    sources: manifest.sources,
  }))
  const legacyPath = join(temp, 'legacy.zip')
  await writeFile(legacyPath, zipSync(legacyEntries, { level: 0 }))
  const legacyContext = await browser.newContext()
  const legacyPage = await importArchive(legacyContext, legacyPath)
  if (!(await legacyPage.locator('.toast.success').count())) throw new Error('v1 兼容导入失败')
  await legacyPage.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  await legacyPage.locator('.book-card').waitFor({ timeout: 10_000 })
  if (await legacyPage.locator('.book-card').count() !== 1) throw new Error('v1 恢复数量错误')
  await legacyContext.close()

  await sourceContext.close()
  console.log('藏书交换包测试通过：v2 导出/导入、幂等、完整性校验、v1 兼容')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await rm(temp, { recursive: true, force: true })
}
