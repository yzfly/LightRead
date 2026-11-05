// API 语音端到端: 听书面板配置 MiniMax / 豆包, 试听与朗读走原生命令 (模拟 IPC), 错误有明确提示.
// 需先起 vite dev: E2E_BASE=http://127.0.0.1:<端口> node scripts/e2e-cloud-tts.mjs
// App 界面: LIGHTREAD_UI=mobile 起 dev, 并加 E2E_MOBILE=1
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const base = process.env.E2E_BASE ?? 'http://localhost:5173'
const mobile = process.env.E2E_MOBILE === '1'
const shot = process.env.E2E_SHOT
const browser = await chromium.launch()
const page = await browser.newPage(mobile
  ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
  : { viewport: { width: 1280, height: 860 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))

const para = '夜色像一块浸了水的墨布，慢慢盖住了远处的山。'.repeat(8)
try {
  await page.goto(`${base}/#/library`)
  await page.setInputFiles('input[type=file][multiple]', {
    name: '语音测试.txt', mimeType: 'text/plain', buffer: Buffer.from(`第一章\n\n${para}\n\n${para}`),
  })
  await page.locator('.book-card').first().waitFor()
  await page.locator('.book-card').first().click()
  await page.waitForTimeout(2500)

  // 书已用网页存储打开; 从这里起应用认为自己在原生壳里
  await page.evaluate(async () => {
    const { mockIPC, mockWindows } = await import('/node_modules/@tauri-apps/api/mocks.js')
    const rate = 8000
    const pcm = new Int16Array(rate / 2).map((_, i) => Math.round(Math.sin(i / 3) * 8000))
    const head = new DataView(new ArrayBuffer(44))
    const tag = (at, text) => [...text].forEach((c, i) => head.setUint8(at + i, c.charCodeAt(0)))
    tag(0, 'RIFF'); head.setUint32(4, 36 + pcm.byteLength, true); tag(8, 'WAVEfmt ')
    head.setUint32(16, 16, true); head.setUint16(20, 1, true); head.setUint16(22, 1, true)
    head.setUint32(24, rate, true); head.setUint32(28, rate * 2, true); head.setUint16(32, 2, true)
    head.setUint16(34, 16, true); tag(36, 'data'); head.setUint32(40, pcm.byteLength, true)
    const wav = await new Blob([head, pcm]).arrayBuffer()
    window.__cloudCalls = []
    window.__cloudError = ''
    mockWindows('main')
    mockIPC(async (cmd, args) => {
      if (cmd !== 'cloud_tts_synthesize') return null
      window.__cloudCalls.push(args.request)
      if (window.__cloudError) throw window.__cloudError
      return wav.slice(0)
    })
  })

  const calls = () => page.evaluate(() => window.__cloudCalls)
  const waitCalls = n => page.waitForFunction(count => window.__cloudCalls.length >= count, n, { timeout: 10000 })

  const listen = page.getByRole('button', { name: '听书', exact: false }).first()
  await listen.click()
  if (mobile) await page.getByRole('button', { name: /音色|声音/ }).first().click().catch(() => {})
  await page.getByRole('button', { name: 'API', exact: true }).click()
  const config = page.locator('.cloud-tts')
  await config.waitFor()

  const audition = config.getByRole('button', { name: '试听' })
  assert.equal(await audition.isDisabled(), true, '没填 Key 时不能试听')

  const key = config.locator('input[type=password]')
  await key.fill('  mm-test-key  ')
  await audition.click()
  await waitCalls(1)
  const first = (await calls())[0]
  assert.equal(first.provider, 'minimax')
  assert.equal(first.apiKey, 'mm-test-key')
  assert.equal(first.voice, 'female-chengshu')
  assert.equal(first.model, 'speech-2.8-turbo')
  assert.equal(first.region, 'cn')

  await config.getByRole('button', { name: '服务商' }).click()
  await page.getByRole('dialog').getByText('火山引擎 · 豆包语音').click()
  assert.equal(await key.inputValue(), '', '两家的 Key 分开保存')
  await key.fill('db-test-key')
  await config.getByRole('button', { name: '音色' }).click()
  await page.getByRole('dialog').getByText('自定义音色 ID').click()
  await config.locator('input[spellcheck=false]').fill('zh_female_wanwanxiaohe_moon_bigtts')
  if (shot) await page.screenshot({ path: shot })

  assert.equal(await page.locator('.tts-hint:visible').count(), 0, 'API 语音不显示其他引擎的说明')
  const overflow = await config.evaluate(el => el.scrollWidth - el.clientWidth)
  assert.ok(overflow <= 1, `面板横向溢出 ${overflow}px`)

  const voiceSheet = async open => {
    if (!mobile) return
    if (open) await page.getByRole('button', { name: /音色/ }).first().click()
    else await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  await voiceSheet(false)
  const before = (await calls()).length
  await page.locator('.tts-play').first().click()
  await waitCalls(before + 1)
  const spoken = (await calls())[before]
  assert.equal(spoken.provider, 'doubao')
  assert.equal(spoken.apiKey, 'db-test-key')
  assert.equal(spoken.voice, 'zh_female_wanwanxiaohe_moon_bigtts')
  assert.equal(spoken.resourceId, 'seed-tts-1.0')
  assert.ok(spoken.text.length > 0)
  await page.waitForTimeout(500)
  assert.ok((await calls()).length - before <= 4 + 2, '预取不应超过上限太多 (按字计费)')

  // 换 Key 会重置失败状态; 鉴权失败给明确提示, 不只说音色不可用
  await page.evaluate(() => { window.__cloudError = 'cloud_tts:auth:invalid key' })
  await voiceSheet(true)
  await key.fill('db-bad-key')
  const failedFrom = (await calls()).length
  await page.waitForFunction(from => window.__cloudCalls.length > from, failedFrom, { timeout: 15000 }).catch(() => {})
  await page.getByText('API Key 无效或没有权限').first().waitFor({ timeout: 15000 })

  assert.deepEqual(errors, [])
  console.log(`e2e-cloud-tts ok (${mobile ? 'mobile' : 'desktop'})`)
} finally {
  await browser.close()
}
