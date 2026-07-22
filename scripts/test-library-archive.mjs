/** LightRead OKF 藏书协议的定向端到端测试。 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { zipSync, unzipSync, strFromU8, strToU8 } from 'fflate'
import { parse } from 'yaml'
import { chromium } from 'playwright'

const port = 4177
const base = `http://127.0.0.1:${port}`
const temp = await mkdtemp(join(tmpdir(), 'lightread-okf-'))
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

function frontmatter(bytes) {
  const text = strFromU8(bytes).replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) throw new Error('缺少 YAML frontmatter')
  const end = text.indexOf('\n---\n', 4)
  if (end < 0) throw new Error('YAML frontmatter 未闭合')
  return parse(text.slice(4, end))
}

async function importArchive(context, archivePath) {
  const page = await context.newPage()
  await page.goto(`${base}/#/settings`, { waitUntil: 'networkidle' })
  await page.setInputFiles('input[accept=".okf.zip,.lightread,.zip"]', archivePath)
  await page.locator('.toast').waitFor({ timeout: 15_000 })
  return page
}

async function expectOneBook(page, title) {
  await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  await page.locator('.book-card').waitFor({ timeout: 10_000 })
  if (await page.locator('.book-card').count() !== 1) throw new Error(`${title}: 书籍数量错误`)
  if (!(await page.locator('.book-card').innerText()).includes(title)) {
    throw new Error(`${title}: 元数据未导入`)
  }
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
  if (!download.suggestedFilename().endsWith('.okf.zip')) {
    throw new Error(`导出扩展名错误: ${download.suggestedFilename()}`)
  }
  const archivePath = join(temp, 'library.okf.zip')
  await download.saveAs(archivePath)

  const archiveBytes = new Uint8Array(await readFile(archivePath))
  const entries = unzipSync(archiveBytes)
  if (!entries['manifest.json']) throw new Error('缺少同级 JSON 兼容清单')
  const compatibilityManifest = JSON.parse(strFromU8(entries['manifest.json']))
  if (compatibilityManifest.format !== 'org.lightread.library' || compatibilityManifest.version !== 2) {
    throw new Error('JSON 兼容清单格式错误')
  }
  if (compatibilityManifest.books?.length !== 1 || compatibilityManifest.annotations?.length !== 0) {
    throw new Error('JSON 兼容清单内容错误')
  }
  const root = frontmatter(entries['index.md'])
  if (root.okf_version !== '0.1') throw new Error('未声明 OKF v0.1')
  const bookConceptPath = Object.keys(entries)
    .find(path => /^books\/[^/]+\.md$/.test(path) && !path.endsWith('/index.md'))
  if (!bookConceptPath) throw new Error('缺少一书一 concept 的 OKF 文档')
  const bookConcept = frontmatter(entries[bookConceptPath])
  if (bookConcept.type !== 'Book' || bookConcept.entity !== 'book') {
    throw new Error('出版物 concept 缺少通用 OKF/Profile 类型')
  }
  if (!String(bookConcept.profile).includes('library-okf-profile.md')) {
    throw new Error('未声明公开的 Open Library OKF Profile')
  }
  const asset = bookConcept.file
  const content = entries[asset.path]
  const digest = createHash('sha256').update(content).digest('hex')
  if (asset.byte_length !== content.byteLength || asset.sha256 !== digest) {
    throw new Error('载荷长度或 SHA-256 错误')
  }

  // manifest 是可选兼容层：故意制造冲突，导入必须仍以 OKF concept 为准。
  compatibilityManifest.books[0].title = 'Manifest Must Not Win'
  const authorityPath = join(temp, 'okf-authoritative.zip')
  await writeFile(authorityPath, zipSync({
    ...entries,
    'manifest.json': strToU8(JSON.stringify(compatibilityManifest)),
  }, { level: 0 }))

  // 新环境导入，并验证重复导入不会产生第二本书。
  const targetContext = await browser.newContext()
  let targetPage = await importArchive(targetContext, authorityPath)
  if (!(await targetPage.locator('.toast.success').count())) {
    throw new Error(`OKF 导入失败: ${await targetPage.locator('.toast').innerText()}`)
  }
  await targetPage.close()
  targetPage = await importArchive(targetContext, authorityPath)
  if (!(await targetPage.locator('.toast.success').count())) throw new Error('OKF 重复导入失败')
  await expectOneBook(targetPage, 'archive-test')
  await targetContext.close()

  // 摘要被篡改时必须在写库前拒绝。
  const brokenEntries = unzipSync(archiveBytes)
  brokenEntries[asset.path] = new Uint8Array(brokenEntries[asset.path])
  brokenEntries[asset.path][0] ^= 0xff
  const brokenPath = join(temp, 'broken.okf.zip')
  await writeFile(brokenPath, zipSync(brokenEntries, { level: 0 }))
  const brokenContext = await browser.newContext()
  const brokenPage = await importArchive(brokenContext, brokenPath)
  if (!(await brokenPage.locator('.toast.error').count())) throw new Error('损坏包未被拒绝')
  await brokenPage.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
  if (await brokenPage.locator('.book-card').count() !== 0) throw new Error('损坏包发生了部分写入')
  await brokenContext.close()

  // 模拟其他软件生成的纯 OKF Publication：不含 LightRead Profile 或私有字段。
  const genericContent = strToU8('Generic OKF publication')
  const genericEntries = {
    'index.md': strToU8('---\nokf_version: "0.1"\n---\n\n# Publications\n\n* [Portable Book](publications/portable.md)\n'),
    'publications/portable.md': strToU8([
      '---',
      'type: Publication',
      'title: Portable Book',
      'description: Produced by another OKF application.',
      'resource: ../assets/portable.txt',
      'authors: [Open Author]',
      'language: en',
      'tags: [portable, open]',
      '---',
      '',
      '# Portable Book',
      '',
      'This concept intentionally contains no LightRead-specific profile.',
      '',
    ].join('\n')),
    'assets/portable.txt': genericContent,
  }
  const genericPath = join(temp, 'generic.okf.zip')
  await writeFile(genericPath, zipSync(genericEntries, { level: 0 }))
  const genericContext = await browser.newContext()
  const genericPage = await importArchive(genericContext, genericPath)
  if (!(await genericPage.locator('.toast.success').count())) {
    throw new Error(`第三方 OKF 导入失败: ${await genericPage.locator('.toast').innerText()}`)
  }
  await expectOneBook(genericPage, 'Portable Book')
  await genericContext.close()

  // 根据 OKF concept 构造旧 JSON v2，确认升级前的备份仍可导入。
  const legacyMeta = {
    id: bookConcept.id,
    title: bookConcept.title,
    author: bookConcept.authors.join(', '),
    format: asset.format,
    fileName: asset.name,
    description: bookConcept.description,
    language: bookConcept.language,
    tags: bookConcept.tags,
    addedAt: Date.parse(bookConcept.reading_state.added_at),
    hasCover: Boolean(bookConcept.cover),
    kind: bookConcept.collection === 'papers' ? 'paper' : 'book',
  }
  const legacyContent = {
    path: asset.path,
    mediaType: asset.media_type,
    byteLength: asset.byte_length,
    sha256: asset.sha256,
  }
  const legacyCover = bookConcept.cover && {
    path: bookConcept.cover.path,
    mediaType: bookConcept.cover.media_type,
    byteLength: bookConcept.cover.byte_length,
    sha256: bookConcept.cover.sha256,
  }
  const payloadEntries = {
    [asset.path]: entries[asset.path],
    ...(legacyCover ? { [legacyCover.path]: entries[legacyCover.path] } : {}),
  }
  const v2Path = join(temp, 'legacy-v2.zip')
  await writeFile(v2Path, zipSync({
    ...payloadEntries,
    'manifest.json': strToU8(JSON.stringify({
      format: 'org.lightread.library',
      version: 2,
      exportedAt: new Date().toISOString(),
      generator: { name: 'LightRead', version: '1.1.0' },
      books: [{ ...legacyMeta, content: legacyContent, cover: legacyCover }],
      annotations: [],
      sources: [],
    })),
  }, { level: 0 }))
  const v2Context = await browser.newContext()
  const v2Page = await importArchive(v2Context, v2Path)
  if (!(await v2Page.locator('.toast.success').count())) throw new Error('JSON v2 兼容导入失败')
  await expectOneBook(v2Page, 'archive-test')
  await v2Context.close()

  const v1Path = join(temp, 'legacy-v1.zip')
  await writeFile(v1Path, zipSync({
    ...payloadEntries,
    'manifest.json': strToU8(JSON.stringify({
      app: 'lightread',
      version: 1,
      exportedAt: Date.now(),
      books: [{
        ...legacyMeta,
        fileEntry: asset.path,
        coverEntry: legacyCover?.path,
      }],
      annotations: [],
      sources: [],
    })),
  }, { level: 0 }))
  const v1Context = await browser.newContext()
  const v1Page = await importArchive(v1Context, v1Path)
  if (!(await v1Page.locator('.toast.success').count())) throw new Error('JSON v1 兼容导入失败')
  await expectOneBook(v1Page, 'archive-test')
  await v1Context.close()

  await sourceContext.close()
  console.log('OKF 藏书协议测试通过：标准结构、可选兼容 manifest、OKF 权威优先、往返、第三方导入、幂等、完整性、JSON v1/v2 兼容')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await rm(temp, { recursive: true, force: true })
}
