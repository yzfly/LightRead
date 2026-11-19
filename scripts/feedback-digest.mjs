#!/usr/bin/env node
// 拉取读者反馈 (应用内「反馈问题或建议」), 按类型列出, 供每三天一次的集中查看。
//   node scripts/feedback-digest.mjs                 # 列出状态为「新的」的反馈 (Markdown)
//   node scripts/feedback-digest.mjs --all --since 2026-11-01
//   node scripts/feedback-digest.mjs --logs <目录>   # 同时下载附带的诊断日志 (zip), 每条一个文件
//   node scripts/feedback-digest.mjs --json          # 原始 JSON
//   node scripts/feedback-digest.mjs --mark-seen     # 列完把这些反馈标为「已看」(不会自动动手改代码)
// 管理员令牌: 环境变量 LIGHTREAD_ADMIN_TOKEN, 否则读 ~/.config/lightread/stats-admin-token (值不输出)。
// 接口见 docs/account-api.md「读者反馈」; 管理页 https://sync.jiangshu.ai/admin 也能看和改状态。
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const opt = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const API = (process.env.LIGHTREAD_SYNC_API || 'https://sync.jiangshu.ai').replace(/\/+$/, '')
const token = (process.env.LIGHTREAD_ADMIN_TOKEN || await readFile(join(homedir(), '.config/lightread/stats-admin-token'), 'utf8').catch(() => '')).trim()
if (!token) {
  console.error('缺少管理员令牌: 设置 LIGHTREAD_ADMIN_TOKEN 或写入 ~/.config/lightread/stats-admin-token')
  process.exit(2)
}
const auth = { authorization: `Bearer ${token}` }

async function call(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: { ...auth, ...init.headers } })
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → HTTP ${res.status}`)
  return res
}

const status = flag('--all') ? 'all' : 'new'
const sinceArg = opt('--since')
const since = sinceArg ? Date.parse(sinceArg) : 0
if (Number.isNaN(since)) {
  console.error(`--since 不是日期: ${sinceArg}`)
  process.exit(2)
}
const { items, counts } = await (await call(`/v1/admin/feedback?limit=200&status=${status}&since=${since}`)).json()

const logDir = opt('--logs')
if (logDir) {
  await mkdir(logDir, { recursive: true })
  for (const it of items.filter(i => i.logSize > 0)) {
    const buf = Buffer.from(await (await call(`/v1/admin/feedback/${it.id}/log`)).arrayBuffer())
    it.logFile = join(logDir, `feedback-${it.id.slice(0, 8)}.zip`)
    await writeFile(it.logFile, buf)
  }
}

if (flag('--json')) {
  console.log(JSON.stringify({ counts, items }, null, 2))
} else {
  const KIND = { bug: '问题', feature: '建议', other: '其他' }
  const time = ms => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
  console.log(`# 读者反馈 (${status === 'new' ? '新的' : '全部'}, ${items.length} 条)\n`)
  console.log(`各状态合计: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ') || '无'}\n`)
  for (const kind of ['bug', 'feature', 'other']) {
    const group = items.filter(i => i.kind === kind)
    if (!group.length) continue
    console.log(`## ${KIND[kind]} (${group.length})\n`)
    for (const it of group) {
      const meta = [time(it.createdAt), `${it.platform || '?'} v${it.version || '?'}`]
      if (it.contact) meta.push(`联系: ${it.contact}`)
      if (it.accountEmail) meta.push(`账号: ${it.accountEmail}`)
      if (it.logSize) meta.push(it.logFile ? `日志: ${it.logFile}` : `日志 ${Math.ceil(it.logSize / 1024)} KB`)
      if (it.status !== 'new') meta.push(`状态: ${it.status}`)
      console.log(`- **#${it.id.slice(0, 8)}** ${meta.join(' · ')}`)
      console.log(`  ${it.text.replace(/\n/g, '\n  ')}`)
      if (it.note) console.log(`  > 备注: ${it.note}`)
      console.log()
    }
  }
}

if (flag('--mark-seen')) {
  for (const it of items.filter(i => i.status === 'new')) {
    await call(`/v1/admin/feedback/${it.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'seen' }),
    })
  }
  console.error(`已标为「已看」: ${items.filter(i => i.status === 'new').length} 条`)
}
