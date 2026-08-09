// 论文阅读器验证: 导入多页 PDF → 连续滚动 → 缩放 → 目录 → 链接跳转/返回 → 划词高亮 → 持久化
// → Web 端不暴露原生 Agent → 划词翻译 → 整页翻译
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

// ---- Mock OpenAI 兼容 SSE 服务: 固定流式返回, 供 AI 功能全链路验证 ----
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, accept, x-device-id',
}
const mockAi = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', ...CORS })
  const chunks = ['[[1]] MOCK', '答复甲 ', '[[2]] MOCK答复乙 ', '[[3]] MOCK答复丙']
  let i = 0
  const timer = setInterval(() => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
    } else {
      clearInterval(timer)
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }, 25)
})
mockAi.listen(9876)

const TMP = '/tmp/lightread-paper-verify'
mkdirSync(join(TMP, 'shots'), { recursive: true })

// 4 页 PDF: 每页有文本; 第 1 页有跳到第 3 页的链接注解; 带 2 项大纲
function page(n, contents, extra = '') {
  return `${n} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 30 0 R >> >>${extra} >> endobj`
}
function stream(n, lines) {
  const body = 'BT /F1 18 Tf ' + lines.map(([x, y, s]) => `1 0 0 1 ${x} ${y} Tm (${s}) Tj`).join(' ') + ' ET'
  return `${n} 0 obj << /Length ${body.length} >> stream\n${body}\nendstream endobj`
}
const pdfContent = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R /Outlines 20 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >> endobj
${page(3, 7, ' /Annots [11 0 R]')}
${page(4, 8)}
${page(5, 9)}
${page(6, 10)}
${stream(7, [[72, 700, 'Deep Learning Survey Page One'], [72, 660, 'See results in section three below'], [72, 620, 'The quick brown fox jumps over the lazy dog']])}
${stream(8, [[72, 700, 'Method Page Two'], [72, 660, 'We propose a novel architecture here']])}
${stream(9, [[72, 700, 'Results Page Three'], [72, 660, 'Accuracy improves by twenty percent']])}
${stream(10, [[72, 700, 'Conclusion Page Four'], [72, 660, 'Future work remains open']])}
11 0 obj << /Type /Annot /Subtype /Link /Rect [70 650 320 675] /Border [0 0 0] /Dest [5 0 R /XYZ 0 792 null] >> endobj
20 0 obj << /Type /Outlines /First 21 0 R /Last 22 0 R /Count 2 >> endobj
21 0 obj << /Title (Introduction) /Parent 20 0 R /Dest [3 0 R /XYZ 0 792 null] /Next 22 0 R >> endobj
22 0 obj << /Title (Results) /Parent 20 0 R /Dest [5 0 R /XYZ 0 792 null] /Prev 21 0 R >> endobj
30 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 31 >>
%%EOF`
const pdfPath = join(TMP, 'survey-paper.pdf')
writeFileSync(pdfPath, pdfContent)

const browser = await chromium.launch()
const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } })

function installPaperAgentBridge() {
  const listeners = new Set()
  const events = { codex: { chat: [], worksheet: [] }, claude: { chat: [], worksheet: [] }, pi: { chat: [], worksheet: [] } }
  const sequences = { codex: { chat: 0, worksheet: 0 }, claude: { chat: 0, worksheet: 0 }, pi: { chat: 0, worksheet: 0 } }
  let active = null
  const worksheetKey = 'lightread-agent-test-worksheet'
  const defaultWorksheet = () => ({
    version: 1,
    questions: Array.from({ length: 10 }, (_, index) => ({
      id: `q${index + 1}`, aiInitial: null, humanDraft: '', humanEditRevision: 0,
      humanCommitted: '', humanCommittedRevision: 0, aiReanswer: null, pending: null,
    })),
    updatedAtMs: Date.now(),
  })
  const loadWorksheet = () => JSON.parse(localStorage.getItem(worksheetKey) || JSON.stringify(defaultWorksheet()))
  const saveWorksheet = value => {
    value.updatedAtMs = Date.now()
    localStorage.setItem(worksheetKey, JSON.stringify(value))
    return structuredClone(value)
  }
  const emit = (info, payload) => {
    const sequence = ++sequences[info.engine][info.conversation]
    const event = {
      ...info, sequence, timestampMs: Date.now(), payload,
    }
    events[info.engine][info.conversation].push(event)
    for (const listener of listeners) listener(structuredClone(event))
  }
  window.__LIGHTREAD_PAPER_AGENT_TEST_BRIDGE__ = {
    listen(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async invoke(command, args) {
      if (command === 'agent_engine_status') {
        return {
          engine: args.engine, found: true, compatible: true, authenticated: true,
          path: `/mock/${args.engine}`, version: `${args.engine}-mock 1.0.0`,
          reason: 'mock ready', approvalPosture: 'Mock native approval behavior',
        }
      }
      if (command === 'agent_snapshot_begin') {
        return {
          token: `snapshot-${Date.now()}`, needsText: true, sourceSha256: 'sha256:' + '1'.repeat(64),
          currentPaperPath: '/tmp/lightread-agent-test/current-paper',
          workspacePath: '/tmp/lightread-agent-test/workspace',
        }
      }
      if (command === 'agent_snapshot_append_text' || command === 'agent_snapshot_abort') return null
      if (command === 'agent_snapshot_finalize') {
        return {
          revision: args.snapshotRevision, sourceSha256: 'sha256:' + '1'.repeat(64), fileHashes: {},
          currentPaperPath: '/tmp/lightread-agent-test/current-paper',
          workspacePath: '/tmp/lightread-agent-test/workspace',
        }
      }
      if (command === 'agent_replay_events') {
        return events[args.engine][args.conversation].filter(event => event.sequence > (args.afterSequence || 0))
      }
      if (command === 'agent_active_turn') return active
      if (command === 'agent_worksheet_load') return structuredClone(loadWorksheet())
      if (command === 'agent_worksheet_save_draft') {
        const worksheet = loadWorksheet()
        const question = worksheet.questions.find(item => item.id === args.questionId)
        if (question.humanEditRevision !== args.expectedEditRevision) throw new Error('revision conflict')
        if (question.humanDraft !== args.text) {
          question.humanDraft = args.text
          question.humanEditRevision += 1
          if (question.aiReanswer) question.aiReanswer.stale = true
        }
        return saveWorksheet(worksheet)
      }
      if (command === 'agent_worksheet_commit_human') {
        const worksheet = loadWorksheet()
        const question = worksheet.questions.find(item => item.id === args.questionId)
        if (question.humanEditRevision !== args.expectedEditRevision) throw new Error('revision conflict')
        question.humanCommitted = question.humanDraft
        question.humanCommittedRevision += 1
        return saveWorksheet(worksheet)
      }
      if (command === 'agent_start_turn') {
        if (active) throw new Error('another Agent turn is already active for this paper')
        const request = args.request
        const info = {
          paperId: request.paperId, engine: request.engine, conversation: request.conversation,
          conversationId: request.conversationId, turnId: `turn-${Date.now()}`,
          contextRevision: request.contextRevision, stopping: false,
        }
        active = info
        emit(info, { type: 'user_message', text: request.message })
        if (request.conversation === 'chat') {
          emit(info, {
            type: 'interaction_requested', requestId: `request-${info.turnId}`,
            prompt: 'Mock native permission',
            choices: [{ value: 'true', label: 'Confirm', description: '' }],
            inputAllowed: false,
          })
        }
        if (request.conversation === 'worksheet') {
          const worksheet = loadWorksheet()
          const question = worksheet.questions.find(item => item.id === request.worksheet.questionId)
          question.pending = {
            phase: request.worksheet.phase, engine: request.engine, turnId: info.turnId,
            contextRevision: request.contextRevision, humanRevision: request.worksheet.humanRevision,
            humanEditRevision: request.worksheet.humanEditRevision, startedAtMs: Date.now(),
          }
          saveWorksheet(worksheet)
        }
        setTimeout(() => {
          if (active?.turnId !== info.turnId) return
          const text = request.conversation === 'worksheet'
            ? request.worksheet.phase === 'initial' ? 'MOCK AI 初答：论文提出新架构并报告准确率提升。' : 'MOCK AI 再答：结合人工修订，20% 提升仍需核对基线。'
            : 'MOCK Agent 已读取第 4 页结论与读者笔记。'
          emit(info, { type: 'text_delta', text })
          if (request.conversation === 'worksheet') {
            const worksheet = loadWorksheet()
            const question = worksheet.questions.find(item => item.id === request.worksheet.questionId)
            const answer = {
              text, engine: request.engine, turnId: info.turnId,
              nativeSessionId: `session-${request.engine}`, nativeTurnId: `native-${info.turnId}`,
              contextRevision: request.contextRevision,
              humanRevision: request.worksheet.humanRevision,
              humanEditRevision: request.worksheet.humanEditRevision,
              completedAtMs: Date.now(), stale: false,
            }
            if (request.worksheet.phase === 'initial') {
              question.aiInitial = answer
              if (!question.humanDraft) {
                question.humanDraft = text
                question.humanEditRevision = 1
              }
            } else question.aiReanswer = answer
            question.pending = null
            saveWorksheet(worksheet)
          }
          emit(info, { type: 'message_completed', text })
          emit(info, { type: 'turn_completed' })
          active = null
        }, 700)
        return structuredClone(info)
      }
      if (command === 'agent_stop_turn') {
        if (active) emit(active, { type: 'turn_interrupted', reason: 'mock stop' })
        active = null
        return null
      }
      if (command === 'agent_respond_interaction') return null
      if (command === 'agent_reset_session' || command === 'agent_cleanup_paper') return null
      throw new Error(`Unhandled mock Agent command: ${command}`)
    },
  }
}
// 注入 AI 配置指向 mock 服务 (页面脚本执行前)
await pg.addInitScript(() => {
  if (!localStorage.getItem('lightread-settings')) {
    localStorage.setItem(
      'lightread-settings',
      JSON.stringify({ version: 5, aiProvider: 'custom', aiBaseUrl: 'http://127.0.0.1:9876/v1', aiApiKey: '', aiModel: 'mock-1' }),
    )
  }
})
const errors = []
pg.on('pageerror', e => errors.push('PAGE_ERROR: ' + e.message))
pg.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()) })

let failed = 0
const step = async (name, fn) => {
  try {
    await fn()
    console.log('✅', name)
  } catch (e) {
    failed++
    console.log('❌', name, '—', e.message.split('\n')[0])
    await pg.screenshot({ path: join(TMP, 'shots', `fail-${name.replace(/\W+/g, '_')}.png`) })
  }
}

await step('打开论文页', async () => {
  await pg.goto('http://localhost:4173/#/papers', { waitUntil: 'networkidle' })
  await pg.waitForSelector('input[type=file]', { state: 'attached', timeout: 8000 })
})

await step('导入 PDF 论文', async () => {
  await pg.setInputFiles('input[type=file][multiple]', pdfPath)
  await pg.waitForSelector('.book-card', { timeout: 15000 })
})

await step('打开论文: 连续滚动渲染多页', async () => {
  await pg.click('.book-card')
  await pg.waitForSelector('.p-holder canvas', { timeout: 15000 })
  const holders = await pg.locator('.p-holder').count()
  if (holders !== 4) throw new Error(`页容器数 ${holders} != 4`)
  // 视口附近页应已渲染 canvas
  await pg.waitForFunction(() => document.querySelectorAll('.p-holder canvas').length >= 2, null, { timeout: 8000 })
})

await step('缩略图侧栏: 懒渲染、当前页高亮与点击跳转', async () => {
  await pg.click('button[title="缩略图"]')
  await pg.waitForSelector('.side-drawer', { state: 'visible', timeout: 3000 })
  const tabs = await pg.locator('.drawer-tabs [role="tab"]').allTextContents()
  for (const expected of ['目录', '缩略图', '划线想法']) {
    if (!tabs.some(text => text.trim() === expected)) throw new Error(`缺少侧栏标签: ${expected}`)
  }
  await pg.waitForSelector('.thumbnail-item[data-thumbnail-page="1"] canvas', { timeout: 8000 })
  if (!(await pg.locator('.thumbnail-item[data-thumbnail-page="1"]').evaluate(el => el.classList.contains('active')))) {
    throw new Error('当前页缩略图未高亮')
  }
  await pg.screenshot({ path: join(TMP, 'shots', '00-thumbnails.png') })
  await pg.click('.thumbnail-item[data-thumbnail-page="4"]')
  await pg.waitForFunction(() => document.querySelector('.page-input')?.value === '4', null, { timeout: 5000 })
  if (!(await pg.locator('.thumbnail-item[data-thumbnail-page="4"]').evaluate(el => el.classList.contains('active')))) {
    throw new Error('缩略图跳转后高亮未同步')
  }
  await pg.click('.thumbnail-item[data-thumbnail-page="1"]')
  await pg.waitForFunction(() => document.querySelector('.page-input')?.value === '1', null, { timeout: 5000 })
  await pg.click('button[title="缩略图"]')
  await pg.waitForSelector('.side-drawer', { state: 'hidden', timeout: 3000 })
})

await step('PDF Ctrl/Cmd+F 搜索、跳转与高亮', async () => {
  const primaryKey = process.platform === 'darwin' ? 'Meta' : 'Control'
  await pg.keyboard.press(`${primaryKey}+f`)
  await pg.waitForSelector('.pdf-search')
  if (!(await pg.locator('.pdf-search-input').evaluate(el => el === document.activeElement))) {
    throw new Error('搜索框未自动聚焦')
  }
  await pg.fill('.pdf-search-input', 'Page')
  await pg.waitForFunction(
    () => document.querySelector('.pdf-search-status')?.textContent?.trim() === '1 / 4',
    null,
    { timeout: 8000 },
  )
  await pg.waitForSelector('.p-search-rect.active', { timeout: 5000 })
  await pg.press('.pdf-search-input', 'Enter')
  await pg.waitForFunction(
    () => document.querySelector('.pdf-search-status')?.textContent?.trim() === '2 / 4',
    null,
    { timeout: 5000 },
  )
  await pg.press('.pdf-search-input', 'Shift+Enter')
  await pg.waitForFunction(
    () => document.querySelector('.pdf-search-status')?.textContent?.trim() === '1 / 4',
    null,
    { timeout: 5000 },
  )
  await pg.press('.pdf-search-input', 'Escape')
  await pg.waitForSelector('.pdf-search', { state: 'detached', timeout: 3000 })
  if (await pg.locator('.p-search-rect').count()) throw new Error('关闭搜索后仍显示命中高亮')
})

await pg.screenshot({ path: join(TMP, 'shots', '01-scroll.png') })

await step('滚动更新页码', async () => {
  await pg.locator('.pane-left').evaluate(el => el.scrollTo({ top: el.scrollHeight }))
  await pg.waitForFunction(
    () => document.querySelector('.page-input')?.value === '4',
    null, { timeout: 5000 },
  )
  await pg.locator('.pane-left').evaluate(el => el.scrollTo({ top: 0 }))
  await pg.waitForFunction(() => document.querySelector('.page-input')?.value === '1', null, { timeout: 5000 })
})

await step('缩放: 放大与底部档位菜单', async () => {
  const w0 = await pg.locator('.p-holder').first().evaluate(el => el.clientWidth)
  await pg.click('button[title^="放大"]')
  await pg.waitForTimeout(500)
  const w1 = await pg.locator('.p-holder').first().evaluate(el => el.clientWidth)
  if (w1 <= w0) throw new Error(`宽度未增加 ${w0} -> ${w1}`)
  await pg.click('.dock-zoom')
  await pg.waitForSelector('.zoom-menu', { timeout: 3000 })
  await pg.click('.zoom-item:has-text("50%")')
  await pg.waitForTimeout(400)
  const w2 = await pg.locator('.p-holder').first().evaluate(el => el.clientWidth)
  if (w2 >= w1) throw new Error(`50% 档未生效 ${w1} -> ${w2}`)
  await pg.click('.dock-zoom')
  await pg.click('.zoom-item:has-text("适宽")')
  await pg.waitForTimeout(400)
})

await step('键盘缩放、复位与快捷键面板', async () => {
  const primaryKey = process.platform === 'darwin' ? 'Meta' : 'Control'
  const w0 = await pg.locator('.p-holder').first().evaluate(el => el.clientWidth)
  await pg.keyboard.press(`${primaryKey}+=`)
  await pg.waitForFunction(
    width => document.querySelector('.p-holder')?.clientWidth > width,
    w0,
    { timeout: 5000 },
  )
  const w1 = await pg.locator('.p-holder').first().evaluate(el => el.clientWidth)
  await pg.keyboard.press(`${primaryKey}+-`)
  await pg.waitForTimeout(400)
  const w2 = await pg.locator('.p-holder').first().evaluate(el => el.clientWidth)
  if (w2 >= w1) throw new Error(`快捷键缩小未生效 ${w1} -> ${w2}`)
  await pg.keyboard.press(`${primaryKey}+0`)
  await pg.waitForTimeout(400)
  if (!(await pg.locator('.dock-zoom').innerText()).includes('适合页面')) throw new Error('Ctrl/Cmd+0 未切换到适合页面')
  await pg.keyboard.press('Shift+/')
  await pg.waitForSelector('.shortcut-menu', { timeout: 3000 })
  if (await pg.locator('.shortcut-row').count() < 8) throw new Error('快捷键面板内容不完整')
  await pg.keyboard.press('Escape')
  await pg.waitForSelector('.shortcut-menu', { state: 'detached', timeout: 3000 })
})

await step('目录抽屉与跳转', async () => {
  await pg.click('button[title="目录"]')
  await pg.waitForSelector('.toc-item:has-text("Results")', { timeout: 5000 })
  await pg.click('.toc-item:has-text("Results")')
  await pg.waitForFunction(() => document.querySelector('.page-input')?.value === '3', null, { timeout: 5000 })
})
await pg.screenshot({ path: join(TMP, 'shots', '02-toc-jump.png') })

await step('目录跳转后出现返回按钮并可返回', async () => {
  await pg.waitForSelector('.back-pill', { timeout: 3000 })
  await pg.click('.back-pill')
  await pg.waitForFunction(() => document.querySelector('.page-input')?.value === '1', null, { timeout: 5000 })
})

await step('页内链接跳转', async () => {
  await pg.waitForSelector('.p-holder[data-page="1"] .p-link', { timeout: 8000 })
  await pg.click('.p-holder[data-page="1"] .p-link')
  await pg.waitForFunction(() => document.querySelector('.page-input')?.value === '3', null, { timeout: 5000 })
  await pg.click('.back-pill')
})

// 页面 1 第三行文字 "The quick brown fox..." 的基线在 PDF 坐标 y=620 (Tm 72 620), 字号 18
// → 左上原点坐标 y ≈ 792-633=159..170; 命中点取行中部
const lineY = 164
const holder1 = () => pg.locator('.p-holder[data-page="1"]')
const holderScale = async () => (await holder1().evaluate(el => el.clientWidth)) / 612

await step('几何选择: 双击取词出浮条', async () => {
  const s = await holderScale()
  await holder1().dblclick({ position: { x: 225 * s, y: lineY * s } })
  await pg.waitForSelector('.sel-bar', { timeout: 4000 })
  await pg.waitForSelector('.p-sel-rect', { timeout: 4000 })
})

await step('几何选择: 拖选连续文本', async () => {
  await pg.keyboard.press('Escape')
  const s = await holderScale()
  const box = await holder1().boundingBox()
  await pg.mouse.move(box.x + 90 * s, box.y + lineY * s)
  await pg.mouse.down()
  await pg.mouse.move(box.x + 320 * s, box.y + lineY * s, { steps: 8 })
  await pg.waitForSelector('.p-sel-rect', { timeout: 4000 })
  await pg.mouse.up()
  await pg.waitForSelector('.sel-bar', { timeout: 4000 })
  await pg.waitForTimeout(220) // 等待浮条入场动画结束后再做视觉断言与截图
  const toolbar = await pg.locator('.sel-bar').boundingBox()
  const viewport = pg.viewportSize()
  if (!toolbar || toolbar.x < 0 || toolbar.y < 0
    || toolbar.x + toolbar.width > viewport.width
    || toolbar.y + toolbar.height > viewport.height) {
    throw new Error(`划词浮条超出视口: ${JSON.stringify(toolbar)}`)
  }
})
await pg.screenshot({ path: join(TMP, 'shots', '03-selbar.png') })

await step('高亮保存并渲染', async () => {
  await pg.click('.sel-bar .sel-color')
  await pg.waitForSelector('.p-hl-rect', { timeout: 5000 })
})

await step('标注列表显示并可跳转', async () => {
  await pg.click('button[title="划线想法"]')
  await pg.waitForSelector('.anno-item', { timeout: 4000 })
})
await pg.screenshot({ path: join(TMP, 'shots', '04-annotations.png') })

await step('刷新后高亮仍在 (持久化)', async () => {
  await pg.reload({ waitUntil: 'networkidle' })
  await pg.waitForSelector('.p-holder canvas', { timeout: 15000 })
  await pg.waitForSelector('.p-hl-rect', { timeout: 8000 })
})
await pg.screenshot({ path: join(TMP, 'shots', '05-persisted.png') })

await step('标注列表删除高亮', async () => {
  await pg.click('button[title="划线想法"]')
  await pg.waitForSelector('.anno-item', { timeout: 4000 })
  await pg.hover('.anno-item')
  await pg.click('.anno-item .anno-del')
  await pg.waitForSelector('.p-hl-rect', { state: 'detached', timeout: 5000 })
  await pg.waitForSelector('.anno-item', { state: 'detached', timeout: 5000 })
  await pg.click('button[title="划线想法"]') // 收起抽屉
})

await step('Web 端不暴露原生 Agent，旧 AI 辅读/问答入口已移除', async () => {
  if (await pg.locator('header button:has-text("Agent")').count()) throw new Error('Web 端不应暴露本机 Agent')
  if (await pg.locator('header button:has-text("AI 辅读")').count()) throw new Error('旧 AI 辅读入口仍存在')
  if (await pg.locator('header button:text-is("问答")').count()) throw new Error('旧问答入口仍存在')
  if (await pg.locator('.ai-sec, .ai-q-list, .ai-input').count()) throw new Error('旧论文 AI DOM 仍可达')
})

await step('划词 AI 翻译浮卡 (流式)', async () => {
  const s = await holderScale()
  await holder1().dblclick({ position: { x: 480 * s, y: lineY * s } })
  await pg.waitForSelector('.sel-bar', { timeout: 4000 })
  await pg.click('.sel-bar .sel-act:has-text("翻译")')
  await pg.waitForSelector('.sel-tr-out:has-text("MOCK答复")', { timeout: 10000 })
  await pg.click('.sel-tr .icon-btn:last-child')
  await pg.waitForSelector('.sel-tr', { state: 'detached', timeout: 3000 })
})

await step('整页翻译面板 (mock 译文回填至版式对照)', async () => {
  // 点「翻译」标签即翻译授权 (v0.9.2 设计), 自动翻译当前页
  await pg.click('header button:text-is("翻译")')
  await pg.waitForSelector('.pt-head', { timeout: 5000 })
  await pg.waitForFunction(
    () => document.querySelector('.pane-right')?.textContent?.includes('MOCK答复'),
    null, { timeout: 10000 },
  )
})
await step('版式对照支持连续滚动', async () => {
  const holders = await pg.locator('.mp-holder').count()
  if (holders !== 4) throw new Error(`对照页容器数 ${holders} != 4`)
  await pg.locator('.mp-scroll').evaluate(el => el.scrollTo({ top: el.scrollHeight }))
  await pg.waitForFunction(() => document.querySelector('.pt-page')?.textContent?.includes('P4'), null, { timeout: 5000 })
})
await pg.screenshot({ path: join(TMP, 'shots', '08-translate.png') })

await step('藏书 PDF 同样走论文阅读器', async () => {
  await pg.goto('http://localhost:4173/#/library', { waitUntil: 'networkidle' })
  await pg.setInputFiles('input[type=file][multiple]', pdfPath)
  await pg.waitForSelector('.book-card', { timeout: 15000 })
  await pg.click('.book-card')
  await pg.waitForSelector('.pane-left', { timeout: 15000 })
  await pg.waitForSelector('.p-holder canvas', { timeout: 15000 })
  const backTitle = await pg.locator('header .icon-btn').first().getAttribute('title')
  if (backTitle !== '返回藏书') throw new Error(`返回目标错误: ${backTitle}`)
  // 藏书功能集: 听书/自动阅读, Web 端无翻译/原生 Agent
  await pg.waitForSelector('header button:has-text("听书")', { timeout: 4000 })
  await pg.waitForSelector('header button:has-text("自动阅读")', { timeout: 4000 })
  if (await pg.locator('header button:text-is("翻译")').count()) throw new Error('藏书 PDF 不应显示翻译按钮')
  if (await pg.locator('header button:has-text("Agent")').count()) throw new Error('Web 藏书 PDF 不应显示本机 Agent')
  await pg.click('header .icon-btn')
  await pg.waitForSelector('.book-card', { timeout: 8000 })
  await pg.goto('http://localhost:4173/#/papers', { waitUntil: 'networkidle' })
  await pg.click('.book-card')
  await pg.waitForSelector('.p-holder canvas', { timeout: 15000 })
})

await step('分栏拖拽调宽', async () => {
  await pg.click('header button:text-is("翻译")')
  await pg.waitForSelector('.pane-right', { timeout: 5000 })
  const w0 = await pg.locator('.pane-right').evaluate(el => el.clientWidth)
  const box = await pg.locator('.splitter').boundingBox()
  await pg.mouse.move(box.x + 3, box.y + 200)
  await pg.mouse.down()
  await pg.mouse.move(box.x - 150, box.y + 200, { steps: 6 })
  await pg.mouse.up()
  const w1 = await pg.locator('.pane-right').evaluate(el => el.clientWidth)
  if (w1 - w0 < 100) throw new Error(`右栏宽度未随拖拽变化 ${w0} -> ${w1}`)
})
await pg.screenshot({ path: join(TMP, 'shots', '09-split.png') })

await step('Mock 原生 Agent 对话、单任务锁与论文十问人工修订闭环', async () => {
  await pg.addInitScript(installPaperAgentBridge)
  await pg.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem('lightread-settings') || '{}')
    settings.libraryRoot = '/tmp/lightread-agent-test'
    settings.paperAgentEngine = 'pi'
    localStorage.setItem('lightread-settings', JSON.stringify(settings))
  })
  await pg.reload({ waitUntil: 'networkidle' })
  await pg.waitForSelector('.p-holder canvas', { timeout: 15000 })
  await pg.click('header button:has-text("Agent")')
  await pg.waitForSelector('.agent-sidebar', { timeout: 5000 })

  await pg.fill('.composer textarea', '请结合末页与笔记回答')
  await pg.click('.composer button[type="submit"]')
  await pg.waitForSelector('.interaction-card:has-text("Mock native permission")', { timeout: 5000 })
  await pg.click('.interaction-card button:has-text("Confirm")')
  await pg.waitForSelector('.message.assistant:has-text("MOCK Agent")', { timeout: 10000 })

  await pg.click('.view-tabs button:has-text("论文十问")')
  await pg.locator('.question-card').first().getByText('让 AI 初答').click()
  await pg.waitForSelector('.question-card:first-of-type .ai-initial .answer-text:has-text("MOCK AI 初答")', { timeout: 10000 })
  const humanAnswer = '人工修订：论文报告 20% 提升，但必须核对实验基线与任务领域。'
  await pg.locator('.question-card').first().locator('.human-answer textarea').fill(humanAnswer)
  await pg.locator('.question-card').first().getByText('保存并让 AI 再答').click()
  await pg.waitForSelector('.question-card:first-of-type .ai-reanswer .answer-text:has-text("MOCK AI 再答")', { timeout: 10000 })
  if (await pg.locator('.question-card').first().locator('.human-answer textarea').inputValue() !== humanAnswer) {
    throw new Error('AI 再答覆盖了人工回答')
  }

  await pg.reload({ waitUntil: 'networkidle' })
  await pg.waitForSelector('.p-holder canvas', { timeout: 15000 })
  await pg.click('header button:has-text("Agent")')
  await pg.click('.view-tabs button:has-text("论文十问")')
  await pg.waitForSelector('.question-card:first-of-type .ai-reanswer .answer-text:has-text("MOCK AI 再答")', { timeout: 10000 })
  if (await pg.locator('.question-card').first().locator('.human-answer textarea').inputValue() !== humanAnswer) {
    throw new Error('刷新后人工回答未持久化')
  }

  await pg.click('.view-tabs button:has-text("对话")')
  await pg.fill('.composer textarea', '验证跨引擎单任务锁')
  await pg.click('.composer button[type="submit"]')
  await pg.waitForSelector('.running-dot:has-text("Pi Agent")', { timeout: 5000 })
  await pg.locator('.engine-row button').filter({ hasText: 'Codex' }).click()
  const stopButton = pg.locator('.composer button.stop')
  if (!(await stopButton.isVisible())) throw new Error('切换引擎后未保留运行引擎的 Stop 操作')
  await stopButton.click()
  await pg.waitForSelector('.running-dot', { state: 'detached', timeout: 5000 })
})
await pg.screenshot({ path: join(TMP, 'shots', '10-paper-agent.png') })

const expectedPdfRepairLogs = [
  'format error: cannot find startxref',
  'warning: trying to repair broken xref',
  'warning: repairing PDF document',
]
const fatal = errors.filter(e =>
  !e.includes('favicon') &&
  !e.includes('sw.js') &&
  !e.includes('workbox') &&
  !expectedPdfRepairLogs.some(message => e.includes(message)),
)
if (fatal.length) {
  console.log('\n--- 页面错误 ---')
  for (const e of fatal.slice(0, 10)) console.log(e)
}
await browser.close()
mockAi.close()
process.exit(failed || fatal.length ? 1 : 0)
