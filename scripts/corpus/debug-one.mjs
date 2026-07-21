// 调试单个语料文件：用应用同款 MuPDF 渲染并输出全部控制台消息
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
  const mod = await import('/src/services/mupdf.ts')
  const mupdf = await mod.initMupdf()
  const buf = await (await fetch('/__one')).arrayBuffer()
  const doc = mupdf.Document.openDocument(new Uint8Array(buf), 'application/pdf')
  const pdfPage = doc.loadPage(0)
  const pixmap = pdfPage.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true)
  const d = pixmap.getPixels()
  let nonWhite = 0, total = 0
  for (let i = 0; i < d.length; i += 12) { total++; if (d[i] < 245 || d[i+1] < 245 || d[i+2] < 245) nonWhite++ }
  const result = { ratio: nonWhite / total, width: pixmap.getWidth(), height: pixmap.getHeight() }
  pixmap.destroy(); pdfPage.destroy(); doc.destroy()
  return result
})
console.log(JSON.stringify(out, null, 2))
await browser.close(); await vite.close()
