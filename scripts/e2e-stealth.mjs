// 摸鱼模式 (桌面) 的浏览器端到端: 网页版不显示入口; 模拟桌面 IPC 后
// 进入 → 只剩正文 + 半透明底色 + 窗口命令 → 透明度 / 伪装即时生效 → 老板键事件 → Esc 退出
// → 打开图书自动进入 / 离开阅读页恢复窗口 → PDF 阅读页同样可用 → 设置页录制老板键。
// 原生窗口行为 (无边框 / 全局快捷键) 由 cargo test stealth 与真机验证, 这里只校验页面与命令参数。
//   TAURI_ENV_PLATFORM=linux npm run build && npx vite preview --port 4173 --strictPort
//   E2E_BASE=http://localhost:4173 node scripts/e2e-stealth.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const base = process.env.E2E_BASE || 'http://localhost:4173'
const out = process.env.E2E_OUT || '/tmp/lightread-stealth'
await mkdir(out, { recursive: true })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1180, height: 780 }, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' })
await ctx.addInitScript(() => {
  localStorage.setItem('lightread-language', 'zh')
  if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({ version: 14, language: 'zh' }))
})
const p = await ctx.newPage()
p.setDefaultTimeout(12000)
const errors = []
const results = []
p.on('pageerror', e => errors.push(e.message))
const step = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name) }
const settings = () => p.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').$state)
const setStealthPref = (k, v) => p.evaluate(([k, v]) => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').stealth[k] = v }, [k, v])
const calls = cmd => p.evaluate(c => window.__ipc.filter(x => x.cmd === c).map(x => x.args), cmd)
const go = path => p.evaluate(path => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path), path)
const openBook = async () => {
  await go('/library')
  await p.locator('.book-card').filter({ hasText: '摸鱼验收' }).click()
  await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length)
  await p.waitForTimeout(400)
}
/** 摸鱼入口在「阅读模式」面板里 */
const openModes = async () => {
  await p.mouse.move(400, 10)
  await p.locator('.icon-btn[aria-label="阅读模式"]').click()
  await p.locator('.rm-panel').waitFor()
}

/** 桌面 IPC 替身: 记录命令, stealth_enter 返回老板键已注册; 事件监听走 transformCallback */
const installDesktopIpc = () => p.evaluate(() => {
  const callbacks = new Map()
  let id = 0
  window.__ipc = []
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb) { const i = ++id; callbacks.set(i, cb); return i },
    unregisterCallback(i) { callbacks.delete(i) },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    async invoke(cmd, args) {
      window.__ipc.push({ cmd, args })
      if (cmd === 'stealth_enter') return { bossKey: !!args.options.bossKey, bossKeyError: null }
      // 原生层退出时交回摸鱼时的窗口位置大小
      if (cmd === 'stealth_exit') return { x: 40, y: 30, w: 640, h: 720 }
      if (cmd === 'plugin:event|listen') { if (args.event === 'stealth-boss') window.__bossHandler = args.handler; return id }
      if (cmd === 'list_system_fonts') return []
      return null
    },
  }
  // 真实运行时由事件插件注入, 取消监听 (离开阅读页) 时调用
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
  window.__emitBoss = hidden => callbacks.get(window.__bossHandler)?.({ event: 'stealth-boss', id: 1, payload: { hidden } })
})

try {
  await step('web build: no stealth entry', async () => {
    await p.goto(base + '/#/library')
    const para = Array.from({ length: 30 }, (_, i) => `第${i + 1}段：午后的办公室很安静，这一段文字用来验证摸鱼模式下只剩正文。`).join('\n\n')
    await p.setInputFiles('input[type=file][multiple]', { name: '摸鱼验收.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 摸鱼\n\n' + para) })
    await openBook()
    await openModes()
    assert.equal(await p.locator('.rm-panel').getByRole('switch', { name: '摸鱼模式', exact: true }).count(), 0)
    await p.keyboard.press('Escape')
  })

  await step('desktop: enter hides every control, translucent background, native window command', async () => {
    await go('/library')
    await installDesktopIpc()
    await openBook()
    await openModes()
    // 面板最上面 (点睛之前) 的摸鱼开关: 打开即进入
    const sw = p.locator('.rm-panel').getByRole('switch', { name: '摸鱼模式', exact: true })
    assert.ok(await p.evaluate(() => {
      const row = document.querySelector('.rm-panel .rm-stealth'), dj = document.querySelector('.rm-panel .dj-toggle')
      return !!row && !!dj && !!(row.compareDocumentPosition(dj) & Node.DOCUMENT_POSITION_FOLLOWING)
    }), 'stealth row sits above 点睛')
    if (process.env.SHOT_DIR) await p.locator('.rm-panel').screenshot({ path: `${process.env.SHOT_DIR}/stealth-modes-panel.png` })
    await sw.click()
    await p.locator('.reader.stealth').waitFor()
    assert.equal(await p.locator('.rm-panel').count(), 0, 'reading-mode panel closes on entering')
    assert.equal(await p.evaluate(() => document.documentElement.classList.contains('lr-stealth')), true)
    await p.waitForFunction(() => window.__ipc.some(x => x.cmd === 'stealth_enter'))
    assert.deepEqual((await calls('stealth_enter')).at(-1), {
      options: { title: null, alwaysOnTop: false, bossKey: 'Alt+Shift+Z', skipTaskbar: false, hideFromCapture: false, bounds: null },
    })
    // 第一次进入: 说明卡讲清老板键 / Esc / 顶部细条 / 找回窗口; 关掉后不再出现
    const intro = p.getByRole('dialog', { name: '已进入摸鱼模式' })
    await intro.waitFor()
    await intro.locator('kbd', { hasText: 'Alt+Shift+Z' }).waitFor()
    await intro.getByText('再次打开轻阅').waitFor()
    await intro.getByRole('button', { name: '知道了' }).click()
    await intro.waitFor({ state: 'detached' })
    assert.equal((await settings()).stealth.introSeen, true)
    const look = await p.evaluate(() => ({
      reader: getComputedStyle(document.querySelector('.reader')).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      html: getComputedStyle(document.documentElement).backgroundColor,
      top: document.querySelector('.bar.top').classList.contains('hidden'),
      bottom: document.querySelector('.bar.bottom').classList.contains('hidden'),
      peeks: document.querySelectorAll('.bar-peek').length,
      navs: document.querySelectorAll('.nav.prev, .nav.next').length,
      heads: [...(document.querySelector('foliate-view').renderer.heads ?? [])].map(h => h.textContent).join(''),
      feet: [...(document.querySelector('foliate-view').renderer.feet ?? [])].map(h => h.textContent).join(''),
      strip: !!document.querySelector('.stealth-strip[data-tauri-drag-region]'),
    }))
    assert.equal(look.reader, 'rgba(255, 255, 255, 0.85)')
    assert.equal(look.body, 'rgba(0, 0, 0, 0)')
    assert.equal(look.html, 'rgba(0, 0, 0, 0)')
    assert.ok(look.top && look.bottom, 'toolbars hidden')
    assert.equal(look.peeks, 0, 'no hover areas that bring toolbars back')
    assert.equal(look.navs, 0, 'no page-turn buttons')
    assert.equal(look.heads + look.feet, '', 'running head / foot blank (no book title)')
    assert.ok(look.strip, 'drag strip for the borderless window')
    // 鼠标移到顶部 / 点正文中间都不会呼出工具栏
    await p.mouse.move(590, 2)
    await p.mouse.click(590, 400)
    await p.waitForTimeout(300)
    assert.equal(await p.locator('.bar.top.hidden').count(), 1)
    await p.screenshot({ path: `${out}/stealth.png` })
  })

  await step('opacity and text strength apply instantly; title disguise goes to the window', async () => {
    const before = (await calls('stealth_enter')).length
    await setStealthPref('bgOpacity', 0.4)
    await setStealthPref('textOpacity', 0.6)
    await p.waitForFunction(() => getComputedStyle(document.querySelector('.reader')).backgroundColor === 'rgba(255, 255, 255, 0.4)')
    await p.waitForFunction(() => getComputedStyle(document.querySelector('.reader .content')).opacity === '0.6')
    assert.equal((await calls('stealth_enter')).length, before, 'opacity is page-only')
    await setStealthPref('disguise', true)
    await p.waitForFunction(n => window.__ipc.filter(x => x.cmd === 'stealth_enter').length > n, before)
    assert.equal((await calls('stealth_enter')).at(-1).options.title, '文档1')
    // 任务栏 / 截图隐藏也即时交给原生层
    const n2 = (await calls('stealth_enter')).length
    await setStealthPref('skipTaskbar', true)
    await p.waitForFunction(n => window.__ipc.filter(x => x.cmd === 'stealth_enter').length > n, n2)
    assert.equal((await calls('stealth_enter')).at(-1).options.skipTaskbar, true)
    await setStealthPref('skipTaskbar', false)
    // 悬停顶部细条: 露出快捷键提示、背景 / 文字两个滑块与退出
    await p.locator('.stealth-strip').hover()
    await p.waitForFunction(() => getComputedStyle(document.querySelector('.stealth-exit')).opacity === '1')
    await p.locator('.stealth-hint', { hasText: 'Alt+Shift+Z 藏起' }).waitFor()
    assert.equal(await p.locator('.stealth-strip input[type=range]').count(), 2)
    await p.screenshot({ path: `${out}/stealth-strip.png` })
  })

  await step('boss key event is wired and handled without errors', async () => {
    assert.ok(await p.evaluate(() => !!window.__bossHandler), 'listens for stealth-boss')
    await p.evaluate(() => { window.__emitBoss(true); window.__emitBoss(false) })
  })

  await step('Esc leaves: window restored, toolbars back', async () => {
    await p.mouse.move(590, 400)
    await p.keyboard.press('Escape')
    await p.waitForFunction(() => !document.querySelector('.reader.stealth'))
    await p.waitForFunction(() => window.__ipc.some(x => x.cmd === 'stealth_exit'))
    assert.equal((await calls('stealth_exit')).length, 1)
    assert.equal(await p.evaluate(() => document.documentElement.classList.contains('lr-stealth')), false)
    await p.locator('.bar.top:not(.hidden)').waitFor()
    assert.notEqual(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)')
    // 摸鱼时的窗口位置大小记下来, 下次进入时交给原生层
    await p.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').stealth.bounds?.w === 640)
    assert.deepEqual((await settings()).stealth.bounds, { x: 40, y: 30, w: 640, h: 720 })
  })

  await step('auto-enter on opening a book; leaving the reader restores the window', async () => {
    await setStealthPref('autoEnter', true)
    await go('/library')
    await openBook()
    await p.locator('.reader.stealth').waitFor()
    await p.waitForFunction(n => window.__ipc.filter(x => x.cmd === 'stealth_enter').length > 0)
    assert.deepEqual((await calls('stealth_enter')).at(-1).options.bounds, { x: 40, y: 30, w: 640, h: 720 }, 'last stealth window position reused')
    assert.equal(await p.getByRole('dialog', { name: '已进入摸鱼模式' }).count(), 0, 'intro card only the first time')
    // 之后的进入不弹提示框挡正文, 只把顶部细条展开几秒再收起
    assert.equal(await p.locator('.toast').filter({ hasText: '摸鱼模式' }).count(), 0, 'no toast over the text on later entries')
    assert.ok(await p.locator('.stealth-strip.peek').count(), 'strip peeks open on entry')
    await p.locator('.stealth-strip:not(.peek)').waitFor({ timeout: 5000 })
    const exits = (await calls('stealth_exit')).length
    await go('/library')
    await p.locator('.library').waitFor()
    await p.waitForFunction(n => window.__ipc.filter(x => x.cmd === 'stealth_exit').length > n, exits)
    assert.equal((await calls('stealth_exit')).length, exits + 1)
    assert.equal(await p.evaluate(() => document.documentElement.classList.contains('lr-stealth')), false)
    await setStealthPref('autoEnter', false)
  })

  await step('PDF: enter from 视图, only pages remain, page fades, Esc leaves', async () => {
    const content = 'BT /F1 28 Tf 72 700 Td (Stealth PDF page) Tj ET'
    const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${content.length} >> stream
${content}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF`
    await go('/library')
    await p.setInputFiles('input[type=file][multiple]', { name: 'stealth-doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf, 'latin1') })
    await p.locator('.book-card').filter({ hasText: 'stealth-doc' }).click()
    await p.locator('.paper canvas').first().waitFor()
    const enters = (await calls('stealth_enter')).length
    await p.locator('.paper-header').getByRole('button', { name: /视图/ }).first().click()
    await p.getByRole('button', { name: '摸鱼模式', exact: true }).click()
    await p.locator('.paper.is-stealth').waitFor()
    await p.waitForFunction(n => window.__ipc.filter(x => x.cmd === 'stealth_enter').length > n, enters)
    const look = await p.evaluate(() => ({
      header: getComputedStyle(document.querySelector('.paper-header')).display,
      paper: getComputedStyle(document.querySelector('.paper')).backgroundColor,
      pane: getComputedStyle(document.querySelector('.pane-left, .paged-box')).backgroundColor,
      wrap: getComputedStyle(document.querySelector('.pane-left-wrap')).backgroundColor,
      holder: getComputedStyle(document.querySelector('.p-holder')).backgroundColor,
      inkFilter: getComputedStyle(document.querySelector('.p-canvas')).filter,
      inkOpacity: getComputedStyle(document.querySelector('.p-canvas')).opacity,
      matrix: !!document.querySelector('#lr-stealth-ink feColorMatrix'),
      strip: !!document.querySelector('.stealth-strip'),
      html: document.documentElement.classList.contains('lr-stealth'),
    }))
    assert.equal(look.header, 'none', 'toolbar hidden')
    assert.equal(look.paper, 'rgba(0, 0, 0, 0)')
    assert.equal(look.pane, 'rgba(0, 0, 0, 0)', 'no grey gutter around the pages')
    // 只留墨迹: 白纸透明 (页面底色按背景浓淡另画), 墨迹按文字浓淡淡化, 两者互不牵连
    assert.equal(look.wrap, 'rgba(255, 255, 255, 0.4)', 'paper colour follows background strength')
    assert.equal(look.holder, 'rgba(0, 0, 0, 0)', 'white page itself is transparent')
    assert.match(look.inkFilter, /lr-stealth-ink/)
    assert.equal(look.inkOpacity, '0.6', 'ink follows text strength only')
    assert.ok(look.matrix, 'ink filter defined')
    assert.ok(look.strip && look.html)
    await p.screenshot({ path: `${out}/stealth-pdf.png` })
    const exits = (await calls('stealth_exit')).length
    await p.keyboard.press('Escape')
    await p.waitForFunction(() => !document.querySelector('.paper.is-stealth'))
    await p.waitForFunction(n => window.__ipc.filter(x => x.cmd === 'stealth_exit').length > n, exits)
    assert.notEqual(await p.evaluate(() => getComputedStyle(document.querySelector('.paper-header')).display), 'none')
  })

  await step('settings: record a new boss key, clear it', async () => {
    await go('/settings?section=reading')
    const section = p.locator('#settings-reading')
    await section.getByText('老板键', { exact: true }).waitFor()
    await section.getByRole('button', { name: 'Alt+Shift+Z', exact: true }).click()
    await section.getByRole('button', { name: '请按下新的组合键（Esc 取消）' }).waitFor()
    await p.keyboard.press('Shift+K') // 只有 Shift 不接受
    await p.keyboard.press('Control+Alt+KeyK')
    await section.getByRole('button', { name: 'Ctrl+Alt+K', exact: true }).waitFor()
    await p.getByText('老板键已改为 Ctrl+Alt+K，下次进入摸鱼模式时生效').waitFor()
    assert.equal((await settings()).stealth.bossKey, 'Ctrl+Alt+K')
    await section.scrollIntoViewIfNeeded()
    await p.screenshot({ path: `${out}/settings.png`, fullPage: true })
    await section.getByRole('button', { name: '清除', exact: true }).click()
    assert.equal((await settings()).stealth.bossKey, '')
    await section.getByRole('button', { name: '未设置', exact: true }).waitFor()
  })

  assert.deepEqual(errors, [])
  await writeFile(`${out}/results.json`, JSON.stringify({ ok: true, results }, null, 2))
} catch (error) {
  await p.screenshot({ path: `${out}/failure.png` }).catch(() => {})
  await writeFile(`${out}/results.json`, JSON.stringify({ ok: false, results, errors, message: String(error?.message ?? error) }, null, 2))
  throw error
} finally {
  await browser.close()
}
