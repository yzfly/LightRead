// PDF 兼容性语料库回归测试
//
// 对 .corpus/ 下的所有 PDF, 用与应用完全相同的 pdf.js 配置 (直接 import
// src/services/importer.ts) 渲染第 1 页, 按结果分类:
//   ok       正常渲染且画布有内容
//   blank    渲染成功但整页空白 (疑似解码静默失败, 重点排查对象)
//   password 需要密码 (阅读器暂不支持, 单独统计)
//   invalid  pdf.js 判定文件损坏
//   error    渲染抛错
//   timeout  单文件超时
//
// 用法: node scripts/corpus/run.mjs [路径过滤子串] [--limit N]
// 报告: .corpus/report.json
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { readdirSync, statSync, createReadStream, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = new URL('../..', import.meta.url).pathname
const CORPUS = join(ROOT, '.corpus')
const FILTER = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : ''
const limitArg = process.argv.indexOf('--limit')
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity
const WORKERS = 6
const FILE_TIMEOUT = 20000

// 枚举语料 PDF
const pdfs = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (name.toLowerCase().endsWith('.pdf')) pdfs.push(p)
  }
}
walk(CORPUS)
const files = pdfs.filter(p => p.includes(FILTER)).slice(0, LIMIT)
console.log(`语料: ${files.length} 个 PDF (共 ${pdfs.length} 个)`)

// vite dev server: 提供应用源码模块 + /__corpus/<i> 提供语料文件
// (必须在 configureServer 里注册, 否则排在 SPA fallback 之后拿到的是 index.html)
const corpusServePlugin = {
  name: 'corpus-serve',
  configureServer(server) {
    server.middlewares.use('/__corpus', (req, res) => {
      const i = parseInt(req.url.slice(1), 10)
      if (!(i >= 0 && i < files.length)) { res.statusCode = 404; return res.end() }
      res.setHeader('Content-Type', 'application/pdf')
      createReadStream(files[i]).pipe(res)
    })
  },
}
const vite = await createServer({ server: { port: 0 }, logLevel: 'silent', plugins: [corpusServePlugin] })
await vite.listen()
const origin = vite.resolvedUrls.local[0]

const browser = await chromium.launch()

const PAGE_INIT = async (page) => {
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const mod = await import('/src/services/importer.ts')
    window.__pdfjs = await mod.initPdfjs()
    window.__opts = mod.pdfAssetOptions
  })
}

const checkInPage = async (page, idx) => {
  return await page.evaluate(async ({ idx, timeout }) => {
    const withTimeout = (p) => Promise.race([
      p, new Promise((_, rej) => setTimeout(() => rej(new Error('__timeout')), timeout)),
    ])
    let task
    try {
      const buf = await (await fetch(`/__corpus/${idx}`)).arrayBuffer()
      task = window.__pdfjs.getDocument({ data: buf, ...window.__opts })
      const pdf = await withTimeout(task.promise)
      const pg = await withTimeout(pdf.getPage(1))
      const vp = pg.getViewport({ scale: 1.5 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.min(2000, Math.floor(vp.width))
      canvas.height = Math.min(2000, Math.floor(vp.height))
      const ctx = canvas.getContext('2d')
      await withTimeout(pg.render({ canvas, canvasContext: ctx, viewport: vp }).promise)
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let nonWhite = 0, total = 0
      for (let i = 0; i < d.length; i += 16) {
        total++
        if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245 || d[i + 3] < 250) nonWhite++
      }
      const ratio = nonWhite / total
      await task.destroy()
      return { status: ratio > 0.0005 ? 'ok' : 'blank', ratio: +ratio.toFixed(5) }
    } catch (e) {
      try { await task?.destroy() } catch {}
      const name = e?.name ?? ''
      const msg = String(e?.message ?? e)
      if (msg === '__timeout') return { status: 'timeout' }
      if (name === 'PasswordException') return { status: 'password' }
      if (name === 'InvalidPDFException') return { status: 'invalid', msg }
      return { status: 'error', msg: `${name}: ${msg}`.slice(0, 200) }
    }
  }, { idx, timeout: FILE_TIMEOUT })
}

// 工作池
const results = new Array(files.length)
let cursor = 0, done = 0
const t0 = Date.now()
await Promise.all(Array.from({ length: WORKERS }, async () => {
  let page = await browser.newPage()
  await PAGE_INIT(page)
  while (true) {
    const idx = cursor++
    if (idx >= files.length) break
    try {
      results[idx] = await checkInPage(page, idx)
      // blank 重试一次, 排除偶发抖动
      if (results[idx].status === 'blank') results[idx] = await checkInPage(page, idx)
    } catch (e) {
      // 页面崩溃: 记录并重建页面
      results[idx] = { status: 'crash', msg: String(e.message).slice(0, 200) }
      try { await page.close() } catch {}
      page = await browser.newPage()
      await PAGE_INIT(page)
    }
    if (++done % 200 === 0) console.log(`  ${done}/${files.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  }
  await page.close()
}))
await browser.close()
await vite.close()

// blank 交叉验证: poppler (pdftoppm) 也渲染为空 → 文件本身空白, 放行;
// poppler 有内容而 pdf.js 空白 → 真问题 (blank_suspect)
const popplerBlankRatio = (file) => {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-'))
  try {
    execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-r', '36', '-gray', '-singlefile', file, join(dir, 'p')],
      { timeout: 15000, stdio: 'pipe' })
    const pgm = readFileSync(join(dir, 'p.pgm'))
    // P5 头: "P5\n<w> <h>\n<max>\n" 之后是灰度字节
    let pos = 0, fields = 0
    while (fields < 4 && pos < pgm.length) {
      while (pos < pgm.length && (pgm[pos] === 32 || pgm[pos] === 10 || pgm[pos] === 13 || pgm[pos] === 9)) pos++
      if (pgm[pos] === 35) { while (pgm[pos] !== 10) pos++; continue } // # 注释行
      while (pos < pgm.length && pgm[pos] > 32) pos++
      fields++
    }
    pos++
    let nonWhite = 0, total = 0
    for (let i = pos; i < pgm.length; i++) { total++; if (pgm[i] < 245) nonWhite++ }
    return total ? nonWhite / total : 0
  } catch {
    return null // poppler 打不开/超时
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
for (let i = 0; i < files.length; i++) {
  if (results[i]?.status !== 'blank') continue
  const base = popplerBlankRatio(files[i])
  results[i].popplerRatio = base === null ? 'n/a' : +base.toFixed(5)
  results[i].status = base !== null && base > 0.0005 ? 'blank_suspect' : 'blank_true'
}

// 汇总
const byStatus = {}
const report = files.map((f, i) => ({ file: relative(CORPUS, f), ...results[i] }))
for (const r of report) (byStatus[r.status] ??= []).push(r)
writeFileSync(join(CORPUS, 'report.json'), JSON.stringify(report, null, 1))

console.log(`\n=== 结果 (${((Date.now() - t0) / 1000).toFixed(0)}s) ===`)
for (const [s, list] of Object.entries(byStatus).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${s.padEnd(9)} ${String(list.length).padStart(5)}  (${(list.length / report.length * 100).toFixed(1)}%)`)
}
for (const s of ['crash', 'timeout', 'blank_suspect', 'error']) {
  const list = byStatus[s] ?? []
  if (!list.length) continue
  console.log(`\n--- ${s} 样例 (${list.length} 个, 最多列 10) ---`)
  for (const r of list.slice(0, 10)) console.log(`  ${r.file}${r.msg ? '  | ' + r.msg : ''}`)
}
console.log(`\n完整报告: .corpus/report.json`)
