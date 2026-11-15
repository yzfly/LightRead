// 阅读模式的纯函数契约: 打字机 (分词 / 时间表 / 偏移↔时间 / 分行 / 偏移定位 / 速度换算)、
// 预设快照与恢复 (大字 / 墨水屏 / 歌词 / 夜间 / 护眼)、护眼 (调暗 / 休息提醒 / 夜间定时)、歌词 (行与停留 / 定位)、仿生阅读 (分词合并 / 词首)
// node --experimental-strip-types --test scripts/test-reading-modes.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  adjustSpeed,
  buildSchedule,
  clampSpeed,
  dominantScript,
  freshStart,
  groupLines,
  indexAt,
  locate,
  offsetAt,
  sentenceSpans,
  soundEvery,
  speedPresets,
  timeAt,
  tokenize,
} from '../src/services/readingModes/pacing.ts'
import { locateOffset } from '../src/services/readAloud.ts'
import {
  HEITI,
  einkValues,
  engagePreset,
  holderOf,
  isEyeCareTheme,
  isNightTheme,
  largeTextValues,
  looksLikeEinkDevice,
  lyricValues,
  releasePreset,
  themeAfterRelease,
} from '../src/services/readingModes/presets.ts'
import {
  afterReminder,
  clampDim,
  dimAlpha,
  dimBackground,
  inNightWindow,
  newBreakTimer,
  nightScheduleAction,
  noteActivity,
  parseClock,
  readingSpan,
  reminderDue,
} from '../src/services/readingModes/eyeCare.ts'
import {
  einkJumpDelta,
  estimateUnitsPerLine,
  focusWindow,
  normalizeFocusLines, lyricHeight, anchorAtHeight,
  lineAt,
  lineDwellMs,
  lineForProgress,
  lineIndexOf,
  lineSide,
  lineSpans,
  pinDelta,
  secondsPerLine,
  updateFollowRate,
} from '../src/services/readingModes/lyric.ts'
import { ZH_MERGE_WORDS, guideSpans, headLength } from '../src/services/readingModes/wordGuide.ts'
import {
  DEFAULT_TYPING_SOUND_PRESET,
  DEFAULT_TYPING_SOUND_VOLUME,
  MAX_VOICES,
  MIN_HIT_GAP_MS,
  TYPING_SOUND_PRESETS,
  allowHit,
  createRoundRobin,
  hitVariation,
  isTypingSoundPresetId,
  resolveTypingSoundPreset,
  synthHit,
  thinTicks,
  validateTypingSoundManifest,
  voicesToSteal,
  volumeToGain,
} from '../src/services/readingModes/soundPresets.ts'
import { readFileSync, statSync, existsSync } from 'node:fs'

const pieces = (text, lang) => sentenceSpans(text, lang).map(([s, e]) => text.slice(s, e))

test('主文字识别: 中文 / 西文 / RTL', () => {
  assert.equal(dominantScript('他慢慢地走进了图书馆。'), 'cjk')
  assert.equal(dominantScript('The quick brown fox jumps over the lazy dog.'), 'latin')
  assert.equal(dominantScript('مرحبا بالعالم'), 'rtl')
  assert.equal(dominantScript('…… —— 123'), 'other')
  // 一个汉字约等于一个词: 中英混排时中文为主
  assert.equal(dominantScript('他用 iPhone 看书，觉得很好。'), 'cjk')
})

test('句子切分: 句末开引号归下一句, 缩写不切开', () => {
  assert.deepEqual(pieces('第一句。第二句！“第三句？”', 'zh'), ['第一句。', '第二句！', '“第三句？”'])
  assert.deepEqual(pieces('Mr. Smith went home. He slept.', 'en'), ['Mr. Smith went home.', 'He slept.'])
  assert.deepEqual(pieces('J. K. Rowling wrote it. Dr. Who? Yes.', 'en'), ['J. K. Rowling wrote it.', 'Dr. Who?', 'Yes.'])
})

test('分词: 汉字每字一个出字单位, 标点和空白不占时间', () => {
  const text = '他说：“走吧。”'
  const toks = tokenize(text, 'zh')
  const weighted = toks.filter(t => t.weight > 0).map(t => text.slice(t.start, t.end))
  assert.deepEqual(weighted, ['他', '说', '走', '吧'])
  const colon = toks.find(t => text.slice(t.start, t.end) === '：')
  assert.equal(colon.pause, 1.5)
  assert.equal(toks.find(t => text.slice(t.start, t.end) === '。').pause, 3)
  assert.equal(toks.find(t => text.slice(t.start, t.end) === '“').open, true)
})

test('分词: 西文按词计时, 词内字母平分; 长词加时; RTL 整词出', () => {
  const text = 'cat extraordinarily'
  const toks = tokenize(text, 'en')
  const cat = toks.filter(t => t.start < 3)
  assert.equal(cat.length, 3)
  assert.ok(Math.abs(cat.reduce((s, t) => s + t.weight, 0) - 1) < 1e-9)
  assert.equal(cat[0].wordStart, true)
  assert.equal(cat[1].wordStart, false)
  const long = toks.filter(t => t.start >= 4 && t.weight > 0)
  // 15 个字母: 1 + (15 - 8) × 0.1 = 1.7
  assert.ok(Math.abs(long.reduce((s, t) => s + t.weight, 0) - 1.7) < 1e-9)
  const ar = tokenize('مرحبا بالعالم', 'ar').filter(t => t.weight > 0)
  assert.equal(ar.length, 2)
  assert.ok(ar.every(t => t.wordStart))
  // wholeWords: 整词一个 token
  assert.equal(tokenize('hello world', 'en', { wholeWords: true }).filter(t => t.weight > 0).length, 2)
})

test('字素: emoji、组合附加符、代理对不被切开, offsetAt 不落在代理对中间', () => {
  const text = '读👍🏽书é𠀀字'
  const toks = tokenize(text, 'zh')
  for (const tok of toks) {
    const code = text.charCodeAt(tok.start)
    assert.ok(!(code >= 0xdc00 && code <= 0xdfff), `token 起点落在低代理项: ${tok.start}`)
  }
  assert.ok(toks.some(t => text.slice(t.start, t.end) === '👍🏽'))
  assert.ok(toks.some(t => text.slice(t.start, t.end) === 'é'))
  assert.ok(toks.some(t => text.slice(t.start, t.end) === '𠀀'))
  const s = buildSchedule(toks, 300)
  for (let ms = 0; ms <= s.total; ms += 7) {
    const off = offsetAt(s, ms)
    const code = text.charCodeAt(off)
    assert.ok(off === text.length || !(code >= 0xdc00 && code <= 0xdfff), `偏移 ${off} 落在代理对中间`)
    assert.ok(off === text.length || text.charCodeAt(off) !== 0x0301, `偏移 ${off} 切开了组合附加符`)
  }
})

test('速度换算: 300 字/分时 60 秒内出 300 个汉字 (关闭标点停顿)', () => {
  const text = '字'.repeat(300)
  const s = buildSchedule(tokenize(text, 'zh'), 300, { punctuationPause: false })
  assert.equal(s.ends.length, 300)
  assert.equal(s.total, 60000)
  assert.equal(offsetAt(s, 0), 1) // 开始即出第一个字
  assert.equal(offsetAt(s, 59999), 300)
  assert.equal(offsetAt(s, 30000), 151)
})

test('标点停顿: 「，」之后的出字点间隔约为单字时长的 2.5 倍', () => {
  const text = '一二，三四。五'
  const s = buildSchedule(tokenize(text, 'zh'), 60) // 单字 1000ms
  // 出字点: 一 / 二， / 三 / 四。 / 五
  assert.deepEqual([...s.ends], [1, 3, 4, 6, 7])
  assert.deepEqual([...s.times], [0, 1000, 3500, 4500, 8500])
  assert.equal(s.times[2] - s.times[1], 2500)
  // 关闭停顿: 匀速
  const flat = buildSchedule(tokenize(text, 'zh'), 60, { punctuationPause: false })
  assert.deepEqual([...flat.times], [0, 1000, 2000, 3000, 4000])
})

test('段末停顿 +4, 原子块 (图片) 停留 1.2 秒, 开引号随后一个字出现', () => {
  const text = '甲乙“丙'
  const toks = tokenize(text, 'zh')
  const s = buildSchedule(toks, 60, { breaks: [2] })
  assert.deepEqual([...s.ends], [1, 2, 4]) // 「“」不并入「乙」, 随「丙」一起出现
  assert.deepEqual([...s.times], [0, 1000, 6000]) // 乙 1000 + 1000 + 段末 4000
  const withAtom = buildSchedule([...toks.slice(0, 2), { start: 2, end: 2, weight: 0, kind: 'atom' }, ...toks.slice(2)], 60, { punctuationPause: false })
  assert.deepEqual([...withAtom.ends], [1, 2, 2, 4])
  assert.deepEqual([...withAtom.times], [0, 1000, 2000, 3200])
})

test('origin: 时间表的偏移加上窗口起点', () => {
  const s = buildSchedule(tokenize('一二', 'zh'), 60, { origin: 100 })
  assert.equal(s.start, 100)
  assert.equal(offsetAt(s, -1), 100)
  assert.deepEqual([...s.ends], [101, 102])
})

test('逐句: 整句一起出现, 停留时间等于这句按速度算出的时长', () => {
  const text = '一二三。四五。'
  const units = sentenceSpans(text, 'zh')
  const s = buildSchedule(tokenize(text, 'zh'), 60, { units, punctuationPause: false })
  assert.deepEqual([...s.ends], [4, 7])
  assert.deepEqual([...s.times], [0, 3000])
  assert.deepEqual([...s.ticks], [1, 1])
  assert.equal(s.total, 5000)
})

test('offsetAt 与 timeAt 单调且互为近似反函数', () => {
  const text = '他说：“走吧。”她没有回头，风很大！Hello, world. 第二段的文字。'
  const s = buildSchedule(tokenize(text, 'zh'), 300, { breaks: [18] })
  let prev = -1
  for (let ms = -10; ms <= s.total + 100; ms += 13) {
    const off = offsetAt(s, ms)
    assert.ok(off >= prev, '偏移单调不减')
    prev = off
    assert.ok(timeAt(s, off) <= Math.max(0, ms), 'timeAt(offsetAt(t)) ≤ t')
  }
  let prevT = -1
  for (let off = 0; off <= text.length; off++) {
    const ms = timeAt(s, off)
    assert.ok(ms >= prevT, '时间单调不减')
    prevT = ms
    assert.ok(offsetAt(s, ms) >= off, 'offsetAt(timeAt(o)) ≥ o')
  }
  assert.equal(indexAt(s, -1), -1)
  assert.equal(timeAt(s, text.length + 10), s.total)
})

test('墨迹未干: 逐字为最近 2 个出字点, 逐句 / 逐行为刚出现的整个单位', () => {
  const s = buildSchedule(tokenize('一二三四', 'zh'), 60, { origin: 10 })
  assert.equal(freshStart(s, 3, 'char'), 12)
  assert.equal(freshStart(s, 0, 'char'), 10)
  assert.equal(freshStart(s, -1, 'char'), 10)
  assert.equal(freshStart(s, 3, 'sentence'), 13)
})

test('groupLines: ruby / 上标造成的 top 抖动不拆行; 换栏回到顶部算新行', () => {
  const lh = 30
  // 第一行含 ruby 基字 (下沉 6px) 与上标 (上浮 8px)
  const tops = [100, 100, 106, 92, 100, 130, 130, 131, 160, 40, 40]
  assert.deepEqual(groupLines(tops, lh), [[0, 5], [5, 8], [8, 9], [9, 11]])
  assert.deepEqual(groupLines([NaN, 10, NaN, 10, 50], 20), [[0, 4], [4, 5]])
  assert.deepEqual(groupLines([], 20), [])
})

test('locate: 跨多个文本节点的偏移、节点边界、空节点', () => {
  const lengths = [3, 0, 2, 4]
  assert.deepEqual(locate(lengths, 0), { node: 0, offset: 0 })
  assert.deepEqual(locate(lengths, 3), { node: 2, offset: 0 }) // 交界归后一个非空节点
  assert.deepEqual(locate(lengths, 3, true), { node: 0, offset: 3 }) // 区间终点归前一个节点末尾
  assert.deepEqual(locate(lengths, 6), { node: 3, offset: 1 })
  assert.deepEqual(locate(lengths, 9), { node: 3, offset: 4 })
  assert.deepEqual(locate(lengths, 99), { node: 3, offset: 4 })
  assert.deepEqual(locate([], 5), { node: 0, offset: 0 })
  assert.deepEqual(locate([0, 0], 0), { node: 1, offset: 0 })
  // 与听书的线性实现逐点一致
  for (let trial = 0; trial < 200; trial++) {
    const ls = Array.from({ length: 1 + (trial % 7) }, (_, i) => ((trial * 7 + i * 13) % 5))
    const total = ls.reduce((a, b) => a + b, 0)
    for (let off = 0; off <= total + 1; off++) {
      for (const pe of [false, true]) assert.deepEqual(locate(ls, off, pe), locateOffset(ls, off, pe), `${ls} @${off} ${pe}`)
    }
  }
})

test('速度: 范围钳制、±10% 取整到 10、快捷档、打字声频率', () => {
  assert.equal(clampSpeed(30, 'cjk'), 60)
  assert.equal(clampSpeed(5000, 'cjk'), 1200)
  assert.equal(clampSpeed(30, 'latin'), 40)
  assert.equal(clampSpeed(900, 'latin'), 800)
  assert.equal(clampSpeed(NaN, 'cjk'), 300)
  assert.equal(adjustSpeed(300, 1), 330)
  assert.equal(adjustSpeed(300, -1), 270)
  assert.equal(adjustSpeed(60, 1), 70) // 至少变化 10
  assert.equal(adjustSpeed(40, -1), 30)
  // 加一下再减一下回到原值
  for (const n of [200, 300, 420, 460, 510, 800]) assert.equal(adjustSpeed(adjustSpeed(n, 1), -1), n, `round trip ${n}`)
  assert.deepEqual(speedPresets('cjk'), [200, 300, 450])
  assert.deepEqual(speedPresets('latin'), [150, 200, 300])
  assert.equal(soundEvery(300), 1)
  assert.equal(soundEvery(601), 3)
})

// ---------------------------------------------------------------------------
// 预设: 快照与恢复
// ---------------------------------------------------------------------------

/** 用普通对象模拟设置: 'reader.fontSize' → state.reader.fontSize */
function fakeSettings(init) {
  const state = structuredClone(init)
  let records = {}
  const read = key => {
    const [ns, k] = key.split('.')
    return state[ns]?.[k]
  }
  const write = vals => {
    for (const [key, v] of Object.entries(vals)) {
      const [ns, k] = key.split('.')
      state[ns][k] = v
    }
  }
  return {
    state,
    get records() { return records },
    engage(id, values) {
      const r = engagePreset(records, id, values, read)
      write(r.writes)
      records = r.records
    },
    release(id) {
      const r = releasePreset(records, id, read)
      write(r.writes)
      records = r.records
      return r.custom
    },
    read,
  }
}

const READER = { fontSize: 18, lineHeight: 1.8, letterSpacing: 0, gap: 6, justify: true, fontFamily: '', flow: 'paginated', theme: 'auto' }

test('预设: 开启时记快照, 关闭时恢复; 不改动的键保持原样', () => {
  const s = fakeSettings({ reader: READER, typewriter: { unit: 'char' } })
  s.engage('largeText', largeTextValues('large'))
  assert.equal(s.state.reader.fontSize, 24)
  assert.equal(s.state.reader.lineHeight, 2)
  assert.equal(s.state.reader.letterSpacing, 0.05)
  assert.equal(s.state.reader.gap, 4)
  assert.equal(s.state.reader.justify, false)
  assert.equal(s.state.reader.fontFamily, HEITI)
  assert.equal(s.state.reader.flow, 'paginated')
  const custom = s.release('largeText')
  assert.deepEqual(custom, {})
  assert.deepEqual(s.state.reader, READER)
  assert.deepEqual(s.records, {})
})

test('预设: 在大字模式里手动调过的字号记为预设自己的值, 关闭仍恢复快照, 下次开启沿用', () => {
  const s = fakeSettings({ reader: READER })
  s.engage('largeText', largeTextValues('large'))
  s.state.reader.fontSize = 27 // 用户在大字模式里调大
  const custom = s.release('largeText')
  assert.deepEqual(custom, { 'reader.fontSize': 27 })
  assert.equal(s.state.reader.fontSize, 18)
  const again = largeTextValues('large', custom)
  assert.equal(again['reader.fontSize'], 27)
  assert.equal(largeTextValues('xlarge')['reader.fontSize'], 30)
  assert.equal(largeTextValues('xlarge')['reader.gap'], 3)
})

test('预设: 重新套用 (大 → 特大) 保留第一次的快照', () => {
  const s = fakeSettings({ reader: READER })
  s.engage('largeText', largeTextValues('large'))
  s.engage('largeText', largeTextValues('xlarge'))
  assert.equal(s.state.reader.fontSize, 30)
  s.release('largeText')
  assert.equal(s.state.reader.fontSize, 18)
  assert.equal(s.state.reader.gap, 6)
})

test('预设叠加: 大字之上开歌词 (×1.2), 先关下层或先关上层都能回到最初', () => {
  // 先关上层 (歌词), 再关下层 (大字)
  let s = fakeSettings({ reader: READER })
  s.engage('largeText', largeTextValues('large'))
  s.engage('lyric', lyricValues(s.read, 1.2))
  assert.equal(s.state.reader.fontSize, 29)
  assert.equal(s.state.reader.flow, 'paginated') // 版式不经预设: 歌词的滚动只是生效值
  assert.equal(holderOf(s.records, 'reader.fontSize'), 'lyric')
  s.release('lyric')
  assert.equal(s.state.reader.fontSize, 24)
  s.release('largeText')
  assert.deepEqual(s.state.reader, READER)

  // 先关下层 (大字): 字号仍由歌词管, 不写回; 之后关歌词回到最初的 18
  s = fakeSettings({ reader: READER })
  s.engage('largeText', largeTextValues('large'))
  s.engage('lyric', lyricValues(s.read, 1.2))
  const custom = s.release('largeText')
  assert.deepEqual(custom, {})
  assert.equal(s.state.reader.fontSize, 29)
  assert.equal(s.state.reader.letterSpacing, 0) // 歌词不管字距, 直接恢复
  s.release('lyric')
  assert.deepEqual(s.state.reader, READER)
})

test('预设叠加: 歌词运行中把大字从「大」换成「特大」, 退出歌词后是特大', () => {
  const s = fakeSettings({ reader: READER })
  s.engage('largeText', largeTextValues('large'))
  s.engage('lyric', lyricValues(s.read, 1.2))
  assert.equal(s.state.reader.fontSize, 29)
  s.engage('largeText', largeTextValues('xlarge'))
  assert.equal(s.state.reader.fontSize, 29) // 字号仍由歌词管
  assert.equal(s.state.reader.gap, 3) // 歌词不管页边距: 直接生效
  s.release('lyric')
  assert.equal(s.state.reader.fontSize, 30)
  s.release('largeText')
  assert.deepEqual(s.state.reader, READER)
})

test('预设: 主题类键被用户改过时不恢复 (尊重用户的选择)', () => {
  const s = fakeSettings({ reader: { ...READER, theme: 'light' } })
  s.engage('night', { 'reader.theme': 'dark' })
  assert.equal(s.state.reader.theme, 'dark')
  s.state.reader.theme = 'green'
  s.release('night')
  assert.equal(s.state.reader.theme, 'green')
  // 旧版本歌词记录 (含 reader.flow) 期间用户改回分页: 退出歌词不再改
  const s2 = fakeSettings({ reader: READER })
  s2.engage('lyric', { 'reader.flow': 'scrolled', ...lyricValues(s2.read, 1) })
  assert.equal(s2.state.reader.fontSize, 18) // ×1.0 不改字号
  assert.equal(s2.state.reader.lineHeight, 2) // 行距至少 2.0
  s2.state.reader.flow = 'paginated'
  s2.release('lyric')
  assert.equal(s2.state.reader.flow, 'paginated')
  assert.equal(s2.state.reader.lineHeight, 1.8)
})

test('预设: 歌词字号倍数收敛到 1.0–1.6, 已经 ≥2 的行距不动; 墨水屏把逐字改为逐句', () => {
  const read = k => ({ 'reader.fontSize': 20, 'reader.lineHeight': 2.2 })[k]
  assert.deepEqual(lyricValues(read, 3), { 'reader.fontSize': 32 })
  assert.deepEqual(lyricValues(read, 0.5), {})
  assert.deepEqual(einkValues(k => (k === 'typewriter.unit' ? 'char' : undefined)), { 'typewriter.unit': 'sentence' })
  assert.deepEqual(einkValues(k => (k === 'typewriter.unit' ? 'line' : undefined)), {})
})

test('预设: 旧版本歌词记录里的 reader.flow 关闭时照常写回', () => {
  const s = fakeSettings({ reader: READER })
  s.engage('lyric', { 'reader.flow': 'scrolled', 'reader.lineHeight': 2 })
  assert.equal(s.state.reader.flow, 'scrolled')
  s.release('lyric')
  assert.deepEqual(s.state.reader, READER)
})

test('夜间 / 护眼: 判定与关闭后的主题', () => {
  assert.equal(isNightTheme('dark', false), true)
  assert.equal(isNightTheme('auto', true), true)
  assert.equal(isNightTheme('auto', false), false)
  assert.equal(isEyeCareTheme('sepia'), true)
  assert.equal(isEyeCareTheme('green'), true)
  assert.equal(isEyeCareTheme('light'), false)
  assert.equal(themeAfterRelease('sepia', 'night', false), 'sepia')
  assert.equal(themeAfterRelease('auto', 'night', true), 'light') // auto 在深色外观下仍是夜间
  assert.equal(themeAfterRelease('auto', 'night', false), 'auto')
  assert.equal(themeAfterRelease('green', 'eyeCare', false), 'light')
  assert.equal(themeAfterRelease('dark', 'eyeCare', false), 'dark')
})

test('墨水屏设备识别: 常见厂商 / 型号命中, 普通手机不命中', () => {
  assert.equal(looksLikeEinkDevice('Mozilla/5.0 (Linux; Android 11; NoteAir2P Build/RKQ1.210408.001) AppleWebKit/537.36'), true)
  assert.equal(looksLikeEinkDevice('Mozilla/5.0 (Linux; Android 12; Nova3Color) AppleWebKit/537.36'), true)
  assert.equal(looksLikeEinkDevice('Mozilla/5.0 (Linux; Android 11; HLTE556N Hisense A9) AppleWebKit'), true)
  assert.equal(looksLikeEinkDevice('Mozilla/5.0 (Linux; Android 10; HUAWEI nova 7 5G) AppleWebKit/537.36'), false)
  assert.equal(looksLikeEinkDevice('Mozilla/5.0 (Linux; Android 13; 23113RKC6C) AppleWebKit/537.36'), false)
  assert.equal(looksLikeEinkDevice('', { update: 'slow' }), true)
  assert.equal(looksLikeEinkDevice('', { monochrome: true }), true)
})

// ---------------------------------------------------------------------------
// 护眼: 调暗 / 夜间定时 / 休息提醒
// ---------------------------------------------------------------------------

test('调暗: 收敛到 0–60 的整数, 遮罩 alpha = 档位%', () => {
  assert.equal(clampDim(-5), 0)
  assert.equal(clampDim(75), 60)
  assert.equal(clampDim('33.6'), 34)
  assert.equal(clampDim(NaN), 0)
  assert.equal(dimAlpha(40), 0.4)
  assert.equal(dimAlpha(100), 0.6)
  assert.equal(dimBackground(0), '')
  assert.equal(dimBackground(25), 'rgba(0, 0, 0, 0.25)')
})

test('夜间定时: 时间解析、跨午夜窗口、只在进出时间段时动作', () => {
  assert.equal(parseClock('22:00'), 1320)
  assert.equal(parseClock('7:05'), 425)
  assert.equal(parseClock('24:00'), null)
  assert.equal(parseClock('x'), null)
  const m = (h, mm = 0) => h * 60 + mm
  // 22:00–07:00 跨午夜
  assert.equal(inNightWindow(m(23), '22:00', '07:00'), true)
  assert.equal(inNightWindow(m(3), '22:00', '07:00'), true)
  assert.equal(inNightWindow(m(7), '22:00', '07:00'), false) // [from, to)
  assert.equal(inNightWindow(m(12), '22:00', '07:00'), false)
  // 同一天内
  assert.equal(inNightWindow(m(14), '13:00', '15:00'), true)
  assert.equal(inNightWindow(m(15), '13:00', '15:00'), false)
  assert.equal(inNightWindow(m(1), '08:00', '08:00'), false)
  assert.equal(inNightWindow(m(1), 'bad', '08:00'), false)

  const act = (inWindow, prevIn, nightOn, autoApplied) => nightScheduleAction({ inWindow, prevIn, nightOn, autoApplied })
  assert.equal(act(true, null, false, false), 'on') // 打开阅读器时已在时间段内
  assert.equal(act(true, false, false, false), 'on') // 进入时间段
  assert.equal(act(true, true, false, false), null) // 时间段内用户手动关了: 不反复改回
  assert.equal(act(true, false, true, false), null) // 已是夜间
  assert.equal(act(false, true, true, true), 'off') // 离开时间段, 定时开的夜间关掉
  assert.equal(act(false, true, true, false), null) // 用户自己开的夜间不关
  assert.equal(act(false, null, true, true), 'off') // 重新打开时已在时间段外
  assert.equal(act(false, false, true, true), null)
})

test('休息提醒: 连续阅读满间隔才提醒; 中断 5 分钟重新计时; 稍后 30 分钟内不提醒', () => {
  const MIN = 60000
  let s = newBreakTimer(0)
  for (let t = MIN; t <= 19 * MIN; t += MIN) s = noteActivity(s, t)
  assert.equal(reminderDue(s, 19 * MIN, 20), false)
  s = noteActivity(s, 20 * MIN)
  assert.equal(readingSpan(s, 20 * MIN), 20 * MIN)
  assert.equal(reminderDue(s, 20 * MIN, 20), true)
  assert.equal(reminderDue(s, 20 * MIN, 30), false)
  // 中断超过 5 分钟: 跨度归零, 下一次活动重新计时
  assert.equal(readingSpan(s, 26 * MIN), 0)
  assert.equal(reminderDue(s, 26 * MIN, 20), false)
  s = noteActivity(s, 26 * MIN)
  assert.equal(s.start, 26 * MIN)
  // 跳过: 从现在重新计时; 稍后: 30 分钟内即使满 20 分钟也不提醒
  let t = newBreakTimer(0)
  for (let x = MIN; x <= 20 * MIN; x += MIN) t = noteActivity(t, x)
  const skipped = afterReminder(t, 20 * MIN, 'skip')
  assert.equal(skipped.start, 20 * MIN)
  assert.equal(skipped.snoozeUntil, 0)
  let snoozed = afterReminder(t, 20 * MIN, 'snooze')
  for (let x = 21 * MIN; x <= 45 * MIN; x += MIN) snoozed = noteActivity(snoozed, x)
  assert.equal(reminderDue(snoozed, 45 * MIN, 20), false)
  for (let x = 46 * MIN; x <= 51 * MIN; x += MIN) snoozed = noteActivity(snoozed, x)
  assert.equal(reminderDue(snoozed, 51 * MIN, 20), true)
})

// ---------------------------------------------------------------------------
// 歌词: 视觉行、停留时间、聚焦窗口、定位
// ---------------------------------------------------------------------------

test('歌词分行: 按 rect.top 归行, 行首尾相接, 收尾标点归本行、开引号归下一行', () => {
  const text = '一二三，四五。六七八“九十”'
  const toks = tokenize(text, 'zh', { wholeWords: true })
  const weighted = toks.filter(t => t.weight > 0)
  assert.equal(weighted.length, 10)
  const tops = weighted.map((_, i) => (i < 5 ? 0 : i < 8 ? 30 : 60))
  const lines = lineSpans(toks, tops, 30, [7])
  assert.deepEqual(lines.map(l => text.slice(l.start, l.end)), ['一二三，四五。', '六七八', '“九十”'])
  // 行内逗号 1.5; 行末句号 3 与段末 4 取最大
  assert.equal(lines[0].weight, 5)
  assert.equal(lines[0].pause, 1.5 + 4)
  assert.equal(lines[0].para, true)
  assert.equal(lines[1].pause, 0)
  assert.equal(lines[1].para, false)
  // 首尾相接
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].start, lines[i - 1].end)
  // 西文按整词: ruby / 上标造成的 top 抖动不拆行
  const en = 'The quick brown fox jumps over'
  const et = tokenize(en, 'en', { wholeWords: true })
  const ew = et.filter(t => t.weight > 0)
  const enLines = lineSpans(et, [100, 103, 97, 100, 130, 131], 30)
  assert.equal(ew.length, 6)
  assert.deepEqual(enLines.map(l => en.slice(l.start, l.end).trim()), ['The quick brown fox', 'jumps over'])
  assert.deepEqual(lineSpans(et, [1, 2], 30), []) // tops 与出字单位对不上: 不猜
})

test('歌词停留: (字当量 + 停顿) ÷ 速度; 标题 ×1.5、代码 ×0.5、图片按高度', () => {
  // 300 字/分, 一行 13 个字 ≈ 2.6 秒
  assert.equal(lineDwellMs({ weight: 13, pause: 0 }, 300), 2600)
  assert.equal(lineDwellMs({ weight: 10, pause: 1.5 }, 300), 2300)
  assert.equal(lineDwellMs({ weight: 10, pause: 1.5 }, 300, { punctuationPause: false }), 2000)
  assert.equal(lineDwellMs({ weight: 10, pause: 0, kind: 'heading' }, 300), 3000)
  assert.equal(lineDwellMs({ weight: 10, pause: 0, kind: 'code' }, 300), 1000)
  assert.equal(lineDwellMs({ weight: 0, pause: 0, kind: 'atom', ratio: 0.3 }, 300), 1200)
  assert.equal(lineDwellMs({ weight: 0, pause: 0, kind: 'atom', ratio: 1.5 }, 300), 3000)
  assert.equal(lineDwellMs({ weight: 0, pause: 0 }, 300), 300) // 下限
  assert.equal(secondsPerLine(13, 300), 2.6)
  assert.equal(estimateUnitsPerLine(360, 24, 4), 13) // 手机 360 宽、24px、页边距 4%: 约 13 个汉字
})

test('歌词聚焦窗口、定位滚动量、墨水屏整屏跳、行在视口哪一侧', () => {
  assert.deepEqual(focusWindow(5, 1, 10), [5, 5])
  assert.deepEqual(focusWindow(5, 3, 10), [4, 6])
  assert.deepEqual(focusWindow(0, 3, 10), [0, 1])
  assert.deepEqual(focusWindow(9, 3, 10), [8, 9])
  assert.deepEqual(focusWindow(3, 1, 0), [0, -1])
  // 视口 0–1000, 行 [700, 730] 中心 715, 锚点 40% → 向下滚 315
  assert.equal(pinDelta(700, 730, 0, 1000, 0.4), 315)
  assert.equal(pinDelta(385, 415, 0, 1000, 0.4), 0)
  assert.equal(einkJumpDelta(500, 530, 0, 1000), null) // 还没越过 80%: 不动
  assert.equal(einkJumpDelta(790, 820, 0, 1000), 690) // 越过 80%: 放到 10% 处
  assert.equal(einkJumpDelta(-40, -10, 0, 1000), -140) // 跑到上方
  assert.equal(lineSide(-50, -10, 0, 1000), 'above')
  assert.equal(lineSide(1000, 1030, 0, 1000), 'below')
  assert.equal(lineSide(400, 430, 0, 1000), null)
})

test('歌词点按命中与偏移定位; 跟听书的跨行进度与语速估计', () => {
  const lines = [
    { top: 0, bottom: 30, start: 0, end: 10 },
    { top: 40, bottom: 70, start: 10, end: 20 },
    { top: 80, bottom: 110, start: 20, end: 26 },
    { top: 200, bottom: 400, start: 26, end: 26 }, // 图片
  ]
  assert.equal(lineAt(lines, 15), 0)
  assert.equal(lineAt(lines, 35), 0) // 行间空白归最近的行
  assert.equal(lineAt(lines, 38), 1)
  assert.equal(lineAt(lines, 300), 3)
  assert.equal(lineAt(lines, 150), -1) // 离所有行都远
  assert.equal(lineAt(lines, -100), -1)
  assert.equal(lineIndexOf(lines, 0), 0)
  assert.equal(lineIndexOf(lines, 15), 1)
  assert.equal(lineIndexOf(lines, 20), 2)
  assert.equal(lineIndexOf(lines, 999), 3)
  assert.equal(lineIndexOf([], 3), -1)
  assert.equal(lineForProgress([10, 10, 5], 0), 0)
  assert.equal(lineForProgress([10, 10, 5], 0.5), 1)
  assert.equal(lineForProgress([10, 10, 5], 0.99), 2)
  assert.equal(lineForProgress([], 0.5), 0)
  let rate = updateFollowRate(null, 2400, 10)
  assert.equal(rate, 240)
  rate = updateFollowRate(rate, 3000, 10)
  assert.equal(rate, 240 * 0.7 + 300 * 0.3)
  assert.equal(updateFollowRate(rate, 60000, 0), rate) // 没有字当量: 不更新
  assert.equal(updateFollowRate(null, 999999, 1), 2000) // 暂停很久: 收敛
})

// ---------------------------------------------------------------------------
// 仿生阅读: 词首强调 / 分词交替着色
// ---------------------------------------------------------------------------

test('词首强调: 1–3 个字母保留 1 个, 更长的保留约 40%; 只返回要变淡的词尾', () => {
  assert.equal(headLength(0), 0)
  assert.equal(headLength(1), 1)
  assert.equal(headLength(3), 1)
  assert.equal(headLength(4), 2)
  assert.equal(headLength(10), 4)
  const text = 'A reading lamp, extraordinarily bright.'
  const { tail, alt } = guideSpans(text, 'en')
  assert.deepEqual(alt, [])
  assert.deepEqual(tail.map(([a, b]) => text.slice(a, b)), ['ding', 'mp', 'rdinarily', 'ght'])
  // 组合附加符不被切开
  const fr = 'café'
  const r = guideSpans(fr, 'fr')
  assert.deepEqual(r.tail.map(([a, b]) => fr.slice(a, b)), ['fé'])
  // 只做中文时西文不处理
  assert.deepEqual(guideSpans(text, 'en', { style: 'alternate' }).tail, [])
})

test('分词交替着色: 合并表修正 ICU 切开的词, 只给 ≥2 字的词着色, 相邻着色词交替', () => {
  assert.ok(ZH_MERGE_WORDS.has('图书馆'))
  const text = '他慢慢地走进了图书馆，翻开一本关于人工智能的书。'
  // 把交替的两半都还原出来: parity 偶数为正文色, 奇数为混合色 (只返回奇数那一半)
  const { alt, parity } = guideSpans(text, 'zh')
  const colored = alt.map(([a, b]) => text.slice(a, b))
  assert.deepEqual(colored, ['走进', '翻开', '关于'])
  // 合并后「图书馆」「人工智能」各是一个词 (落在偶数位, 保持正文色), 不会出现「图书」「人工」这样的碎片
  assert.ok(!colored.includes('图书') && !colored.includes('人工'))
  assert.equal(parity, 7) // 慢慢地 走进 图书馆 翻开 一本 关于 人工智能
  // 三段拼起来的「互联网」
  const t2 = '互联网时代'
  assert.deepEqual(guideSpans(t2, 'zh').alt.map(([a, b]) => t2.slice(a, b)), ['时代'])
  // parityStart 让跨段调用时交替不断档
  assert.deepEqual(guideSpans(t2, 'zh', { parityStart: 1 }).alt.map(([a, b]) => t2.slice(a, b)), ['互联网'])
  // 不在合并表里的相邻片段不合并; 只做西文时中文不处理
  assert.deepEqual(guideSpans(text, 'zh', { style: 'fixation' }).alt, [])
  // 中英混排
  const mixed = '我们阅读 English books 吧'
  const m = guideSpans(mixed, 'zh')
  assert.deepEqual(m.tail.map(([a, b]) => mixed.slice(a, b)), ['lish', 'oks'])
})

// ---- 打字声音色 (soundPresets.ts + public/sounds/typewriter) ----

/** 可复现的伪随机 (mulberry32) */
function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('打字声轮换: 永不连着两次同一条, 每一轮把所有变体用一遍', () => {
  for (const count of [2, 3, 4, 6, 8]) {
    for (const rand of [seeded(count), seeded(99 + count), Math.random]) {
      const rr = createRoundRobin(count, rand)
      let prev = -1
      const seen = []
      for (let i = 0; i < count * 500; i++) {
        const k = rr.next()
        assert.ok(k >= 0 && k < count)
        assert.notEqual(k, prev, `count=${count} repeated ${k} at draw ${i}`)
        assert.equal(rr.last, k)
        prev = k
        seen.push(k)
      }
      // 每 count 次是一轮完整的排列
      for (let r = 0; r < 500; r++) assert.deepEqual([...seen.slice(r * count, r * count + count)].sort((a, b) => a - b), [...Array(count).keys()])
    }
  }
  // 只有一条时只能一直用它; 没有时返回 -1
  const one = createRoundRobin(1)
  assert.deepEqual([one.next(), one.next(), one.next()], [0, 0, 0])
  assert.equal(createRoundRobin(0).next(), -1)
  // 即使随机源总给同一个值, 跨轮也不会重复
  const stuck = createRoundRobin(4, () => 0)
  let p = -1
  for (let i = 0; i < 40; i++) { const k = stuck.next(); assert.notEqual(k, p); p = k }
})

test('打字声抽稀与限频: 高速每 3 字一声, 45 ms 内只响一次, 段落点缀不受限', () => {
  // 300 字/分 每字一声, 900 字/分 每 3 字一声 (soundEvery 来自 pacing)
  for (const [speed, every] of [[300, 1], [900, 3]]) {
    assert.equal(soundEvery(speed), every)
    let c = 0
    const plays = []
    for (let i = 0; i < 12; i++) {
      const r = thinTicks(c, 1, soundEvery(speed))
      c = r.count
      plays.push(r.play)
    }
    assert.equal(plays.filter(Boolean).length, 12 / every)
  }
  // 一次推进多个字 (逐句) 也只响一声; 0 个字不响
  assert.deepEqual(thinTicks(0, 5, 3), { count: 0, play: true })
  assert.deepEqual(thinTicks(2, 0, 3), { count: 2, play: false })
  // 限频
  assert.equal(MIN_HIT_GAP_MS, 45)
  assert.equal(allowHit(1000, 960), false)
  assert.equal(allowHit(1000, 955), true)
  assert.equal(allowHit(1000, 990, true), true)
  assert.equal(allowHit(0, -Infinity), true)
  // 300 字/分 (200 ms 一字) 不会被限频吃掉
  assert.ok(allowHit(200, 0))
})

test('打字声变化与复音: 音高 ±3%, 音量 ±2 dB, 最多 4 声重叠', () => {
  const lo = hitVariation(() => 0)
  const hi = hitVariation(() => 0.999999)
  assert.ok(Math.abs(lo.rate - 0.97) < 1e-9)
  assert.ok(Math.abs(hi.rate - 1.03) < 1e-5)
  assert.ok(Math.abs(20 * Math.log10(lo.gain) + 2) < 1e-9)
  assert.ok(Math.abs(20 * Math.log10(hi.gain) - 2) < 1e-4)
  const r = seeded(7)
  for (let i = 0; i < 1000; i++) {
    const v = hitVariation(r)
    assert.ok(v.rate >= 0.97 && v.rate <= 1.03)
    assert.ok(v.gain >= 10 ** (-2 / 20) - 1e-12 && v.gain <= 10 ** (2 / 20) + 1e-12)
  }
  assert.equal(MAX_VOICES, 4)
  assert.equal(voicesToSteal(0), 0)
  assert.equal(voicesToSteal(3), 0)
  assert.equal(voicesToSteal(4), 1)
  assert.equal(voicesToSteal(6), 3)
})

test('打字声音量: 0 静音, 100% 满增益, 单调, 默认 40%', () => {
  assert.equal(DEFAULT_TYPING_SOUND_VOLUME, 0.4)
  assert.equal(volumeToGain(0), 0)
  assert.equal(volumeToGain(1), 1)
  assert.equal(volumeToGain(2), 1)
  assert.equal(volumeToGain(-1), 0)
  assert.equal(volumeToGain(NaN), volumeToGain(DEFAULT_TYPING_SOUND_VOLUME))
  let prev = -1
  for (let v = 0; v <= 1.0001; v += 0.05) { const g = volumeToGain(v); assert.ok(g > prev); prev = g }
  const db = 20 * Math.log10(volumeToGain(0.4))
  assert.ok(db > -15 && db < -11, `40% → ${db.toFixed(1)} dB`)
})

test('打字声音色清单: 4 个音色, 默认可解析, 未知 id 回落默认, 文案两种语言都有', () => {
  assert.deepEqual(TYPING_SOUND_PRESETS.map(p => p.id), ['typewriter', 'mechanical', 'soft', 'pen'])
  assert.ok(isTypingSoundPresetId(DEFAULT_TYPING_SOUND_PRESET))
  assert.equal(resolveTypingSoundPreset('pen').id, 'pen')
  assert.equal(resolveTypingSoundPreset('nope').id, DEFAULT_TYPING_SOUND_PRESET)
  assert.equal(resolveTypingSoundPreset(undefined).id, DEFAULT_TYPING_SOUND_PRESET)
  const zh = readFileSync(new URL('../src/i18n/zh.ts', import.meta.url), 'utf8')
  const en = readFileSync(new URL('../src/i18n/en.ts', import.meta.url), 'utf8')
  for (const key of [...TYPING_SOUND_PRESETS.map(p => p.nameKey), 'readingMode.soundPreset', 'readingMode.soundVolume', 'readingMode.soundPreview']) {
    assert.ok(zh.includes(`'${key}':`), `zh missing ${key}`)
    assert.ok(en.includes(`'${key}':`), `en missing ${key}`)
  }
  // 设置默认值与这里一致
  const settings = readFileSync(new URL('../src/stores/settings.ts', import.meta.url), 'utf8')
  assert.match(settings, new RegExp(`soundPreset: '${DEFAULT_TYPING_SOUND_PRESET}'`))
  assert.match(settings, new RegExp(`soundVolume: ${DEFAULT_TYPING_SOUND_VOLUME}`))
})

test('打字声素材: manifest.json 合法、与代码清单一致、两种格式的文件都在、总量 ≤ 400 KB', () => {
  const dir = new URL('../public/sounds/typewriter/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'))
  const v = validateTypingSoundManifest(manifest)
  assert.ok(v.ok, v.ok ? '' : v.errors.join('; '))
  assert.deepEqual(Object.keys(manifest.presets).sort(), TYPING_SOUND_PRESETS.map(p => p.id).sort())
  let total = 0
  for (const p of TYPING_SOUND_PRESETS) {
    const m = manifest.presets[p.id]
    assert.deepEqual(m.hits, [...p.hits], p.id)
    assert.equal(m.accent ?? undefined, p.accent, p.id)
    assert.ok(p.hits.length >= 4 && p.hits.length <= 8)
    for (const path of [...p.hits, ...(p.accent ? [p.accent] : [])]) {
      for (const ext of manifest.formats) {
        const f = new URL(`${path}.${ext}`, dir)
        assert.ok(existsSync(f), `missing ${path}.${ext}`)
        const buf = readFileSync(f)
        assert.ok(buf.length > 200 && buf.length < 8192, `${path}.${ext}: ${buf.length} B`)
        if (ext === 'ogg') {
          assert.equal(buf.subarray(0, 4).toString('latin1'), 'OggS')
          assert.ok(buf.includes(Buffer.from('OpusHead')), `${path}.ogg is not Opus`)
        } else {
          assert.equal(buf.subarray(4, 8).toString('latin1'), 'ftyp')
        }
        total += statSync(f).size
      }
    }
    // 测量数据: 单发 30–150 ms, 峰值 ≤ −6 dBFS
    for (const a of m.analysis.filter(a => !a.file.endsWith('/accent'))) {
      assert.ok(a.ms >= 30 && a.ms <= 150, `${a.file} ${a.ms} ms`)
      assert.ok(a.peakDbfs <= -5.9, `${a.file} peak ${a.peakDbfs}`)
    }
  }
  assert.ok(total <= 400 * 1024, `total ${total} B`)
})

test('打字声清单校验: 拒绝未知音色、非 CC0 来源、重复或过少的样本、越界路径', () => {
  const src = { url: 'https://freesound.org/people/a/sounds/1/', license: 'CC0-1.0', author: 'a' }
  const good = { version: 1, formats: ['ogg', 'm4a'], presets: { pen: { hits: ['pen/1', 'pen/2', 'pen/3', 'pen/4'], source: src } } }
  assert.ok(validateTypingSoundManifest(good).ok)
  const bad = mut => {
    const m = JSON.parse(JSON.stringify(good))
    mut(m)
    return validateTypingSoundManifest(m).ok
  }
  assert.equal(validateTypingSoundManifest(null).ok, false)
  assert.equal(bad(m => { m.version = 2 }), false)
  assert.equal(bad(m => { m.formats = ['ogg'] }), false)
  assert.equal(bad(m => { m.presets.bell = m.presets.pen }), false)
  assert.equal(bad(m => { m.presets.pen.source.license = 'CC-BY-NC-4.0' }), false)
  assert.equal(bad(m => { m.presets.pen.source.url = 'https://pixabay.com/sound-effects/x/' }), false)
  assert.equal(bad(m => { m.presets.pen.hits = ['pen/1', 'pen/1', 'pen/2', 'pen/3'] }), false)
  assert.equal(bad(m => { m.presets.pen.hits = ['pen/1', 'pen/2'] }), false)
  assert.equal(bad(m => { m.presets.pen.hits[0] = '../secret' }), false)
  assert.equal(bad(m => { m.presets.pen.hits[0] = 'soft/1' }), false)
  assert.equal(bad(m => { m.presets.pen.accent = 'pen/../x' }), false)
})

test('打字声合成兜底: 每个音色都能生成, 结果确定、无 NaN、峰值约 −6 dBFS、首尾无爆音', () => {
  for (const p of TYPING_SOUND_PRESETS) {
    const a = synthHit(p.id, 48000, seeded(1))
    const b = synthHit(p.id, 48000, seeded(1))
    assert.deepEqual(a, b)
    assert.ok(a.length >= 48000 * 0.05 && a.length <= 48000 * 0.15, `${p.id} ${a.length}`)
    let peak = 0
    for (const x of a) { assert.ok(Number.isFinite(x)); peak = Math.max(peak, Math.abs(x)) }
    assert.ok(Math.abs(peak - 0.5) < 1e-6)
    assert.equal(a[0], 0)
    assert.ok(Math.abs(a[a.length - 1]) < 0.01)
    // 不同随机种子 → 不同的一声 (每次击键略有变化)
    assert.notDeepEqual(a, synthHit(p.id, 48000, seeded(2)))
  }
  assert.equal(synthHit('pen', 44100, seeded(3)).length, Math.round(44100 * 0.1))
})

// ---- 自动翻页 / 滚动速度: 1–100 档 (services/autoReadSpeed.ts) ----
import { AUTO_SPEED_LEVELS, AUTO_SPEED_STEPS, autoSpeedKey, stepAutoSpeed, speedPosition, secondsAtPosition, autoReadMotion } from '../src/services/autoReadSpeed.ts'

test('自动速度: 100 档, 刻度从极慢到极快, 默认 15 秒落在正中间「适中」', () => {
  assert.equal(AUTO_SPEED_STEPS, 100)
  assert.deepEqual(AUTO_SPEED_LEVELS.map(l => l.level), ['slowest', 'verySlow', 'slow', 'medium', 'fast', 'veryFast', 'fastest'])
  assert.equal(AUTO_SPEED_LEVELS[0].position, 1)
  assert.equal(AUTO_SPEED_LEVELS.at(-1).position, 100)
  for (let i = 1; i < AUTO_SPEED_LEVELS.length; i++) assert.ok(AUTO_SPEED_LEVELS[i].seconds < AUTO_SPEED_LEVELS[i - 1].seconds)
  assert.ok(AUTO_SPEED_LEVELS[0].seconds >= 5 * 60, '极慢比旧版「很慢」(30 秒) 慢得多')
  assert.ok(AUTO_SPEED_LEVELS.at(-1).seconds <= 3, '极快留足余地')
  assert.equal(speedPosition(15), 50)
  assert.equal(autoSpeedKey(15), 'reader.speedMedium')
})

test('自动速度: 每一档都比上一档快, 档位与秒数往返稳定', () => {
  let prev = Infinity
  for (let p = 1; p <= 100; p++) {
    const s = secondsAtPosition(p)
    assert.ok(s < prev, `第 ${p} 档应比第 ${p - 1} 档快`)
    prev = s
    assert.equal(speedPosition(s), p, `往返 ${p}`)
  }
  assert.equal(secondsAtPosition(0), secondsAtPosition(1))
  assert.equal(secondsAtPosition(500), secondsAtPosition(100))
})

test('自动速度: 旧秒数落到最近档位, 快慢一点每次 5 档且到头不动', () => {
  assert.equal(autoSpeedKey(40), 'reader.speedSlow')
  assert.equal(autoSpeedKey(600), 'reader.speedSlowest')
  assert.equal(autoSpeedKey(2), 'reader.speedFastest')
  assert.equal(speedPosition(stepAutoSpeed(15, 1)), 55)
  assert.equal(speedPosition(stepAutoSpeed(15, -1)), 45)
  assert.equal(stepAutoSpeed(3, 1), 3)
  assert.equal(stepAutoSpeed(300, -1), 300)
})

// ---- 按词着色 = 点睛阅读基础版 (开关与版本见 services/dianjing/level.ts, 面板见 DianjingToggle.vue) ----
import zhDict from '../src/i18n/zh.ts'
import enDict from '../src/i18n/en.ts'

test('点睛阅读两个版本的文案: 中英都有; 界面里不再出现旧名、实验分组和「读不快」之类的说明', () => {
  for (const key of ['dianjing.title', 'dianjing.subtitle', 'dianjing.levelBasic', 'dianjing.levelSmart', 'dianjing.basicDesc',
    'dianjing.basicNote', 'dianjing.smartDesc', 'dianjing.useBasic', 'dianjing.basicUnsupported', 'readingMode.guideStrength', 'readingMode.guideColor']) {
    assert.ok(zhDict[key], `zh missing ${key}`)
    assert.ok(enDict[key], `en missing ${key}`)
  }
  assert.equal(zhDict['dianjing.subtitle'], '让重点自己浮出来')
  assert.equal(zhDict['dianjing.levelBasic'], '基础')
  assert.equal(zhDict['dianjing.levelSmart'], '智能')
  for (const key of ['readingMode.groupLab', 'readingMode.lab', 'readingMode.modeWordGuide', 'readingMode.wordGuideHint', 'readingMode.wordGuideBlocked']) {
    assert.ok(!(key in zhDict) && !(key in enDict), `${key} 应已删除`)
  }
  const zhText = Object.values(zhDict).join('\n')
  const enText = Object.values(enDict).join('\n')
  for (const w of ['仿生', '分明阅读', '词彩', '读得更快', '拿不准']) assert.ok(!zhText.includes(w), `zh 界面文案不应出现「${w}」`)
  for (const w of ['Bionic', 'Clear Words', 'Word guide']) assert.ok(!enText.includes(w), `en 界面文案不应出现「${w}」`)
  const panel = readFileSync(new URL('../src/components/ReadingModePanel.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(panel, /wordGuide\.enabled|setWordGuide|groupLab/, '阅读模式面板里不再有单独的按词着色开关')
})

test('自动阅读的推进方式: 翻页 / 固定版式按页, 滚动匀速滚, 墨水屏滚动整屏推进', () => {
  assert.equal(autoReadMotion('paginated'), 'page')
  assert.equal(autoReadMotion('paginated', { eink: true }), 'page')
  assert.equal(autoReadMotion('scrolled'), 'scroll')
  assert.equal(autoReadMotion('scrolled', { eink: true }), 'screen')
  assert.equal(autoReadMotion('scrolled', { fixedLayout: true }), 'page')
})


test('歌词自定义行数、0–1 高度坐标及边缘完整显示', () => {
  assert.deepEqual(focusWindow(5, 4, 12), [4, 7])
  assert.deepEqual(focusWindow(5, 7, 12), [2, 8])
  assert.deepEqual(focusWindow(0, 99, 5), [0, 4])
  assert.equal(normalizeFocusLines(0), 1)
  assert.equal(normalizeFocusLines(2.8), 3)
  assert.equal(normalizeFocusLines(Infinity), 1)
  assert.equal(normalizeFocusLines(150), 99)
  assert.equal(lyricHeight(0.382), 0.618)
  assert.equal(anchorAtHeight(0.618), 0.382)
  assert.equal(anchorAtHeight(0), 1)
  assert.equal(anchorAtHeight(1), 0)
  assert.equal(anchorAtHeight(-1), 1)
  assert.equal(anchorAtHeight(2), 0)
  assert.equal(pinDelta(700, 730, 0, 1000, anchorAtHeight(1)), 700)
  assert.equal(pinDelta(700, 730, 0, 1000, anchorAtHeight(0)), -270)
})
