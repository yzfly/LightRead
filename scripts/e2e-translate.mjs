// 划词翻译 / 选中本段 / 正文简繁转换 / 听书胶囊一致性 (issue #18) 的浏览器端到端。
// 先构建并起预览:
//   桌面: TAURI_ENV_PLATFORM=linux npm run build && npx vite preview --port 4173 --strictPort
//   App:  TAURI_ENV_PLATFORM=android npm run build && npx vite preview --port 4188 --strictPort
//   E2E_BASE=http://localhost:4173 node scripts/e2e-translate.mjs
//   E2E_MOBILE=1 E2E_BASE=http://localhost:4188 node scripts/e2e-translate.mjs
// 内置翻译通道 (/v1/translate) 由路由替身返回, 不联网。
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const mobile = process.env.E2E_MOBILE === '1'
const base = process.env.E2E_BASE || (mobile ? 'http://localhost:4188' : 'http://localhost:4173')
const out = process.env.E2E_OUT || `/tmp/lightread-translate-${mobile ? 'app' : 'desktop'}`
await mkdir(out, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({
  ...(mobile ? { viewport: { width: 392, height: 850 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 860 } }),
  locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block',
})
await ctx.addInitScript(() => {
  localStorage.setItem('lightread-language', 'zh')
  if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({ version: 14, ttsEngine: 'system', language: 'zh' }))
  // 系统语音替身: 听书胶囊需要「正在朗读」状态, 不真的发声
  const speech = { current: null, queue: [], paused: false,
    getVoices: () => [{ name: 'QA Chinese', lang: 'zh-CN', default: true }],
    addEventListener() {}, removeEventListener() {},
    speak(u) { this.queue.push(u); this.pump() },
    pump() { if (this.current || this.paused || !this.queue.length) return; const u = this.current = this.queue.shift(); u.onstart?.() },
    cancel() { this.current = null; this.queue = []; this.paused = false },
    pause() { this.paused = true }, resume() { this.paused = false; this.pump() },
  }
  Object.defineProperty(window, 'speechSynthesis', { value: speech, configurable: true })
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
})

let translateStatus = 200
const translateBodies = []
await ctx.route('**/v1/translate', async route => {
  translateBodies.push({ body: route.request().postDataJSON(), auth: route.request().headers().authorization })
  if (translateStatus !== 200) {
    return route.fulfill({ status: translateStatus, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { code: 'quota', message: 'QA quota' } }) })
  }
  const sse = ['Justice ', 'is the advantage ', 'of the stronger.'].map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n'
  await route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'x-translate-remaining': '99', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-translate-remaining' }, body: sse })
})

const p = await ctx.newPage()
p.setDefaultTimeout(12000)
const errors = []
const results = []
p.on('pageerror', e => errors.push(e.message))
const step = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name) }
const bar = mobile ? '.highlight-bar' : '.highlight-bar'
const settingsStore = () => p.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').$state)
const setSetting = (key, value) => p.evaluate(([k, v]) => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings')[k] = v }, [key, value])

/** 在第 n 个段落里选中 [start, end) 几个字, 触发阅读页的选区处理 */
const selectInParagraph = (n, start, end) => p.evaluate(([n, start, end]) => {
  const { doc } = document.querySelector('foliate-view').renderer.getContents()[0]
  const para = [...doc.querySelectorAll('p')].filter(x => x.textContent.trim())[n]
  const text = [...para.childNodes].find(x => x.nodeType === 3) ?? para.firstChild
  const sel = doc.getSelection()
  sel.removeAllRanges()
  const r = doc.createRange()
  r.setStart(text, start); r.setEnd(text, end)
  sel.addRange(r)
  doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  return para.textContent.trim()
}, [n, start, end])
const docSelection = () => p.evaluate(() => document.querySelector('foliate-view').renderer.getContents()[0].doc.getSelection().toString())
const firstParagraph = () => p.evaluate(() => [...document.querySelector('foliate-view').renderer.getContents()[0].doc.querySelectorAll('p')].filter(x => x.textContent.trim())[1].textContent)

try {
  await step('import and open a Chinese book', async () => {
    await p.goto(base + '/#/library')
    const para = Array.from({ length: 12 }, (_, i) => `第${i + 1}段讨论正义与城邦，苏格拉底解释头发与理发的比喻。这是第${i + 1}段的第二句。`).join('\n\n')
    await p.setInputFiles('input[type=file][multiple]', { name: '翻译验收.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 正义\n\n' + para) })
    await p.locator('.book-card').filter({ hasText: '翻译验收' }).click()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length)
    await p.waitForTimeout(500)
  })

  await step('select paragraph expands a partial selection to the whole paragraph', async () => {
    const paraText = await selectInParagraph(1, 2, 6)
    await p.locator(bar).waitFor()
    const btn = p.locator(bar).getByRole('button', { name: '选中本段', exact: true })
    await btn.click()
    await p.waitForFunction(t => document.querySelector('foliate-view').renderer.getContents()[0].doc.getSelection().toString().trim() === t, paraText)
    assert.equal((await docSelection()).trim(), paraText)
    // 已是整段: 按钮收起
    await p.waitForFunction(() => ![...document.querySelectorAll('.highlight-bar button')].some(b => b.textContent.includes('选中本段')))
    await p.screenshot({ path: `${out}/select-paragraph.png` })
  })

  await step('translate without login asks to sign in or add a key; no request sent', async () => {
    await p.locator(bar).getByRole('button', { name: '翻译', exact: true }).click()
    const sheet = p.getByRole('dialog', { name: '翻译' })
    await sheet.waitFor()
    await sheet.getByText('登录轻阅账号后每天可免费翻译 100 次', { exact: false }).waitFor()
    assert.ok(await sheet.getByRole('button', { name: '登录账号', exact: true }).isVisible())
    assert.ok(await sheet.getByRole('button', { name: '填自己的 Key', exact: true }).isVisible())
    assert.equal(translateBodies.length, 0)
    await p.screenshot({ path: `${out}/translate-login.png` })
    await p.keyboard.press('Escape')
    await sheet.waitFor({ state: 'hidden' })
  })

  await step('signed-in account translates through the built-in channel and shows remaining quota', async () => {
    await p.evaluate(() => localStorage.setItem('lightread-account', JSON.stringify({ token: 'qa-token-1234567890abcd', account: { id: 'qa', email: 'qa@example.com', createdAt: 1 } })))
    await p.reload()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length)
    await p.waitForTimeout(500)
    await selectInParagraph(0, 0, 10)
    await p.locator(bar).getByRole('button', { name: '翻译', exact: true }).click()
    const sheet = p.getByRole('dialog', { name: '翻译' })
    await sheet.getByText('Justice is the advantage of the stronger.').waitFor()
    await sheet.getByText('账号今日免费翻译还剩 99 次').waitFor()
    const req = translateBodies.at(-1)
    assert.equal(req.auth, 'Bearer qa-token-1234567890abcd')
    assert.equal(req.body.target, 'en', 'auto target: Chinese → English')
    assert.equal(req.body.book, '翻译验收')
    await p.screenshot({ path: `${out}/translate-result.png` })
    // 换目标语言会重新翻译
    translateStatus = 429
    await sheet.getByRole('button', { name: '重新翻译', exact: true }).click()
    await sheet.getByText('今天的免费翻译次数已用完', { exact: false }).waitFor()
    translateStatus = 200
    await p.keyboard.press('Escape')
  })

  await step('Simplified ↔ Traditional conversion is local, length-preserving and reversible', async () => {
    const original = await firstParagraph()
    await setSetting('zhConvert', 's2t')
    await p.waitForFunction(() => [...document.querySelector('foliate-view').renderer.getContents()[0].doc.querySelectorAll('p')].some(x => x.textContent.includes('討論正義')))
    const converted = await firstParagraph()
    assert.equal(converted.length, original.length)
    assert.match(converted, /頭髮與理髮/)
    // 转换后划线照常: 选区文字是繁体
    await selectInParagraph(1, 2, 6)
    await p.locator(bar).waitFor()
    assert.match(await docSelection(), /討論|論正/)
    await p.locator(bar).getByRole('button', { name: '取消', exact: true }).first().click().catch(() => {})
    await setSetting('zhConvert', 'off')
    await p.waitForFunction(o => [...document.querySelector('foliate-view').renderer.getContents()[0].doc.querySelectorAll('p')].filter(x => x.textContent.trim())[1].textContent === o, original)
    assert.equal((await settingsStore()).zhConvert, 'off')
    assert.equal(translateBodies.length, 2, 'conversion never calls the network')
  })

  if (mobile) {
    await step('listening capsule: top-bar and floating capsules share controls and hit sizes', async () => {
      const reveal = async () => {
        await p.evaluate(() => document.querySelector('.content')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
        if (!await p.locator('footer.bar.bottom:not(.hidden)').count()) await p.mouse.click(196, 425)
      }
      await reveal()
      await p.locator('.listen-entry').click()
      await p.locator('.tts-play').click()
      await p.locator('.listen-links').getByRole('button', { name: '原文', exact: true }).click()
      await reveal()
      const measure = sel => p.locator(sel).evaluate(root => ({
        labels: [...root.querySelectorAll('button.lc-btn')].map(b => b.getAttribute('aria-label')),
        sizes: [...root.querySelectorAll('button.lc-btn')].map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] }),
      }))
      await p.locator('.listen-capsule.lc-bar').waitFor()
      const inBar = await measure('.listen-capsule.lc-bar')
      // 顶栏胶囊在返回按钮右侧, 不压书名区以外的按钮
      const overlap = await p.evaluate(() => {
        const cap = document.querySelector('.listen-capsule.lc-bar').getBoundingClientRect()
        const back = document.querySelector('.bar.top > .icon-btn').getBoundingClientRect()
        const actions = document.querySelector('.bar.top .bar-actions').getBoundingClientRect()
        return { left: cap.left - back.right, right: actions.left - cap.right }
      })
      assert.ok(overlap.left >= 0 && overlap.right >= 0, `top-bar capsule overlaps neighbours: ${JSON.stringify(overlap)}`)
      const clipped = await p.locator('.listen-capsule.lc-bar .lc-label').evaluate(el => el.scrollWidth > el.clientWidth + 1)
      assert.equal(clipped, false, 'remaining-time label is not truncated on a 392px phone')
      await p.screenshot({ path: `${out}/capsule-bar.png` })
      // 收起工具栏 → 浮动胶囊
      await p.evaluate(() => document.querySelector('.content')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      if (await p.locator('.listen-capsule.lc-bar').count()) await p.mouse.click(196, 425)
      await p.locator('.listen-capsule.lc-float').waitFor()
      const floating = await measure('.listen-capsule.lc-float')
      await p.screenshot({ path: `${out}/capsule-float.png` })
      assert.deepEqual(inBar.labels, ['暂停', '停止'])
      assert.deepEqual(floating.labels, inBar.labels, 'same controls in the same order')
      assert.deepEqual(floating.sizes, inBar.sizes, 'same hit areas')
      for (const [w, h] of inBar.sizes) assert.ok(w >= 36 && h >= 40, `touch hit area ≥36×40px, got ${w}×${h}`)
      await p.locator('.listen-capsule.lc-float').getByRole('button', { name: '停止', exact: true }).click()
      await p.locator('.listen-capsule').waitFor({ state: 'detached' })
    })
  }

  assert.deepEqual(errors, [])
  await writeFile(`${out}/results.json`, JSON.stringify({ ok: true, results }, null, 2))
} catch (error) {
  await p.screenshot({ path: `${out}/failure.png` }).catch(() => {})
  await writeFile(`${out}/results.json`, JSON.stringify({ ok: false, results, errors, message: String(error?.message ?? error) }, null, 2))
  throw error
} finally {
  await browser.close()
}
