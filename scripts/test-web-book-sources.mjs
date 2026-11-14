import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALL_WEB_BOOK_SOURCES, webBookSourcesFor, webBookSourceUrl } from '../src/services/webBookSources.ts'

test('website queries preserve reserved characters and cannot replace the provider origin', () => {
  const query = ' 中文 /?a=1&b=2#fragment '
  for (const source of ALL_WEB_BOOK_SOURCES) {
    const url = webBookSourceUrl(source, query)
    assert.equal(new URL(url).origin, new URL(source.url).origin)
    assert.equal(new URL(url).protocol, 'https:')
    if (source.searchUrl) assert.ok(url.includes(encodeURIComponent(query.trim())))
    else assert.equal(url, source.url)
    assert.equal(webBookSourceUrl(source, '  '), source.url)
  }
})

test('iOS builds leave out shadow libraries; other platforms keep every source', () => {
  const ios = webBookSourcesFor('ios').map(s => s.id)
  assert.ok(!ios.includes('zlibrary') && !ios.includes('annas'))
  assert.ok(ios.includes('standardebooks'))
  for (const platform of ['web', 'windows', 'macos', 'linux', 'android']) {
    assert.equal(webBookSourcesFor(platform).length, ALL_WEB_BOOK_SOURCES.length)
  }
})
