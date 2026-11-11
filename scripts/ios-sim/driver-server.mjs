#!/usr/bin/env node
// iOS 模拟器验收的遥控端 (配合 src/services/e2eDriver.ts, 见 docs/testing/ios-simulator.md)。
//   node scripts/ios-sim/driver-server.mjs [端口=4599] [样书目录=.]
// 应用内: GET /next 取下一段脚本 (长轮询), POST /result 回结果, GET /files/<名字> 取样书。
// 操作端: POST /run (正文是脚本, 可用 h.click / h.wait / h.importBook …) 等到结果再返回。
// 只监听回环地址: 模拟器与宿主机共用网络, 不对外暴露。
import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const port = Number(process.argv[2] ?? 4599)
const files = resolve(process.argv[3] ?? '.')
const queue = []          // 等应用来取的脚本
const waiting = []        // 应用挂着的长轮询
const pending = new Map() // id → 操作端的响应
let nextId = 1

const body = req => new Promise(done => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => done(Buffer.concat(chunks).toString('utf8'))) })
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

function dispatch() {
  while (queue.length && waiting.length) json(waiting.shift(), 200, queue.shift())
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (req.method === 'GET' && url.pathname === '/next') {
    waiting.push(res)
    setTimeout(() => { const i = waiting.indexOf(res); if (i >= 0) { waiting.splice(i, 1); res.writeHead(204).end() } }, 20_000)
    return dispatch()
  }
  if (req.method === 'POST' && url.pathname === '/result') {
    const result = JSON.parse(await body(req))
    const client = pending.get(result.id)
    pending.delete(result.id)
    if (client) json(client, 200, result)
    return res.writeHead(204).end()
  }
  if (req.method === 'POST' && url.pathname === '/run') {
    const id = nextId++
    const timeout = Number(url.searchParams.get('timeout') ?? 60_000)
    pending.set(id, res)
    queue.push({ id, code: await body(req) })
    setTimeout(() => { if (pending.delete(id)) json(res, 504, { id, ok: false, error: 'app did not answer in time' }) }, timeout)
    return dispatch()
  }
  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    const file = join(files, basename(decodeURIComponent(url.pathname.slice(7))))
    if (!existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end()
    res.writeHead(200, { 'content-length': statSync(file).size })
    return createReadStream(file).pipe(res)
  }
  res.writeHead(404).end()
}).listen(port, '127.0.0.1', () => console.log(`ios-sim driver: http://127.0.0.1:${port}  files: ${files}`))
