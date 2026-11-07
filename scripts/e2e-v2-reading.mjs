// App 2.0 behavioral regression. AI and system audio are controlled fixtures;
// real book rendering, settings, highlighting and playback orchestration run unchanged.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile, rm } from 'node:fs/promises'
const base = process.env.E2E_BASE || 'http://localhost:4188'
const out = process.env.E2E_OUT || '/tmp/lightread-v2-reading'
await mkdir(out, { recursive: true })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 392, height: 850 }, hasTouch: true, isMobile: true, locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block' })
await ctx.addInitScript(() => {
  localStorage.setItem('lightread-language', 'zh')
  if (!localStorage.getItem('lightread-settings')) localStorage.setItem('lightread-settings', JSON.stringify({ version: 14, ttsEngine: 'system', language: 'zh' }))
  const speech = { current: null, queue: [], spoken: [], paused: false, fail: false,
    getVoices: () => [{ name: 'QA Chinese', lang: 'zh-CN', default: true }],
    addEventListener() {}, removeEventListener() {},
    speak(u) { this.queue.push(u); this.pump() },
    pump() { if (this.current || this.paused || !this.queue.length) return; const u = this.current = this.queue.shift(); this.spoken.push({text:u.text, rate:u.rate}); u.onstart?.(); if (this.fail) setTimeout(() => { if (this.current !== u) return; this.current = null; u.onerror?.({error:'synthesis-failed'}); this.pump() },10) },
    cancel() { this.current = null; this.queue = []; this.paused = false },
    pause() { this.paused = true }, resume() { this.paused = false; this.pump() },
    finish() { const u = this.current; this.current = null; u?.onend?.(); this.pump() },
  }
  Object.defineProperty(window, 'speechSynthesis', { value: speech, configurable: true })
  window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text } }
})
let aiCalls = 0, aiStatus = 200
await ctx.route('**/dianjing', async route => {
  aiCalls++
  const req = route.request().postDataJSON()
  if (aiStatus !== 200) return route.fulfill({ status: aiStatus, contentType: 'application/json', body: JSON.stringify({ error: { code: 'quota', message: 'QA quota' } }) })
  const s = req.text.match(/\[(\d+\.\d+)\]/)?.[1] || '1.1'
  const rows = req.mode === 'summary' ? [{ t: 'sum', text: '测试章节讨论人与人的交往。' }, { t: 'pt', s, text: '从经验理解主体间性。' }] : [{ t: 'meta', fiction: false }, { t: 'key', s, r: 3, why: '测试要句' }, { t: 'kw', q: '主体间性', r: 3 }]
  await route.fulfill({ contentType: 'application/x-ndjson', headers: { 'x-dj-remaining': '10000' }, body: rows.map(x => JSON.stringify(x)).join('\n') + '\n' })
})
const p = await ctx.newPage(); p.setDefaultTimeout(12000)
let ok = false
const errors = [], results = []
p.on('pageerror', e => errors.push(e.message))
const step = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name) }
const settings = () => p.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('settings').$state)
const reveal = async () => {
  await p.evaluate(() => document.querySelector('.content')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  if (!await p.locator('footer.bar.bottom:not(.hidden)').count()) await p.mouse.click(196, 350)
}
const modes = async () => { if (!await p.locator('.rm-panel').count()) { await reveal(); await p.locator('.dock button').nth(3).click() } }
const details = async () => { await modes(); if (!await p.locator('.dj-settings').count()) await p.locator('.dj-adjust').click() }
const highlights = () => p.evaluate(() => document.querySelector('foliate-view').renderer.getContents().flatMap(({doc}) => [...doc.defaultView.CSS.highlights].map(([name,ranges]) => ({ name, text: [...ranges].map(r => r.toString()) }))))
const waitHighlight = prefix => p.waitForFunction(prefix => document.querySelector('foliate-view')?.renderer?.getContents?.().some(({doc}) => [...doc.defaultView.CSS.highlights].some(([name,ranges]) => name.startsWith(prefix) && ranges.size)), prefix)
const auditPanel = async (selector, label) => {
  for(const [width,height] of [[320,568],[392,850],[768,1024],[850,392]]) {
    await p.setViewportSize({width,height})
    await p.evaluate(() => document.documentElement.style.setProperty('--lr-safe-top', '32px'))
    for(const theme of ['light','dark']) {
      await p.evaluate(theme => document.documentElement.dataset.theme = theme, theme)
      const bad = await p.locator(selector).evaluate(root => {
        const issues=[]
        if(root.scrollWidth > root.clientWidth+1) issues.push('panel overflows horizontally')
        const header=root.querySelector('.tts-head')
        if(header) {
          const title=header.querySelector('strong').getBoundingClientRect()
          if (title.top < 32) issues.push('player title overlaps system status bar')
          for(const el of header.querySelectorAll('button')) {
            const r=el.getBoundingClientRect()
            if (r.top < 32) issues.push('player control overlaps system status bar')
            if(r.left<title.right && r.right>title.left && r.top<title.bottom && r.bottom>title.top) issues.push('player title overlaps '+el.textContent.trim())
          }
        }
        return issues
      })
      assert.deepEqual(bad,[],`${label} ${width} ${theme}`)
      await p.screenshot({path:`${out}/${label}-${width}-${theme}.png`,animations:'disabled'})
    }
  }
  await p.setViewportSize({width:392,height:850})
  await p.evaluate(() => { document.documentElement.dataset.theme='light'; document.documentElement.style.removeProperty('--lr-safe-top') })
}
const spoken = () => p.evaluate(() => speechSynthesis.spoken.at(-1))
const nextSpoken = async action => { const n = await p.evaluate(() => speechSynthesis.spoken.length); await action(); await p.waitForFunction(n => speechSynthesis.spoken.length > n, n) }
try {
  await step('import and render two chapters', async () => {
    await p.goto(base + '/#/library')
    const para = Array.from({length: 24}, (_,i) => `第${i+1}段讨论主体间性，作者解释人与人的交往。这是第${i+1}段的第二句。读者从不同的经验理解这个概念。`).join('\n\n')
    await p.setInputFiles('input[type=file][multiple]', { name: '正确性验证.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 经验与交往\n\n'+para+'\n\n第二章 阅读与思考\n\n'+para) })
    await p.locator('.book-card').filter({hasText:'正确性验证'}).click()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length)
  })
  await step('basic Dianjing paints boundaries and keywords; density/color persist', async () => {
    await modes(); await p.locator('.dj-switch input').check()
    await waitHighlight('lr-wg-')
    assert.equal(aiCalls, 0)
    await details(); await p.getByRole('button', {name:'重点词',exact:true}).click()
    await waitHighlight('lr-wg-kw-')
    assert.ok((await highlights()).some(x => x.text.includes('主体间性')))
    await p.locator('.dj-settings').getByRole('button',{name:'多',exact:true}).click()
    const swatch = p.locator('.dj-swatch').last(); await swatch.click()
    assert.equal(await swatch.getAttribute('aria-checked'), 'true')
    assert.equal((await settings()).dianjing.density, 'high')
    await p.screenshot({path:out+'/dianjing-basic.png', animations:'disabled'}); await auditPanel('.rm-panel','basic')
    await p.locator('.dj-settings .dj-switch input').uncheck()
    await p.waitForFunction(() => document.querySelector('foliate-view').renderer.getContents().every(({doc}) => ![...doc.defaultView.CSS.highlights].some(([name,ranges]) => name.startsWith('lr-wg-') && ranges.size)))
    await p.locator('.dj-settings .dj-switch input').check()
  })
  await step('smart consent cancellation preserves basic; consent paints AI marks', async () => {
    await p.getByRole('button',{name:'智能',exact:true}).click()
    await p.locator('.dj-consent').waitFor(); assert.equal(aiCalls, 0)
    for (let i=0;i<8;i++) { await p.keyboard.press('Tab'); assert.ok(await p.evaluate(() => !!document.activeElement.closest('.dj-consent')), 'consent keeps keyboard focus inside') }
    await p.getByRole('button',{name:'暂不开启',exact:true}).click()
    assert.equal((await settings()).dianjing.level, 'basic')
    await details(); await p.getByRole('button',{name:'智能',exact:true}).click()
    await p.getByRole('button',{name:'仅本书开启',exact:true}).click()
    await p.waitForFunction(() => JSON.parse(localStorage.getItem('lightread-settings')).dianjing.level === 'smart')
    await waitHighlight('lr-dj-'); assert.ok(aiCalls > 0)
    await details(); await p.screenshot({path:out+'/dianjing-smart.png', animations:'disabled'}); await auditPanel('.rm-panel','smart')
  })
  await step('smart fine density is adjustable and shared with basic mode', async () => {
    await details()
    const slider = p.locator('.dj-density input[type=range]')
    await slider.fill('63'); await slider.dispatchEvent('input')
    await p.waitForFunction(() => JSON.parse(localStorage.getItem('lightread-settings')).dianjing.densityFine?.value === 63)
    await p.getByRole('button', {name:'基础',exact:true}).click()
    assert.equal(await slider.inputValue(), '63')
    await p.getByRole('button', {name:'智能',exact:true}).click()
    assert.equal(await slider.inputValue(), '63')
    await waitHighlight('lr-dj-')
  })
  await step('smart outline and skim display marks and navigate to original text', async () => {
    await p.locator('.dj-settings').getByRole('button',{name:'脉络',exact:true}).click()
    await p.locator('.dj-outline .dj-key').first().waitFor()
    for(let i=0;i<8;i++) { await p.keyboard.press('Tab'); assert.ok(await p.evaluate(() => !!document.activeElement.closest('.dj-outline')), 'outline keeps focus') }
    await p.locator('.dj-outline .dj-key').first().click(); await p.locator('.dj-outline').waitFor({state:'hidden'})
    await details(); await p.locator('.dj-settings').getByRole('button',{name:'速读视图',exact:true}).click()
    await p.locator('.dj-skim-key').first().click(); await p.locator('.dj-skim').waitFor({state:'hidden'})
    await details()
  })
  await step('smart quota error offers working basic fallback', async () => {
    // A nested modal must dismiss before routing to repair an AI configuration error.
    aiStatus = 401
    await p.locator('.dj-settings').getByRole('button',{name:'重新点睛本章',exact:true}).click()
    const readerUrl = p.url()
    await p.locator('.dj-settings').getByRole('button',{name:'去设置',exact:true}).click()
    await p.waitForURL('**/#/settings')
    await p.goto(readerUrl); await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length)
    await details()
    aiStatus = 429
    await p.locator('.dj-settings').getByRole('button',{name:'重新点睛本章',exact:true}).click()
    await p.locator('.dj-settings').getByRole('button',{name:'先用基础版',exact:true}).click()
    assert.equal((await settings()).dianjing.level, 'basic'); await waitHighlight('lr-wg-kw-')
    await p.locator('.dj-settings .dj-switch input').uncheck()
    await p.keyboard.press('Escape'); await p.locator('.rm-close').click()
  })
  await step('player start, pause, resume, sentence and paragraph navigation', async () => {
    await reveal(); await p.locator('.listen-entry').click()
    await nextSpoken(() => p.locator('.tts-play').click())
    await p.locator('.tts-play[aria-label="暂停"]').waitFor()
    const first = await spoken(); assert.ok(first.text)
    await p.locator('.tts-play').click(); assert.equal(await p.evaluate(() => speechSynthesis.paused), true)
    await p.locator('.tts-play[aria-label="继续"]').click(); assert.equal(await p.evaluate(() => speechSynthesis.paused), false)
    await nextSpoken(() => p.getByRole('button',{name:'下一句',exact:true}).click())
    const second = await spoken(); assert.notEqual(second.text, first.text)
    await nextSpoken(() => p.getByRole('button',{name:'上一句',exact:true}).click()); assert.equal((await spoken()).text, first.text)
    await nextSpoken(() => p.getByRole('button',{name:'下一段',exact:true}).click())
    await p.screenshot({path:out+'/listening.png', animations:'disabled'})
  })
  await step('paused seeking preserves pause and resumes from the selected sentence', async () => {
    await p.locator('.tts-play[aria-label="暂停"]').click()
    for (const label of ['下一句', '上一句', '下一段', '上一段']) {
      const count = await p.evaluate(() => speechSynthesis.spoken.length)
      const quote = await p.locator('.listen-quote').innerText()
      await p.getByRole('button', { name: label, exact: true }).click()
      await p.waitForTimeout(700)
      assert.equal(await p.locator('.tts-play').getAttribute('aria-label'), '继续')
      assert.equal(await p.evaluate(() => speechSynthesis.spoken.length), count, 'paused seek must not synthesize or play')
      assert.notEqual(await p.locator('.listen-quote').innerText(), quote)
    }
    const target = await p.locator('.listen-quote').innerText()
    await nextSpoken(() => p.locator('.tts-play').click())
    assert.equal((await spoken()).text.trim(), target.trim())
  })
  await step('stopping a pending skip does not restart a later playback session', async () => {
    await p.getByRole('button',{name:'下一段',exact:true}).click()
    await p.locator('.tts-panel').getByRole('button',{name:'停止',exact:true}).click()
    await nextSpoken(() => p.locator('.tts-play').click())
    const n=await p.evaluate(() => speechSynthesis.spoken.length)
    await p.waitForTimeout(600) // The cancelled skip used to fire after its 350ms debounce.
    assert.equal(await p.evaluate(() => speechSynthesis.spoken.length),n)
  })
  await step('speed change, timer set/cancel, nested Escape preserves player', async () => {
    await p.locator('.listen-options button').nth(2).click()
    const range = p.locator('[data-app-modal] input[type=range]')
    await range.fill('1.5'); await range.dispatchEvent('input')
    assert.equal((await settings()).ttsRate,1.5)
    await p.keyboard.press('Escape'); assert.equal(await p.locator('[data-app-modal]').count(),0); assert.equal(await p.locator('.tts-panel').count(),1)
    await nextSpoken(() => p.evaluate(() => speechSynthesis.finish()))
    assert.equal((await spoken()).rate,1.5, 'next sentence uses selected rate')
    await p.locator('.listen-options button').nth(1).click()
    await p.locator('[data-app-modal] .app-select-trigger').click()
    await p.getByRole('button',{name:'QA Chinese (zh-CN)',exact:true}).click()
    await p.keyboard.press('Escape'); assert.equal((await settings()).ttsVoice,'QA Chinese'); assert.equal(await p.locator('.listen-options button').nth(1).locator('strong').innerText(),'QA Chinese')
    await p.locator('.listen-options button').first().click()
    await p.getByRole('button',{name:'15 分钟',exact:true}).click(); await p.keyboard.press('Escape')
    assert.equal(await p.locator('.tts-sleep-badge').count(),1); await auditPanel('.tts-panel','player-timer')
    await p.locator('.tts-sleep-badge').click(); assert.equal(await p.locator('.tts-sleep-badge').count(),0)
  })
  await step('listen TOC changes spoken chapter and original text preserves playback', async () => {
    await p.locator('.listen-links').getByRole('button',{name:'目录',exact:true}).click()
    await nextSpoken(() => p.locator('.panel').getByText('第二章 阅读与思考',{exact:true}).click())
    await p.locator('.tts-panel').waitFor(); assert.match(await p.locator('.listen-hero p').innerText(),/第二章/)
    await p.locator('.listen-links').getByRole('button',{name:'原文',exact:true}).click()
    assert.equal(await p.locator('.tts-panel').count(),0)
    assert.ok(await p.evaluate(() => !!speechSynthesis.current))
    await reveal(); await p.locator('.dock button').first().click()
    await p.locator('.panel').getByText('第一章 经验与交往',{exact:true}).click()
    await reveal(); await p.locator('.listen-capsule.lc-bar .lc-main').click()
    assert.match(await p.locator('.tts-progress-chapter').innerText(),/第二章/, 'listening progress follows spoken chapter while browsing another')
    await p.locator('.tts-notice').getByRole('button',{name:'回到听书处',exact:true}).click()
    await p.locator('.tts-panel').getByRole('button',{name:'停止',exact:true}).click()
  })
  await step('chapter timer stops at the spoken chapter boundary while browsing elsewhere', async () => {
    await p.locator('.listen-links').getByRole('button',{name:'目录',exact:true}).click()
    await nextSpoken(() => p.locator('.panel').getByText('第一章 经验与交往',{exact:true}).click())
    await p.locator('.listen-options button').first().click()
    await p.getByRole('button',{name:'听完本章',exact:true}).click(); await p.keyboard.press('Escape')
    await p.locator('.listen-links').getByRole('button',{name:'原文',exact:true}).click()
    await reveal(); await p.locator('.dock button').first().click()
    await p.locator('.panel').getByText('第二章 阅读与思考',{exact:true}).click()
    await reveal(); await p.locator('.listen-capsule.lc-bar .lc-main').click()
    assert.equal(await p.locator('.tts-play').getAttribute('aria-label'),'暂停')
    for(let i=0;i<100 && await p.locator('.tts-play').getAttribute('aria-label') === '暂停';i++) {
      await nextSpoken(() => p.evaluate(() => speechSynthesis.finish()))
    }
    assert.equal(await p.locator('.tts-play').getAttribute('aria-label'),'继续')
    assert.match(await p.locator('.listen-hero p').innerText(),/第二章/)
    assert.equal(await p.locator('.tts-sleep-badge').count(),0)
    await p.locator('.tts-panel').getByRole('button',{name:'停止',exact:true}).click()
  })
  await step('settings and reading location survive reload; leaving reader stops speech', async () => {
    const chapterBefore=await p.locator('.book-title .chapter').innerText()
    await p.goto(base+'/#/library'); assert.equal(await p.evaluate(() => speechSynthesis.current),null)
    await p.reload(); assert.equal((await settings()).ttsRate,1.5)
    await p.locator('.book-card').filter({hasText:'正确性验证'}).click()
    await p.waitForFunction(() => document.querySelector('foliate-view')?.renderer?.getContents?.().length)
    await p.waitForFunction(chapter => document.querySelector('.book-title .chapter')?.textContent === chapter,chapterBefore)
    await reveal(); await p.locator('.listen-entry').click()
    await p.evaluate(() => speechSynthesis.fail = true)
    await p.locator('.tts-play').click(); await p.locator('.listen-state.error').waitFor()
    assert.equal(await p.locator('.tts-play').getAttribute('aria-label'),'开始听书')
  })
  assert.deepEqual(errors, []); ok = true
} catch(error) {
  await p.screenshot({path:out+'/failure.png'}); console.error(await p.locator('body').innerText()); throw error
} finally {
  await writeFile(out+'/results.json',JSON.stringify({ok,passed:results,errors,aiCalls},null,2)); if(ok) await rm(out+'/failure.png',{force:true}); await browser.close()
}
