// 调试单个语料文件: 渲染并输出 pdf.js 的全部控制台消息
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { createReadStream } from 'node:fs'

const FILE = process.argv[2]
const plugin = {
  name: 'corpus-serve',
  configureServer(server) {
    server.middlewares.use('/__one', (req, res) => {
      res.setHeader('Content-Type', 'application/pdf')
      createReadStream(FILE).pipe(res)
    })
  },
}
const vite = await createServer({ server: { port: 0 }, logLevel: 'silent', plugins: [plugin] })
await vite.listen()
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', m => console.log(`[${m.type()}]`, m.text().slice(0, 300)))
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 300)))
await page.goto(vite.resolvedUrls.local[0], { waitUntil: 'domcontentloaded' })
const out = await page.evaluate(async () => {
  const mod = await import('/src/services/importer.ts')
  const pdfjs = await mod.initPdfjs()
  pdfjs.setVerbosityLevel?.(5) // 显示 warning
  const buf = await (await fetch('/__one')).arrayBuffer()
  const task = pdfjs.getDocument({ data: buf, ...mod.pdfAssetOptions, verbosity: 5 })
  const pdf = await task.promise
  const pg = await pdf.getPage(1)
  const vp = pg.getViewport({ scale: 1.5 })
  const canvas = document.createElement('canvas')
  canvas.width = vp.width; canvas.height = vp.height
  const ctx = canvas.getContext('2d')
  await pg.render({ canvas, canvasContext: ctx, viewport: vp }).promise
  const ops = await pg.getOperatorList()
  const text = await pg.getTextContent()
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let nonWhite = 0, total = 0
  for (let i = 0; i < d.length; i += 16) { total++; if (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245) nonWhite++ }
  return { ratio: nonWhite / total, opsCount: ops.fnArray.length, textItems: text.items.length,
    textSample: text.items.slice(0, 3).map(t => t.str).join(' ') }
})
console.log(JSON.stringify(out, null, 2))
await browser.close(); await vite.close()
