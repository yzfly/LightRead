import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupFolderBooks, addFolderBooklists } from '../src/services/folderBooklists.ts'

const entry = path => ({ path })
const ok = bookId => ({ ok: true, bookId })

test('keeps root and nested categories distinct, even with duplicate basenames', () => {
  const groups = groupFolderBooks('我的书', ['root.epub', '中国/历史/book.epub', '欧洲/历史/book.epub', '欧洲\\历史\\other.epub'].map(entry), [ok('root'), ok('china'), ok('europe'), ok('other')])
  assert.deepEqual([...groups], [['我的书', ['root']], ['我的书/中国/历史', ['china']], ['我的书/欧洲/历史', ['europe', 'other']]])
})
test('failed and missing import results never shift the association or create empty lists', () => {
  assert.deepEqual([...groupFolderBooks('Books', ['bad/a.epub', 'good/b.epub', 'missing/c.epub'].map(entry), [{ ok: false }, ok('b')])], [['Books/good', ['b']]])
})
test('multi-root drops retain folder prefixes and leave loose files ungrouped', () => {
  assert.deepEqual([...groupFolderBooks('', ['A/book.epub', 'B/book.epub', 'loose.epub'].map(entry), [ok('a'), ok('b'), ok('loose')])], [['A', ['a']], ['B', ['b']]])
})
test('ignores invalid absolute/traversal paths and deduplicates repeated book IDs', () => {
  const paths = ['../a.epub', '/private/b.epub', 'C:\\private\\c.epub', 'fine/d.epub', 'fine/e.epub']
  assert.deepEqual([...groupFolderBooks('Books', paths.map(entry), paths.map(() => ok('same')))], [['Books/fine', ['same']]])
})
test('reuses existing lists case-insensitively and groups successful imports only', async () => {
  const created = [], added = []
  const library = {
    booklists: [{ id: 'existing', name: ' BOOKS/FICTION ' }],
    async createBooklist(name) { created.push(name); return `new-${created.length}` },
    async addBooksToBooklist(id, ids) { added.push([id, ids]) },
  }
  await addFolderBooklists(library, 'Books', ['fiction/a.epub', 'Fiction/b.epub', 'history/c.epub', 'failed/d.epub'].map(entry), [ok('a'), ok('b'), ok('c'), { ok: false }])
  assert.deepEqual(created, ['Books/history'])
  assert.deepEqual(added, [['existing', ['a']], ['existing', ['b']], ['new-1', ['c']]])
})
