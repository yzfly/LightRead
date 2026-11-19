// 应用内反馈 (2026-11-18 用户要求): 设置首页「反馈问题或建议」→ 选类型 → 写内容 → 联系方式 → 默认附诊断日志 → 提交。
// 后端用 page.route 替身, 检查请求体; 再测失败时保留草稿、取消勾选不带日志、关于页入口。
//   E2E_BASE=http://localhost:<端口> node scripts/e2e-feedback.mjs            (桌面界面, vite dev)
//   E2E_MOBILE=1 E2E_BASE=http://localhost:<端口> node scripts/e2e-feedback.mjs (LIGHTREAD_UI=mobile 的 vite dev)
import assert from 'node:assert/strict'
import { chromium, devices } from 'playwright'

const base = process.env.E2E_BASE || 'http://localhost:4173'
const mobile = process.env.E2E_MOBILE === '1'
const browser = await chromium.launch()
const ctx = await browser.newContext({
  ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1180, height: 780 } }),
  locale: 'zh-CN',
  serviceWorkers: 'block',
})
await ctx.addInitScript(() => {
  localStorage.setItem('lightread-language', 'zh')
  if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({ version: 14, language: 'zh' }))
  // 假装已登录: 联系方式默认填账号邮箱, 请求带 token
  localStorage.setItem('lightread-account', JSON.stringify({ token: 'tok_e2e_feedback_0123456789', account: { id: 'u1', email: 'reader@example.com', createdAt: 1 } }))
  localStorage.setItem('lightread-sync-api', 'https://sync.e2e.test')
})
const p = await ctx.newPage()
p.setDefaultTimeout(15000)
const errors = []
p.on('pageerror', e => errors.push(e.message))

const sent = []
let reply = 201
await p.route('https://sync.e2e.test/**', async route => {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
  if (new URL(req.url()).pathname === '/v1/feedback') {
    sent.push({ body: JSON.parse(req.postData() || '{}'), auth: req.headers().authorization })
    return route.fulfill({
      status: reply,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify(reply === 201 ? { id: '00000000-0000-4000-8000-000000000001' } : { error: 'rate_limited', retryAfter: 60 }),
    })
  }
  // 其他账号接口 (同步等) 一律当作没连上, 不影响反馈
  return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: '{}' })
})

const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `)
  await fn()
  console.log('ok')
}

try {
  await p.goto(base + '/#/settings')
  const dialog = p.getByRole('dialog', { name: '反馈问题或建议' })

  await step('settings home has the entry; dialog opens with email prefilled, logs checked', async () => {
    if (!mobile) await p.setViewportSize({ width: 390, height: 800 }) // 桌面窄屏同样是列表首页
    await p.locator('.feedback-row').click()
    await dialog.waitFor()
    assert.equal(await dialog.locator('input[type=text]').inputValue(), 'reader@example.com')
    assert.equal(await dialog.locator('input[type=checkbox]').isChecked(), true)
    assert.equal(await dialog.getByRole('button', { name: '提交' }).isDisabled(), true)
    // 问题 / 建议 / 其他, 切换后提示语跟着变
    await dialog.getByRole('button', { name: '建议' }).click()
    assert.match(await dialog.locator('textarea').getAttribute('placeholder'), /想要什么功能/)
  })

  await step('server refuses → error shown, dialog stays, text kept as draft', async () => {
    reply = 429
    await dialog.locator('textarea').fill('希望能按作者分组书架')
    await dialog.getByRole('button', { name: '提交' }).click()
    await dialog.getByRole('alert').filter({ hasText: '今天提交得有点多' }).waitFor()
    assert.equal(sent.length, 1)
    await dialog.getByRole('button', { name: '取消' }).click()
    await dialog.waitFor({ state: 'detached' })
    await p.locator('.feedback-row').click()
    await dialog.waitFor()
    assert.equal(await dialog.locator('textarea').inputValue(), '希望能按作者分组书架')
  })

  await step('submit with logs: body has kind / text / contact / version / platform / zip log, token sent', async () => {
    reply = 201
    await dialog.getByRole('button', { name: '建议' }).click()
    await dialog.locator('input[type=text]').fill('  wx: reader_1  ')
    await dialog.getByRole('button', { name: '提交' }).click()
    await dialog.waitFor({ state: 'detached' })
    await p.getByText('已收到，谢谢你的反馈').waitFor()
    const { body, auth } = sent.at(-1)
    assert.equal(auth, 'Bearer tok_e2e_feedback_0123456789')
    assert.equal(body.kind, 'feature')
    assert.equal(body.text, '希望能按作者分组书架')
    assert.equal(body.contact, 'wx: reader_1')
    assert.match(body.version, /^\d+\.\d+\.\d+/)
    assert.ok(body.platform)
    const zip = Buffer.from(body.log, 'base64')
    assert.equal(zip.subarray(0, 2).toString('latin1'), 'PK')
    assert.ok(zip.includes(Buffer.from('logs/session.log')) && zip.includes(Buffer.from('system.json')))
    // 发出去后草稿清掉
    await p.locator('.feedback-row').click()
    await dialog.waitFor()
    assert.equal(await dialog.locator('textarea').inputValue(), '')
  })

  await step('unchecking logs sends text only', async () => {
    await dialog.getByRole('button', { name: '问题' }).click()
    await dialog.locator('textarea').fill('翻到第 3 章闪退')
    await dialog.locator('input[type=checkbox]').uncheck()
    await dialog.getByRole('button', { name: '提交' }).click()
    await dialog.waitFor({ state: 'detached' })
    const { body } = sent.at(-1)
    assert.equal(body.kind, 'bug')
    assert.equal('log' in body, false)
  })

  await step('About page "遇到问题" also opens the dialog', async () => {
    await p.goto(base + '/#/settings?page=about')
    await p.locator('.feedback-open').click()
    await dialog.waitFor()
    await dialog.getByRole('button', { name: '取消' }).click()
  })

  assert.deepEqual(errors, [])
  console.log(`e2e-feedback ${mobile ? 'mobile' : 'desktop'}: all passed`)
} finally {
  await browser.close()
}
