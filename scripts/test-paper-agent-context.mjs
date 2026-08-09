import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPaperContextMarkdown,
  buildPaperNotesMarkdown,
  buildPaperTextSnapshot,
  cachedPaperTextSnapshot,
  clearPaperTextSnapshotCache,
  paperAnnotationPage,
} from '../src/services/paperAgentContext.ts'

test('extracts every page without a character budget and yields between batches', async () => {
  const lastPage = `LAST-PAGE-SENTINEL-${'x'.repeat(25000)}`
  let yields = 0
  const progress = []
  const snapshot = await buildPaperTextSnapshot({
    pageCount: 3,
    batchSize: 1,
    pageText: page => page === 2 ? lastPage : `Text on page ${page + 1}`,
    yieldToUi: async () => { yields++ },
    onProgress: value => progress.push(value.completedPages),
  })

  assert.match(snapshot.content, /\[Page 1\]/)
  assert.match(snapshot.content, /\[Page 3\]/)
  assert.ok(snapshot.content.includes(lastPage))
  assert.deepEqual(progress, [1, 2, 3])
  assert.equal(yields, 2)
})

test('keeps explicit markers for empty and failed pages', async () => {
  const snapshot = await buildPaperTextSnapshot({
    pageCount: 3,
    pageText: page => {
      if (page === 0) return ''
      if (page === 1) throw new Error('broken page')
      return 'final text'
    },
  })

  assert.match(snapshot.content, /\[Page 1\]\n\[No extractable text/)
  assert.match(snapshot.content, /\[Page 2\]\n\[Text extraction failed.*broken page/)
  assert.match(snapshot.content, /\[Page 3\]\nfinal text/)
  assert.deepEqual(snapshot.failedPages, [2])
})

test('describes image-only PDFs instead of returning an empty file', async () => {
  const snapshot = await buildPaperTextSnapshot({ pageCount: 2, pageText: () => '' })
  assert.equal(snapshot.scannedOrImageOnly, true)
  assert.match(snapshot.content, /scanned or image-only/i)
  assert.match(snapshot.content, /paper\.pdf/)
})

test('caches immutable text extraction by PDF fingerprint', async () => {
  clearPaperTextSnapshotCache()
  let calls = 0
  const options = { pageCount: 2, pageText: () => `call ${++calls}` }
  const first = await cachedPaperTextSnapshot('sha256:abc', options)
  const second = await cachedPaperTextSnapshot('sha256:abc', options)
  assert.equal(first, second)
  assert.equal(calls, 2)
})

test('serializes highlights, notes, empty sets, and malformed locations deterministically', () => {
  const notes = buildPaperNotesMarkdown([
    { id: 'bad', bookId: 'p', cfi: 'epubcfi(/6/2)', text: 'Malformed', note: 'Keep it', color: 'yellow', createdAt: 2 },
    { id: 'a2', bookId: 'p', cfi: 'p:2:[[1,2,3,4]]', text: 'Quoted\ntext', color: 'blue', createdAt: 1 },
    { id: 'a1', bookId: 'p', cfi: 'p:1:[[1,2,3,4]]', text: 'First', note: 'Analysis', color: 'red', createdAt: 3 },
    { id: 'bookmark', bookId: 'p', kind: 'bookmark', cfi: 'p:1:[]', text: '', color: '', createdAt: 0 },
  ])

  assert.ok(notes.indexOf('Page 1 — a1') < notes.indexOf('Page 2 — a2'))
  assert.match(notes, /> Quoted\n> text/)
  assert.match(notes, /Unknown page — bad/)
  assert.match(notes, /### Note\n\n\(no note\)/)
  assert.equal(paperAnnotationPage('p:23:[]'), 23)
  assert.equal(paperAnnotationPage('broken'), null)
  assert.match(buildPaperNotesMarkdown([]), /No highlights or notes/)
})

test('writes current selection and explicit cleared selection without coordinates', () => {
  const base = {
    book: { id: 'paper-1', title: 'A Paper', author: 'Ada', fileName: 'paper.pdf' },
    pageCount: 12,
    currentPage: 4,
    extraction: { extractedPages: 11, emptyPages: 1, failedPages: [], scannedOrImageOnly: false },
    snapshotRevision: 'rev-7',
    fileHashes: { 'notes.md': 'n1', 'paper.txt': 't1' },
  }
  const selected = buildPaperContextMarkdown({ ...base, selection: { page: 7, text: 'selected claim' } })
  const cleared = buildPaperContextMarkdown({ ...base, currentPage: 8, selection: null })

  assert.match(selected, /Current page: 4/)
  assert.match(selected, /Page: 7/)
  assert.match(selected, /> selected claim/)
  assert.doesNotMatch(selected, /rect|coordinate|anchor/i)
  assert.match(cleared, /Current page: 8/)
  assert.match(cleared, /No text is currently selected/)
  assert.doesNotMatch(cleared, /selected claim/)
})
