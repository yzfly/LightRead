// Windows 自绘窗口 (与 macOS 对齐: 无系统标题栏与深色细边框, 圆角) 的浏览器端到端:
// 网页版没有标题栏 → 模拟桌面 IPC (window_chrome 回 Windows 10) → 页面四角圆角、无边框线 → 非阅读页是原型 B「侧栏到顶」:
// 没有标题条, 侧栏直通到顶, 窗口按钮浮在右上角且不压住页面标题行的按钮, 顶行空白处拖动窗口 / 双击最大化, 控件上不拖 →
// 标题栏三个按钮调对应窗口命令 → 阅读页保留标题栏且顶栏不被盖住 → 最大化去圆角 → 摸鱼模式收起标题栏。
// 原生侧 (无装饰 / Windows 11 系统圆角 / 启动缩进工作区) 见 cargo test window_chrome 与真机验证。
//   E2E_BASE=http://localhost:4173 node scripts/e2e-window-chrome.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const base = process.env.E2E_BASE || 'http://localhost:4173'
const out = process.env.E2E_OUT || '/tmp/lightread-window-chrome'
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
p.on('pageerror', e => errors.push(e.message))
const step = async (name, fn) => { await fn(); console.log('PASS', name) }
const go = path => p.evaluate(path => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path), path)
const calls = () => p.evaluate(() => window.__ipc.map(x => x.cmd))
const rootClass = c => p.evaluate(c => document.documentElement.classList.contains(c), c)

const installDesktopIpc = () => p.evaluate(() => {
  let id = 0
  window.__ipc = []
  window.__maximized = false
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return ++id },
    unregisterCallback() {},
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    async invoke(cmd, args) {
      window.__ipc.push({ cmd, args })
      if (cmd === 'window_chrome') return { custom: true, nativeRound: false }
      if (cmd === 'plugin:window|is_maximized') return window.__maximized
      if (cmd === 'plugin:window|is_fullscreen') return !!window.__fullscreen
      if (cmd === 'plugin:window|set_fullscreen') window.__fullscreen = args.value
      if (cmd === 'plugin:window|unmaximize') window.__maximized = false
      if (cmd === 'plugin:window|maximize') window.__maximized = true
      if (cmd === 'stealth_enter') return { bossKey: true, bossKeyError: null }
      if (cmd === 'plugin:event|listen') return ++id
      return null
    },
  }
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
})

try {
  await step('web build: no title bar', async () => {
    await p.goto(base + '/#/library')
    await p.locator('.shell').waitFor()
    assert.equal(await p.locator('.titlebar').count(), 0)
    assert.equal(await rootClass('lr-chrome'), false)
  })

  await step('desktop Windows 10: title bar, rounded frame, no border line', async () => {
    await installDesktopIpc()
    await p.evaluate(() => window.__lrInitWindowChrome())
    await p.locator('.titlebar').waitFor()
    assert.equal(await rootClass('lr-chrome-round'), true)
    await p.waitForTimeout(150) // 底色有过渡, 等它走完再读计算样式
    const frame = await p.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.frame'))
      return { radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, overflow: cs.overflow, html: getComputedStyle(document.documentElement).backgroundColor, body: getComputedStyle(document.body).backgroundColor }
    })
    assert.notEqual(frame.radius, '0px', `radius 0: ${JSON.stringify(frame)}`)
    assert.equal(frame.border, '0px', 'no border line around the window')
    assert.equal(frame.overflow, 'hidden')
    assert.equal(frame.html, 'rgba(0, 0, 0, 0)', 'outside the rounded corners stays transparent')
    assert.equal(frame.body, 'rgba(0, 0, 0, 0)')
    await p.screenshot({ path: `${out}/library.png` })
    await p.evaluate(() => document.documentElement.dataset.theme = 'dark')
    await p.waitForTimeout(150)
    await p.screenshot({ path: `${out}/library-dark.png` })
    await p.evaluate(() => delete document.documentElement.dataset.theme)
  })

  await step('sidebar to the top: no title strip, controls float top-right clear of the page header', async () => {
    const box = await p.evaluate(() => {
      const r = s => document.querySelector(s)?.getBoundingClientRect()
      const controls = r('.titlebar .tb-controls')
      const header = [...document.querySelectorAll('.library > .toolbar button, .library > .toolbar input')].map(e => e.getBoundingClientRect()).filter(b => b.width)
      const btns = [...document.querySelectorAll('.titlebar .tb-btn')].map(e => e.getBoundingClientRect())
      const mid = b => b.top + b.height / 2
      const row = header.filter(b => b.top < controls.bottom)
      return {
        shell: r('.shell').top, sidebar: r('.sidebar').top, controls, h1: r('.library > .toolbar h1'),
        overlap: header.filter(b => b.right > controls.left && b.top < controls.bottom).length,
        // 2026-11-09 用户: 右侧顶栏元素水平对齐, 与窗口边留空, 元素之间有呼吸感
        midDiff: Math.max(...row.map(b => Math.abs(mid(b) - mid(btns[0])))),
        gapToControls: btns[0].left - Math.max(...row.map(b => b.right)),
        rightMargin: innerWidth - btns[2].right,
        btnGap: btns[1].left - btns[0].right,
      }
    })
    assert.equal(Math.round(box.shell), 0, 'no title strip above the page')
    assert.equal(Math.round(box.sidebar), 0, 'sidebar reaches the top edge')
    assert.equal(Math.round(box.controls.top), 0, 'window buttons are full-height at the top edge')
    assert.ok(box.controls.height >= 40, `window buttons ${box.controls.height}px tall`)
    assert.ok(box.h1.top < box.controls.bottom, 'page title shares the top row with the window buttons')
    assert.equal(box.overlap, 0, 'header buttons stay clear of the window buttons')
    assert.ok(box.midDiff <= 1, `top row shares one midline with the window buttons (off by ${box.midDiff}px)`)
    assert.ok(box.gapToControls >= 16, `breathing room before the window buttons: ${box.gapToControls}px`)
    assert.ok(box.rightMargin >= 8, `close button keeps off the window edge: ${box.rightMargin}px`)
    assert.ok(box.btnGap >= 2, `window buttons are spaced: ${box.btnGap}px`)
  })

  await step('top row: empty space drags / double-click maximizes, controls do not', async () => {
    const count = c => p.evaluate(c => window.__ipc.filter(x => x.cmd === c).length, c)
    const h1 = await p.locator('.library > .toolbar h1').boundingBox()
    await p.mouse.click(h1.x + 4, h1.y + h1.height / 2)
    await p.waitForFunction(() => window.__ipc.some(x => x.cmd === 'plugin:window|start_dragging'))
    const logo = await p.locator('.sidebar .logo').boundingBox()
    await p.mouse.dblclick(logo.x + logo.width - 4, logo.y + logo.height / 2)
    await p.waitForFunction(() => window.__ipc.some(x => x.cmd === 'plugin:window|toggle_maximize'))
    const drags = await count('plugin:window|start_dragging')
    await p.locator('.library > .toolbar input').first().click()
    await p.locator('.nav-item').first().click({ position: { x: 20, y: 10 } }).catch(() => {})
    await p.waitForTimeout(100)
    assert.equal(await count('plugin:window|start_dragging'), drags, 'clicking controls in the top row does not drag the window')
    await p.keyboard.press('Escape')
  })

  await step('title bar buttons call window commands', async () => {
    await p.getByRole('button', { name: '最小化' }).click()
    await p.getByRole('button', { name: '最大化' }).click()
    await p.getByRole('button', { name: '关闭' }).click()
    for (const c of ['plugin:window|minimize', 'plugin:window|toggle_maximize', 'plugin:window|close']) {
      await p.waitForFunction(c => window.__ipc.some(x => x.cmd === c), c).catch(() => {})
      assert.ok((await calls()).includes(c), `${c} in ${(await calls()).join(',')}`)
    }
  })

  await step('reader: keeps a title bar strip, toolbar sits below it', async () => {
    await p.setInputFiles('input[type=file][multiple]', { name: '窗口验收.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章\n\n' + '一段正文。'.repeat(400)) })
    await p.locator('.book-card').filter({ hasText: '窗口验收' }).click()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length)
    await p.mouse.move(500, 60)
    await p.waitForTimeout(300)
    const r = await p.evaluate(() => {
      const bar = document.querySelector('.titlebar').getBoundingClientRect()
      const header = document.querySelector('.reader header, .reader .toolbar, .reader .topbar')?.getBoundingClientRect()
      return { bar: bar.bottom, header: header?.top ?? null }
    })
    assert.ok(r.header !== null && r.header >= r.bar - 0.5, `reader header ${r.header} below title bar ${r.bar}`)
    assert.equal(await p.locator('.titlebar[data-tauri-drag-region]:not(.is-overlay)').count(), 1, 'reader title bar is a drag region')
    await p.screenshot({ path: `${out}/reader.png` })
  })

  await step('fullscreen from maximized: restore first, maximize again on leaving', async () => {
    await p.evaluate(() => { window.__maximized = true; window.__ipc.length = 0 })
    await p.mouse.move(500, 60)
    await p.getByRole('button', { name: '全屏阅读' }).click()
    await p.waitForFunction(() => window.__ipc.some(x => x.cmd === 'plugin:window|set_fullscreen'))
    const seq = () => p.evaluate(() => window.__ipc.map(x => x.cmd).filter(c => /unmaximize|\|maximize|set_fullscreen/.test(c)))
    assert.deepEqual(await seq(), ['plugin:window|unmaximize', 'plugin:window|set_fullscreen'])
    assert.equal(await rootClass('lr-fullscreen'), true, 'title bar collapses in fullscreen')
    await p.locator('.fs-exit').click()
    await p.waitForFunction(() => window.__ipc.some(x => x.cmd === 'plugin:window|maximize'))
    assert.deepEqual(await seq(), ['plugin:window|unmaximize', 'plugin:window|set_fullscreen', 'plugin:window|set_fullscreen', 'plugin:window|maximize'])
    await p.evaluate(() => { window.__maximized = false; document.documentElement.classList.remove('lr-max') })
  })

  await step('maximized: square corners; stealth: title bar hidden', async () => {
    await p.evaluate(() => { window.__maximized = true; document.documentElement.classList.add('lr-max') })
    await p.waitForTimeout(150)
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.frame')).borderTopLeftRadius), '0px')
    await p.evaluate(() => { window.__maximized = false; document.documentElement.classList.remove('lr-max') })
    await p.evaluate(() => document.documentElement.classList.add('lr-stealth'))
    assert.equal(await p.locator('.titlebar').isVisible(), false)
    await p.evaluate(() => document.documentElement.classList.remove('lr-stealth'))
  })

  assert.deepEqual(errors, [])
  console.log('window chrome e2e ok')
} finally {
  await browser.close()
}
