// 双语对照 (issue #23, 2026-11-19 用户确认: 逐段翻译, 只用本机翻译模型) 的浏览器端到端。
// 本机模型的原生命令 (local_llm_*) 用替身; 页面先以网页存储启动, 导入书后再装替身 (同 e2e-translate)。
//   E2E_BASE=http://localhost:<端口> node scripts/e2e-bilingual.mjs              (桌面界面, vite dev)
//   E2E_MOBILE=1 E2E_BASE=http://localhost:<端口> node scripts/e2e-bilingual.mjs  (LIGHTREAD_UI=mobile 的 vite dev)
// 检查: 没下载模型时只给下载入口 → 打开后从当前段起逐段出译文 (每段一次本机请求, 不联网)
// → 划线位置 (CFI) 不变、译文不能选中 → 关掉后正文还原 → 再打开 / 重新载入直接用缓存, 不再调模型。
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const mobile = process.env.E2E_MOBILE === '1'
const base = process.env.E2E_BASE || 'http://localhost:5173'
const out = process.env.E2E_OUT || `/tmp/lightread-bilingual-${mobile ? 'app' : 'desktop'}`
await mkdir(out, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({
  ...(mobile ? { viewport: { width: 392, height: 850 }, hasTouch: true, isMobile: true } : { viewport: { width: 1280, height: 860 } }),
  locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block',
})
await ctx.addInitScript(() => {
  localStorage.setItem('lightread-language', 'zh')
  if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({ version: 14, language: 'zh' }))
})
let network = 0
await ctx.route('**/v1/translate', route => { network++; return route.abort() })

const p = await ctx.newPage()
p.setDefaultTimeout(15000)
const errors = []
p.on('pageerror', e => errors.push(e.message))
const step = async (name, fn) => {
  process.stdout.write(`- ${name} … `)
  try {
    await fn()
  } catch (e) {
    await p.screenshot({ path: `${out}/failed.png` }).catch(() => {})
    console.log('FAILED; page errors:', errors)
    throw e
  }
  console.log('ok')
}
const setSetting = (key, value) => p.evaluate(([k, v]) => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings')[k] = v }, [key, value])
const doubleTap = async (x, y) => { await p.touchscreen.tap(x, y); await p.touchscreen.tap(x, y) }

/** 原生层替身: 本机翻译模型 (installed 可切换), 每次生成回一段「译文」并记下原文 */
const installMock = installed => p.evaluate(installed => {
  const callbacks = new Map()
  let id = 0
  const model = { id: 'hy-mt2-1.8b-q4', kind: 'translate', size: 1133080448, installed, downloaded: installed ? 1133080448 : 0, running: false, supported: true, reasons: [], crashed: false, speed: 20, gpu: true }
  window.__llm = { calls: [], model }
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const i = ++id; callbacks.set(i, cb); return i },
    unregisterCallback(i) { callbacks.delete(i) },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    async invoke(cmd, args) {
      if (cmd === 'plugin:event|listen') return ++id
      // 装上替身后页面也会把排版面板当成桌面版 (取系统字体列表)
      if (cmd.startsWith('list_')) return []
      if (cmd === 'local_llm_status') return { available: true, models: [{ ...model }] }
      if (cmd === 'local_llm_generate') {
        const source = args.prompt.split('\n\n').slice(1).join('\n\n')
        window.__llm.calls.push({ model: args.model, prompt: args.prompt, source })
        const send = callbacks.get(args.onEvent.id)
        const n = window.__llm.calls.length
        const pieces = [' 译文', `${n}：`, source.slice(0, 18)]
        for (const [index, text] of pieces.entries()) {
          await new Promise(r => setTimeout(r, 40))
          send({ index, message: { type: 'piece', text } })
        }
        send({ index: pieces.length, message: { type: 'done', tokens: 12, promptTokens: 30, loadMs: 10, promptMs: 10, genMs: 100, gpu: true, cancelled: false } })
        return null
      }
      return null
    },
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
}, installed)

const openPanel = async () => {
  if (mobile) {
    if (!(await p.locator('footer.bar.bottom:not(.hidden)').count())) await doubleTap(196, 425)
    await p.locator('.dock button', { hasText: '排版' }).click()
    await p.getByRole('tab', { name: '页面', exact: true }).click()
  } else {
    if (await p.locator('.bar.top.hidden').count()) { await p.mouse.move(640, 2); await p.waitForTimeout(300) }
    await p.locator('button[title="排版设置"]').first().click()
  }
  await p.locator('.settings-pop').waitFor()
}
/** 点浮层外的遮罩收起 (阅读页的 closeOverlays; 桌面宽屏遮罩不显示, 直接派发点击) */
const closePanel = async () => {
  await p.locator('.sheet-scrim').dispatchEvent('click')
  await p.locator('.settings-pop').waitFor({ state: 'detached' })
}
const doc = 'document.querySelector("foliate-view").renderer.getContents()[0].doc'
const spans = () => p.evaluate(`[...${doc}.querySelectorAll('.lr-bilingual')].map(s => ({ text: s.textContent, pending: s.hasAttribute('data-pending'), parent: s.parentElement.localName, last: s === s.parentElement.lastChild, select: getComputedStyle(s).userSelect }))`)
const paragraphTexts = () => p.evaluate(`[...${doc}.querySelectorAll('p')].map(x => x.textContent)`)
/** 第 n 个非空段落里 [2, 9) 的 CFI */
const cfiAt = n => p.evaluate(n => {
  const view = document.querySelector('foliate-view')
  const { doc, index } = view.renderer.getContents()[0]
  const para = [...doc.querySelectorAll('p')].filter(x => x.textContent.trim())[n]
  const text = [...para.childNodes].find(x => x.nodeType === 3)
  const r = doc.createRange()
  r.setStart(text, 2); r.setEnd(text, 9)
  return view.getCFI(index, r)
}, n)

const SENTENCES = [
  'Socrates went down to the Piraeus with Glaucon to offer prayers to the goddess.',
  'When we had finished our prayers and seen the spectacle, we turned towards the city.',
  'Polemarchus saw us from a distance as we were starting on our way home.',
  'He told his servant to run and bid us wait for him, and the servant caught hold of my cloak.',
]
const book = 'Chapter 1\n\n' + Array.from({ length: 14 }, (_, i) => `${i + 1}. ${SENTENCES[i % 4]} This is the ${i + 1}th paragraph of the test.`).join('\n\n')

try {
  await step('import an English book and open it', async () => {
    await p.goto(base + '/#/library')
    await p.setInputFiles('input[type=file][multiple]', { name: 'Bilingual QA.txt', mimeType: 'text/plain', buffer: Buffer.from(book) })
    await p.locator('.book-card').filter({ hasText: 'Bilingual QA' }).click()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc?.querySelectorAll('p').length > 5)
    await p.waitForTimeout(600)
  })

  const original = await paragraphTexts()
  const cfiBefore = await cfiAt(3)

  await step('model not downloaded: switch shown, turning it on only offers the download', async () => {
    await installMock(false)
    await openPanel()
    const sw = p.locator('.settings-pop').getByRole('switch', { name: '双语对照', exact: true })
    await sw.waitFor()
    assert.equal(await sw.getAttribute('aria-checked'), 'false')
    await sw.click()
    assert.equal(await sw.getAttribute('aria-checked'), 'true')
    await p.locator('.settings-pop').getByText('双语对照需要先下载本机翻译模型。').waitFor()
    await p.locator('.settings-pop').getByRole('button', { name: /下载/ }).first().waitFor()
    await p.waitForTimeout(400) // 开关动画
    await p.screenshot({ path: `${out}/needs-model.png` })
    await p.waitForTimeout(400)
    assert.equal((await spans()).length, 0)
    assert.equal(await p.evaluate(() => window.__llm.calls.length), 0)
    await closePanel()
  })

  await step('model ready: translates paragraph by paragraph from the current one, on device only', async () => {
    await installMock(true)
    await openPanel() // 面板打开时向原生层问一次模型状态
    await p.locator('.settings-pop').getByText('双语对照需要先下载本机翻译模型。').waitFor({ state: 'detached' })
    await closePanel()
    await p.waitForFunction(`[...${doc}.querySelectorAll('.lr-bilingual:not([data-pending])')].length >= 4`)
    await p.screenshot({ path: `${out}/bilingual-on.png` })
    const calls = await p.evaluate(() => window.__llm.calls)
    assert.ok(calls.length <= 8, `pre-translates a few paragraphs ahead, not the whole chapter (${calls.length})`)
    for (const c of calls) {
      assert.equal(c.model, 'hy-mt2-1.8b-q4')
      assert.match(c.prompt, /^把下面的文本翻译成中文/)
      assert.ok(!c.source.includes('\n'), 'one paragraph per request')
    }
    assert.match(calls[0].source, /^(Chapter 1|1\. Socrates)/, 'starts from the first visible paragraph')
    const s = (await spans()).filter(x => !x.pending)
    for (const x of s) {
      assert.equal(x.last, true, 'translation is the paragraph’s last child')
      assert.equal(x.select, 'none', 'translation cannot be selected')
      assert.match(x.text, /^译文\d+：/)
    }
    assert.equal(network, 0, 'no online translation')
  })

  await step('highlight positions (CFI) unchanged while translations are shown', async () => {
    assert.equal(await cfiAt(3), cfiBefore)
  })

  await step('turning it off restores the original text exactly', async () => {
    const callsBefore = await p.evaluate(() => window.__llm.calls.length)
    await setSetting('bilingual', false)
    await p.waitForFunction(`!${doc}.querySelector('.lr-bilingual')`)
    assert.deepEqual(await paragraphTexts(), original)
    // 再打开: 已翻的段直接从缓存贴上
    await setSetting('bilingual', true)
    await p.waitForFunction(`${doc}.querySelectorAll('.lr-bilingual:not([data-pending])').length >= 4`)
    const used = (await p.evaluate(() => window.__llm.calls.map(c => c.source)))
    const fresh = used.slice(callsBefore)
    const firstTexts = (await spans()).slice(0, 4).map(x => x.text)
    assert.ok(firstTexts.every(t => /^译文\d+：/.test(t)))
    assert.ok(fresh.every(src => !used.slice(0, callsBefore).includes(src)), 'cached paragraphs are not sent to the model again')
  })

  await step('cache survives a reload (IndexedDB)', async () => {
    // 等手头的段翻完, 缓存最多 1.5 秒落盘一次
    await p.waitForFunction(`!${doc}.querySelector('.lr-bilingual[data-pending]')`)
    await p.waitForTimeout(2000)
    await p.reload()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc?.querySelectorAll('p').length > 5)
    await installMock(true)
    await openPanel()
    await closePanel()
    await p.waitForFunction(`${doc}.querySelectorAll('.lr-bilingual:not([data-pending])').length >= 4`)
    const firstCalls = await p.evaluate(() => window.__llm.calls.map(c => c.source))
    const shown = await spans()
    // 前几段来自缓存: 它们的原文没有再发给模型
    const cachedHead = shown.slice(0, 3).map(x => x.text.replace(/^译文\d+：/, ''))
    for (const head of cachedHead) assert.ok(!firstCalls.some(src => src.startsWith(head)), `"${head}" came from cache`)
    await p.screenshot({ path: `${out}/after-reload.png` })
    await setSetting('bilingual', false)
  })

  assert.deepEqual(errors, [])
  console.log(`e2e-bilingual ${mobile ? 'mobile' : 'desktop'}: all passed`)
} finally {
  await browser.close()
}
