// 摸鱼模式 (桌面): 老板键录制与校验 / 显示 / 半透明底色 / 传给原生层的选项 / 窗口配置
// 原生窗口命令见 cargo test stealth, 页面行为见 scripts/e2e-stealth.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  bossKeyLabel,
  clampOpacity,
  isValidBossKey,
  nativeOptions,
  shortcutFromEvent,
  stealthBackground,
  stealthInkMatrix,
  stealthPdfColors,
  validBounds,
  STEALTH_BG_MIN,
} from '../src/services/stealth.ts'

const key = (code, mods = {}) => ({ key: '', code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

test('录制老板键: 修饰键 + 普通键; 只有 Shift 或没有修饰键时不接受 (F 键除外)', () => {
  assert.equal(shortcutFromEvent(key('KeyZ', { altKey: true, shiftKey: true })), 'Alt+Shift+Z')
  assert.equal(shortcutFromEvent(key('KeyK', { ctrlKey: true, altKey: true })), 'Ctrl+Alt+K')
  assert.equal(shortcutFromEvent(key('Digit1', { metaKey: true })), 'Super+1')
  assert.equal(shortcutFromEvent(key('Backquote', { ctrlKey: true })), 'Ctrl+Backquote')
  assert.equal(shortcutFromEvent(key('F9')), 'F9')
  assert.equal(shortcutFromEvent(key('KeyZ')), null, 'plain letters stay for typing')
  assert.equal(shortcutFromEvent(key('KeyZ', { shiftKey: true })), null, 'Shift+letter is a capital letter')
  assert.equal(shortcutFromEvent(key('ShiftLeft', { shiftKey: true })), null, 'modifier alone')
  assert.equal(shortcutFromEvent(key('AltLeft', { altKey: true })), null)
})

test('录制老板键: 没有 code 的按键 (远程桌面 / 自动化 / 部分输入法) 按虚拟键码识别', () => {
  assert.equal(shortcutFromEvent({ ...key('', { altKey: true, shiftKey: true }), keyCode: 89 }), 'Alt+Shift+Y')
  assert.equal(shortcutFromEvent({ ...key('', { ctrlKey: true }), keyCode: 55 }), 'Ctrl+7')
  assert.equal(shortcutFromEvent({ ...key(''), keyCode: 120 }), 'F9')
  assert.equal(shortcutFromEvent({ ...key(''), keyCode: 89 }), null, 'plain letter still rejected')
  assert.equal(shortcutFromEvent({ ...key('', { altKey: true }), keyCode: 18 }), null, 'Alt alone')
})

test('老板键格式校验: 只认录制能生成的格式 (同步来的脏值不注册)', () => {
  for (const k of ['Alt+Shift+Z', 'Ctrl+Alt+K', 'Super+1', 'F9', 'Ctrl+Shift+Space']) assert.ok(isValidBossKey(k), k)
  for (const k of ['', 'Z', 'Alt+Alt+Z', 'Hyper+Z', 'Alt+Shift', 'Alt+ZZ', 'alt+z']) assert.ok(!isValidBossKey(k), k)
})

test('老板键显示: macOS 用符号, 其他平台用文字', () => {
  assert.equal(bossKeyLabel('Alt+Shift+Z', false), 'Alt+Shift+Z')
  assert.equal(bossKeyLabel('Super+1', false), 'Win+1')
  assert.equal(bossKeyLabel('Ctrl+Alt+Shift+Super+K', true), '⌃⌥⇧⌘K')
  assert.equal(bossKeyLabel('', true), '')
})

test('半透明底色: 主题色换成 rgba, 透明度有下限', () => {
  assert.equal(stealthBackground('#ffffff', 0.85), 'rgba(255, 255, 255, 0.85)')
  assert.equal(stealthBackground('#17181a', 1), 'rgba(23, 24, 26, 1)')
  assert.equal(stealthBackground('#fff', 0), `rgba(255, 255, 255, ${STEALTH_BG_MIN})`)
  assert.equal(stealthBackground('var(--bg)', 0.5), 'var(--bg)')
  assert.equal(clampOpacity('x', 0.4), 1)
  assert.equal(clampOpacity(0.333, 0.2), 0.33)
})

test('传给原生层的选项: 伪装关闭时不改标题; 空伪装标题用默认; 无效老板键不注册', () => {
  const prefs = { autoEnter: false, bgOpacity: 0.85, textOpacity: 1, disguise: false, disguiseTitle: '周报', bossKey: 'Alt+Shift+Z', alwaysOnTop: false, skipTaskbar: false, hideFromCapture: false, bounds: null, introSeen: false }
  assert.deepEqual(nativeOptions(prefs, '文档1'), { title: null, alwaysOnTop: false, bossKey: 'Alt+Shift+Z', skipTaskbar: false, hideFromCapture: false, bounds: null })
  assert.deepEqual(nativeOptions({ ...prefs, skipTaskbar: true, hideFromCapture: true, bounds: { x: -8, y: 0, w: 640, h: 720 } }, '文档1'),
    { title: null, alwaysOnTop: false, bossKey: 'Alt+Shift+Z', skipTaskbar: true, hideFromCapture: true, bounds: { x: -8, y: 0, w: 640, h: 720 } })
  assert.equal(nativeOptions({ ...prefs, disguise: true }, '文档1').title, '周报')
  assert.equal(nativeOptions({ ...prefs, disguise: true, disguiseTitle: '  ' }, '文档1').title, '文档1')
  assert.equal(nativeOptions({ ...prefs, bossKey: '' }, '文档1').bossKey, null)
  assert.equal(nativeOptions({ ...prefs, bossKey: 'Hyper+Z' }, '文档1').bossKey, null)
  assert.equal(nativeOptions({ ...prefs, alwaysOnTop: true }, '文档1').alwaysOnTop, true)
})

test('窗口配置: 桌面主窗口透明 (macOS 需 private API, Cargo 特性一致); App 窗口保持不透明', () => {
  const read = p => JSON.parse(readFileSync(new URL(`../src-tauri/${p}`, import.meta.url), 'utf8'))
  const desktop = read('tauri.conf.json')
  assert.equal(desktop.app.windows[0].transparent, true)
  assert.equal(desktop.app.macOSPrivateApi, true)
  const cargo = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
  assert.match(cargo, /^tauri = \{[^\n]*features = \[[^\]]*"macos-private-api"/m)
  assert.match(cargo, /tauri-plugin-global-shortcut = "2"/)
  for (const p of ['tauri.android.conf.json', 'tauri.ios.conf.json']) {
    const mobile = read(p)
    assert.equal(mobile.app.windows.length, 1, p)
    assert.equal(mobile.app.windows[0].transparent, false, p)
    assert.equal(mobile.version, read('tauri.android.conf.json').version)
  }
  const caps = read('capabilities/default.json')
  assert.ok(caps.permissions.includes('core:window:allow-start-dragging'), 'drag strip needs start-dragging')
})

test('Windows 窗口: 无系统标题栏与阴影边框 (自绘标题栏 + 圆角), 其余与通用配置一致', () => {
  const read = p => JSON.parse(readFileSync(new URL(`../src-tauri/${p}`, import.meta.url), 'utf8'))
  const base = read('tauri.conf.json').app.windows[0]
  const win = read('tauri.windows.conf.json').app.windows
  // 平台配置按 JSON Merge Patch 合并, 数组整个替换: 必须带齐通用配置的每一项
  assert.equal(win.length, 1)
  assert.deepEqual({ ...win[0], decorations: undefined, shadow: undefined }, { ...base, decorations: undefined, shadow: undefined })
  assert.equal(win[0].decorations, false)
  assert.equal(win[0].shadow, false)
  const caps = read('capabilities/default.json').permissions
  for (const p of ['minimize', 'toggle-maximize', 'is-maximized', 'close']) assert.ok(caps.includes(`core:window:allow-${p}`), p)
})

test('摸鱼模式设置只属于本机 (家里的电脑不该一打开书就进摸鱼模式)', async () => {
  const { LOCAL_SETTING_PATHS } = await import('../src/services/sync/settingsSync.ts')
  assert.ok(LOCAL_SETTING_PATHS.includes('stealth'))
})

test('摸鱼窗口位置: 只接受整数且尺寸像样的值 (手改 / 旧版本的脏值不交给原生层)', () => {
  assert.deepEqual(validBounds({ x: -8, y: 0, w: 640, h: 720 }), { x: -8, y: 0, w: 640, h: 720 })
  for (const b of [null, 'x', { x: 0, y: 0, w: 100, h: 720 }, { x: 0.5, y: 0, w: 640, h: 720 }, { x: 0, y: 0, w: 640 }, { x: 0, y: 0, w: 99999, h: 720 }]) {
    assert.equal(validBounds(b), null, JSON.stringify(b))
  }
})

test('PDF 只留墨迹: 白纸透明、黑字不透明, 输出墨色; 外观决定纸色与墨色', () => {
  const m = stealthInkMatrix('#1f2329').split(/\s+/).map(Number)
  assert.equal(m.length, 20)
  const apply = ([r, g, b, a = 1]) => [0, 1, 2, 3].map(i => m[i * 5] * r + m[i * 5 + 1] * g + m[i * 5 + 2] * b + m[i * 5 + 3] * a + m[i * 5 + 4])
  const white = apply([1, 1, 1]), black = apply([0, 0, 0]), grey = apply([0.5, 0.5, 0.5])
  assert.ok(Math.abs(white[3]) < 1e-9, 'white paper fully transparent')
  assert.ok(Math.abs(apply([0, 0, 0, 0])[3]) < 1e-9, 'unpainted (transparent) canvas stays transparent, not an ink block')
  assert.equal(black[3], 1, 'black ink opaque')
  assert.ok(Math.abs(grey[3] - 0.5) < 1e-9)
  assert.deepEqual(black.slice(0, 3), [0x1f / 255, 0x23 / 255, 0x29 / 255].map(v => +v.toFixed(4)), 'ink colour')
  assert.deepEqual(stealthPdfColors('light'), { paper: '#ffffff', ink: '#1f2329' })
  assert.notEqual(stealthPdfColors('dark').paper, '#ffffff')
})
