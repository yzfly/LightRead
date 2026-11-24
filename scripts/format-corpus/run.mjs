// 格式兼容语料回归 (发版关卡): 每本书在全新的浏览器上下文里走读者的路径
//   选文件导入 → 书架出现书卡 (书名 / 作者 / 封面) → 打开 → 正文有字 / 图片都加载 / 目录 / 跳到某章看到指定文字;
//   PDF、DjVu 看页数与首页是否画出内容。
// 用法: npm run test:format-corpus [-- 书的 id 子串]
//   E2E_BASE 指向已起的预览 (否则自己构建网页版到 dist/ 再起 vite preview)
//   报告与失败截图写到 <语料目录>/report/
// manifest 里写了 known 的条目是已知问题: 失败只记录, 不拦发版; 但它通过了就拦下, 提醒删掉 known。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { CORPUS_DIR, entryPath, fetchCorpus } from './fetch.mjs'

const FILTER = process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? ''
const WORKERS = Number(process.env.CORPUS_WORKERS || 3)
const BOOK_TIMEOUT = 90_000
const REPORT_DIR = join(CORPUS_DIR, 'report')

const manifest = await fetchCorpus({ log: () => {} })
const books = manifest.books.filter(book => book.id.includes(FILTER))
rmSync(REPORT_DIR, { recursive: true, force: true })
mkdirSync(REPORT_DIR, { recursive: true })

// 自己重新构建网页版 (桌面界面) 到 dist/ 再起预览: 不信任 dist/ 里现有的东西 (App 打包后是手机界面);
// App 打包脚本先跑本测试, 之后 tauri build 会重新生成 dist/
let preview
let base = process.env.E2E_BASE
if (!base) {
  const env = { ...process.env }
  delete env.TAURI_ENV_PLATFORM
  delete env.LIGHTREAD_UI
  const build = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: 'inherit', env })
  if (build.status !== 0) throw new Error('网页版构建失败')
  const port = 4300 + Math.floor(Math.random() * 500)
  preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore', env })
  base = `http://localhost:${port}`
  for (let i = 0; ; i++) {
    try { if ((await fetch(base)).ok) break } catch {}
    if (i > 60) throw new Error('vite preview 没起来')
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

const browser = await chromium.launch()

/** 画布上非白像素的比例: 0 表示整页空白 (解码静默失败) */
const inkRatio = canvasSelector => `(() => {
  const canvas = document.querySelector(${JSON.stringify(canvasSelector)})
  if (!canvas || !canvas.width) return 0
  const probe = document.createElement('canvas')
  probe.width = 200; probe.height = Math.max(1, Math.round(200 * canvas.height / canvas.width))
  const ctx = probe.getContext('2d')
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height)
  const d = ctx.getImageData(0, 0, probe.width, probe.height).data
  let ink = 0
  for (let i = 0; i < d.length; i += 4) if (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235) ink++
  return ink / (d.length / 4)
})()`

/** foliate 当前渲染出的各个文档: 文字与图片加载情况 (图片等加载结束再判断) */
async function renderedDocs(page) {
  return page.evaluate(async () => {
    const view = document.querySelector('foliate-view')
    const contents = view?.renderer?.getContents?.() ?? []
    const out = []
    const settle = img => img.complete ? null : new Promise(resolve => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 8000) })
    for (const { doc } of contents) {
      if (!doc) continue
      const images = [...doc.images]
      await Promise.all(images.map(settle))
      const broken = images.filter(img => img.naturalWidth === 0).map(img => (img.getAttribute('alt') || img.getAttribute('src') || '').slice(0, 60))
      // SVG 里的 <image> (封面常见) 没有加载状态可读: 用同一地址另开一张图试加载
      const svgImages = [...doc.querySelectorAll('image')]
      for (const node of svgImages) {
        const href = node.getAttribute('href') ?? node.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        if (!href) continue
        const probe = new Image()
        probe.src = new URL(href, doc.baseURI).href
        await settle(probe)
        if (!probe.naturalWidth) broken.push(`svg:${href.slice(-50)}`)
      }
      out.push({
        // 软连字符、不换行空格等不影响读者看到的字, 比对前统一掉
        text: (doc.body?.innerText ?? '').replace(/­/g, '').replace(/\s+/g, ' '),
        images: images.length + svgImages.length,
        broken,
      })
    }
    return out
  })
}

async function checkBook(book) {
  const expect = book.expect
  const problems = []
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message.split('\n')[0].slice(0, 160)))
  const facts = {}
  try {
    await page.goto(base + '/', { waitUntil: 'networkidle' })
    await page.waitForSelector('text=书架还是空的', { timeout: 15_000 })
    await page.setInputFiles('input[type=file][multiple]', entryPath(book))
    const card = page.locator('.book-card').first()
    try {
      await card.waitFor({ timeout: 60_000 })
    } catch {
      const toast = await page.locator('.toast').allTextContents()
      throw new Error(`导入后书架没有出现这本书${toast.length ? `: ${toast.join(' / ')}` : ''}`)
    }
    await page.waitForTimeout(800)
    facts.card = (await card.innerText()).replace(/\s+/g, ' ').trim()
    if (expect.title && !facts.card.includes(expect.title)) problems.push(`书名应为「${expect.title}」, 书卡显示「${facts.card}」`)
    if (expect.author && !facts.card.includes(expect.author)) problems.push(`作者应为「${expect.author}」, 书卡显示「${facts.card}」`)
    if (expect.cover) {
      const cover = await card.locator('.cover img').evaluate(img => img.complete && img.naturalWidth > 0).catch(() => false)
      if (!cover) problems.push('书卡没有封面图 (只有文字封面)')
    }

    await card.click()
    const kind = await Promise.race([
      page.waitForSelector('foliate-view', { timeout: 45_000 }).then(() => 'foliate'),
      page.waitForSelector('.p-holder canvas', { timeout: 45_000 }).then(() => 'pdf'),
      page.waitForSelector('.page-host canvas', { timeout: 45_000 }).then(() => 'djvu'),
    ]).catch(() => null)
    if (!kind) {
      const toast = await page.locator('.toast').allTextContents()
      throw new Error(`打开后没有进入阅读页${toast.length ? `: ${toast.join(' / ')}` : ''}`)
    }
    facts.reader = kind

    if (kind === 'foliate') {
      await page.waitForFunction(() => (document.querySelector('foliate-view')?.renderer?.getContents?.() ?? []).some(c => c.doc?.body), null, { timeout: 30_000 })
      await page.waitForTimeout(1200)
      const first = await renderedDocs(page)
      const firstText = first.map(d => d.text).join('').trim()
      const firstImages = first.reduce((n, d) => n + d.images, 0)
      if (!firstText && !firstImages) problems.push('打开后第一页什么都没有')
      const broken = first.flatMap(d => d.broken)
      facts.toc = await page.evaluate(() => {
        const flat = items => (items ?? []).flatMap(item => [item, ...flat(item.subitems)])
        return flat(document.querySelector('foliate-view')?.book?.toc).map(item => ({ label: (item.label ?? '').trim(), href: item.href }))
      })
      if (expect.toc && facts.toc.length < expect.toc) problems.push(`目录只有 ${facts.toc.length} 项, 应至少 ${expect.toc} 项`)
      if (expect.text) {
        let docs = first
        if (expect.chapter) {
          const target = facts.toc.find(item => item.label === expect.chapter) ?? facts.toc.find(item => item.label.includes(expect.chapter))
          if (!target) problems.push(`目录里找不到「${expect.chapter}」`)
          else {
            await page.evaluate(href => document.querySelector('foliate-view').goTo(href), target.href)
            await page.waitForTimeout(1500)
            docs = await renderedDocs(page)
            broken.push(...docs.flatMap(d => d.broken))
          }
        } else if (!firstText.includes(expect.text)) {
          // 没指定章节: 往后翻几页找
          for (let i = 0; i < 6 && !docs.some(d => d.text.includes(expect.text)); i++) {
            await page.evaluate(() => document.querySelector('foliate-view').next())
            await page.waitForTimeout(700)
            docs = await renderedDocs(page)
            broken.push(...docs.flatMap(d => d.broken))
          }
        }
        if (!docs.some(d => d.text.includes(expect.text))) problems.push(`正文里找不到「${expect.text}」`)
      }
      if (expect.images) {
        const unique = [...new Set(broken)]
        if (unique.length) problems.push(`有 ${unique.length} 张图片加载失败: ${unique.slice(0, 4).join(' | ')}`)
        if (!firstImages && !(await renderedDocs(page)).some(d => d.images)) problems.push('应有图片, 但页面里一张都没有')
      }
    } else {
      const canvas = kind === 'pdf' ? '.p-holder canvas' : '.page-host canvas'
      await page.waitForTimeout(2500)
      facts.ink = await page.evaluate(inkRatio(canvas))
      if (expect.render && !(facts.ink > 0.002)) problems.push(`首页画布是空白的 (非白像素 ${(facts.ink * 100).toFixed(2)}%)`)
      facts.pages = await page.evaluate(() => {
        const match = document.body.innerText.match(/\/\s*(\d+)/)
        return match ? Number(match[1]) : 0
      })
      if (expect.pages && facts.pages < expect.pages) problems.push(`页数 ${facts.pages}, 应至少 ${expect.pages}`)
    }
  } catch (error) {
    problems.push(error.message.split('\n')[0])
  }
  if (pageErrors.length) problems.push(`页面报错: ${[...new Set(pageErrors)].slice(0, 3).join(' | ')}`)
  if (problems.length) await page.screenshot({ path: join(REPORT_DIR, `${book.id}.png`) }).catch(() => {})
  await context.close()
  return { id: book.id, format: book.file.split('.').pop(), covers: book.covers, problems, facts }
}

const results = []
const queue = [...books]
const startedAt = Date.now()
await Promise.all(Array.from({ length: Math.min(WORKERS, queue.length) }, async () => {
  for (let book = queue.shift(); book; book = queue.shift()) {
    const result = await Promise.race([
      checkBook(book),
      new Promise(resolve => setTimeout(() => resolve({ id: book.id, problems: ['超时'], facts: {} }), BOOK_TIMEOUT)),
    ])
    result.known = book.known
    result.status = result.problems.length ? (book.known ? 'known' : 'fail') : (book.known ? 'fixed' : 'pass')
    results.push(result)
    const mark = { pass: '✓', known: '·', fail: '✗', fixed: '!' }[result.status]
    console.log(`${mark} ${book.id}${result.problems.length ? ` — ${result.problems.join('; ')}` : ''}${book.known ? ` [已知: ${book.known}]` : ''}`)
  }
}))
await browser.close()
preview?.kill()

results.sort((a, b) => a.id.localeCompare(b.id))
writeFileSync(join(REPORT_DIR, 'report.json'), JSON.stringify({ base, at: new Date().toISOString(), seconds: Math.round((Date.now() - startedAt) / 1000), results }, null, 2))
const count = status => results.filter(r => r.status === status).length
console.log(`\n${results.length} 本: 通过 ${count('pass')}, 已知问题 ${count('known')}, 失败 ${count('fail')}, 已修好待删 known ${count('fixed')}  (${Math.round((Date.now() - startedAt) / 1000)} 秒, 报告 ${REPORT_DIR})`)
if (count('fixed')) console.log('有已知问题的书现在通过了: 去 manifest.json 删掉它的 known, 让它从此受关卡保护')
process.exit(count('fail') || count('fixed') ? 1 : 0)
