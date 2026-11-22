// 双语对照 (issue #23): 哪些段落要翻 / 翻成什么 / 先翻哪几段 / 缓存键 / 其他遍历正文的模块跳过译文
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  BILINGUAL_AHEAD,
  INERT_ATTR,
  bookCacheKey,
  cleanTranslation,
  entryKey,
  isInertNode,
  paragraphHash,
  paragraphTarget,
  planParagraphs,
} from '../src/services/bilingualCore.ts'

test('英文段落在中文界面默认译成简体中文; 中文段落不译成中文', () => {
  const en = 'It was the best of times, it was the worst of times, it was the age of wisdom.'
  assert.equal(paragraphTarget(en, 'auto', 'zh'), 'zh-Hans')
  assert.equal(paragraphTarget(en, 'zh-Hant', 'zh'), 'zh-Hant')
  assert.equal(paragraphTarget('正义是强者的利益。', 'zh-Hans', 'zh'), null)
  assert.equal(paragraphTarget('正义是强者的利益。', 'zh-Hant', 'zh'), null, '简繁互转交给「简繁转换」')
  // 自动目标: 中文书译成英文 (与划词翻译一致)
  assert.equal(paragraphTarget('正义是强者的利益。', 'auto', 'zh'), 'en')
})

test('目标是英文时英文段落不翻, 法文段落照翻', () => {
  assert.equal(paragraphTarget('The quick brown fox jumps over the lazy dog and the cat.', 'en', 'zh'), null)
  assert.equal(paragraphTarget('La justice est l’avantage du plus fort, dit Thrasymaque.', 'en', 'zh'), 'en')
})

test('没有文字、太短的段落不翻', () => {
  assert.equal(paragraphTarget('', 'auto', 'zh'), null)
  assert.equal(paragraphTarget('  12  ', 'auto', 'zh'), null)
  assert.equal(paragraphTarget('* * *', 'auto', 'zh'), null)
  assert.equal(paragraphTarget('I', 'auto', 'zh'), null)
  assert.equal(paragraphTarget('Chapter 1', 'auto', 'zh'), 'zh-Hans', '章节标题也翻')
})

test('缓存键: 空白差异不影响, 内容 / 目标 / 书 / 模型不同则不同', () => {
  const a = 'Call me Ishmael.  Some years ago'
  assert.equal(paragraphHash(a), paragraphHash(' Call me Ishmael. Some years ago\n'))
  assert.notEqual(paragraphHash(a), paragraphHash('Call me Ishmael. Some years ago.'))
  assert.notEqual(entryKey(a, 'zh-Hans'), entryKey(a, 'ja'))
  assert.notEqual(bookCacheKey('b1', 'hy-mt2-1.8b-q4'), bookCacheKey('b1', 'hy-mt2-1.8b-stq1'))
})

test('从当前看到的段起往后预翻, 跳过已译和不用翻的', () => {
  const done = new Set([1, 3])
  assert.deepEqual(planParagraphs(20, 0, i => !done.has(i), 5), [0, 2, 4])
  assert.deepEqual(planParagraphs(3, 1, () => true), [1, 2], '到章末为止')
  assert.deepEqual(planParagraphs(3, 3, () => true), [])
  assert.deepEqual(planParagraphs(3, -1, () => true), [])
  assert.equal(planParagraphs(100, 10, () => true).length, BILINGUAL_AHEAD)
})

test('译文整理: 去掉首尾空白和「译文：」前缀', () => {
  assert.equal(cleanTranslation('  译文：叫我以实玛利。\n'), '叫我以实玛利。')
  assert.equal(cleanTranslation('Translation: Call me Ishmael.'), 'Call me Ishmael.')
  assert.equal(cleanTranslation('\n'), '')
})

test('isInertNode: 自身或祖先带标记即为插入的译文', () => {
  const el = (attrs, parent = null) => ({ nodeType: 1, parentElement: parent, hasAttribute: n => attrs.includes(n) })
  const span = el([INERT_ATTR], el([]))
  const text = { nodeType: 3, parentElement: span }
  assert.equal(isInertNode(text), true)
  assert.equal(isInertNode(span), true)
  assert.equal(isInertNode({ nodeType: 3, parentElement: el([]) }), false)
  assert.equal(isInertNode(null), false)
})

test('遍历正文的模块都跳过译文 (听书 / 打字机 / 点睛 / 简繁转换 / 选段)', () => {
  for (const [file, needle] of [
    ['src/services/readAloud.ts', 'INERT_ATTR'],
    ['src/services/readingModes/blocks.ts', 'INERT_ATTR'],
    ['src/services/dianjing/textModel.ts', 'INERT_ATTR'],
    ['src/services/zhConvert.ts', 'isInertNode'],
    ['src/services/selectParagraph.ts', 'isInertNode'],
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.ok(src.includes(needle), `${file} 要跳过双语译文`)
  }
})

test('双语对照只走本机模型 (不联网、不计账号额度)', () => {
  const src = readFileSync(new URL('../src/services/bilingual.ts', import.meta.url), 'utf8')
  assert.match(src, /translateLocal\(/)
  assert.doesNotMatch(src, /translateText\(|chatStream\(|fetch\(/)
})

test('四份字典都有双语对照文案', () => {
  const keys = ['reader.bilingual', 'reader.bilingualHint', 'reader.bilingualNeedsModel', 'reader.bilingualFailed']
  for (const f of ['src/i18n/zh.ts', 'src/i18n/en.ts', 'src/mobile/i18n/zh.ts', 'src/mobile/i18n/en.ts']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    for (const k of keys) assert.ok(src.includes(`'${k}':`), `${f} 缺 ${k}`)
  }
})
