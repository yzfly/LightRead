// 智能目录契约: 章节识别规则 / 层级组装 / 按 CFI 判定当前章节
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectChapters, nestChapters, findCurrentSmartItem, flattenToc } from '../src/services/smartToc.ts'

const L = (text, heading) => (heading ? { text, heading } : { text })

test('至少两处 h1-h3 标题时只用标题, 层级按标题级别归一', () => {
  const hits = detectChapters([
    L('书名', 1), L('第一章 开端', 2), L('第一章 正文行 第二章 混淆'), L('小节', 3), L('第二章 转折', 2), L('附录', 4),
  ])
  assert.deepEqual(hits.map(h => [h.label, h.level]), [['书名', 0], ['第一章 开端', 1], ['小节', 2], ['第二章 转折', 1]])
})

test('无标题标签时按章节正则识别 (与 TXT 导入一致), 过长行不算', () => {
  const hits = detectChapters([
    L('前言'), L('　　正文段落，第一章 不是标题因为在句中'), L('第一章 风起'), L('Chapter 2 The Road'),
    L('第三章 ' + '很长'.repeat(30)), L('尾声'),
  ])
  assert.deepEqual(hits.map(h => h.label), ['前言', '第一章 风起', 'Chapter 2 The Road', '尾声'])
  assert.ok(hits.every(h => h.level === 0))
})

test('网络小说抓取稿: 标题行后紧跟「更新时间 / 字数」元信息行', () => {
  const hits = detectChapters([
    L('存在与虚无'), L(''), L('生命不能承受之轻'), L('更新时间2008-2-4 21:16:00 字数：2243'), L('　　正文……'),
    L('孤独的旁观者'), L('  '), L('字数：1800 更新时间 2008-2-5'), L('　　正文……'),
    L('这一行太长了不该被当作标题'.repeat(4)), L('更新时间2008-2-6'),
  ])
  assert.deepEqual(hits.map(h => h.label), ['生命不能承受之轻', '孤独的旁观者'])
})

test('只有一处标题时不采用标题规则, 退回正则', () => {
  const hits = detectChapters([L('书名', 1), L('第一章 a'), L('第二章 b')])
  assert.deepEqual(hits.map(h => h.label), ['第一章 a', '第二章 b'])
})

test('nestChapters 按 level 组树, 深层挂到最近的上级', () => {
  const tree = nestChapters([
    { label: 'A', level: 0, href: 'a' }, { label: 'A1', level: 1, href: 'a1' }, { label: 'A1x', level: 2, href: 'a1x' },
    { label: 'A2', level: 1, href: 'a2' }, { label: 'B', level: 0, href: 'b' }, { label: 'orphan-deep', level: 2, href: 'o' },
  ])
  assert.deepEqual(tree.map(i => i.label), ['A', 'B'])
  assert.deepEqual(tree[0].subitems.map(i => i.label), ['A1', 'A2'])
  assert.deepEqual(tree[0].subitems[0].subitems.map(i => i.label), ['A1x'])
  assert.deepEqual(tree[1].subitems.map(i => i.label), ['orphan-deep'])
  assert.equal(flattenToc(tree).length, 6)
})

test('findCurrentSmartItem: 取文档顺序上最后一个不晚于当前位置的条目', () => {
  const flat = [
    { label: 'c1', href: 'epubcfi(/6/2!/4/2/1:0)' },
    { label: 'c2', href: 'epubcfi(/6/2!/4/40/1:0)' },
    { label: 'c3', href: 'epubcfi(/6/6!/4/2/1:0)' },
  ]
  assert.equal(findCurrentSmartItem(flat, 'epubcfi(/6/2!/4/1:0)'), undefined)
  assert.equal(findCurrentSmartItem(flat, 'epubcfi(/6/2!/4/2/1:0)')?.label, 'c1')
  assert.equal(findCurrentSmartItem(flat, 'epubcfi(/6/2!/4/30/1:5)')?.label, 'c1')
  assert.equal(findCurrentSmartItem(flat, 'epubcfi(/6/2!/4/40/1:0)')?.label, 'c2')
  assert.equal(findCurrentSmartItem(flat, 'epubcfi(/6/4!/4/2/1:0)')?.label, 'c2')
  assert.equal(findCurrentSmartItem(flat, 'epubcfi(/6/8!/4/2/1:0)')?.label, 'c3')
  // 范围 CFI (可见页): 章节标题落在页内即算进入该章, 以范围末尾为准
  assert.equal(findCurrentSmartItem(flat, 'epubcfi(/6/2!/4,/30/1:0,/50/1:0)')?.label, 'c2')
  assert.equal(findCurrentSmartItem(flat, 'epubcfi(/6/2!/4,/10/1:0,/30/1:0)')?.label, 'c1')
  assert.equal(findCurrentSmartItem(flat, ''), undefined)
  assert.equal(findCurrentSmartItem(flat, 'not-a-cfi'), undefined)
})
