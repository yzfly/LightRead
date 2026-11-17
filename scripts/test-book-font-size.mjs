import assert from 'node:assert/strict'
import { test } from 'node:test'
import { relativizeFontSizes, relativizeHtmlFontSizes, relativizeBookResource } from '../src/services/bookFontSize.ts'

test('absolute font-size in book CSS becomes rem relative to 16px (issue #22)', () => {
  assert.equal(relativizeFontSizes('body{font-size:16px}'), 'body{font-size:1rem}')
  assert.equal(relativizeFontSizes('p { font-size: 12pt; }'), 'p { font-size: 1rem; }')
  assert.equal(relativizeFontSizes('p.small { font-size: 10.5PT !important }'), 'p.small { font-size: 0.875rem !important }')
  assert.equal(relativizeFontSizes('h1{font-size:24px}\nh2 {font-size : 1.5pc}'), 'h1{font-size:1.5rem}\nh2 {font-size : 1.5rem}')
  assert.equal(relativizeFontSizes('.n{font-size:small}.t{font-size: x-large;}'), '.n{font-size:0.8125rem}.t{font-size: 1.5rem;}')
})

test('relative sizes and look-alikes stay untouched', () => {
  const css = 'p{font-size:1em}h1{font-size:150%}.a{font-size:smaller}.b{font-size:larger}.c{font-size:1.2rem}.d{font-size:calc(12px + 1vw)}.e{font-family:small}'
  assert.equal(relativizeFontSizes(css), css)
  assert.equal(relativizeFontSizes('p{margin:12px;line-height:18px}'), 'p{margin:12px;line-height:18px}')
})

test('font shorthand: only the size token is rewritten', () => {
  assert.equal(relativizeFontSizes('body{font: italic bold 12pt/1.4 Georgia, serif}'), 'body{font: italic bold 1rem/1.4 Georgia, serif}')
  assert.equal(relativizeFontSizes('p{font:18px serif}'), 'p{font:1.125rem serif}')
  assert.equal(relativizeFontSizes('p{font: small-caps 16px serif}'), 'p{font: small-caps 1rem serif}')
  assert.equal(relativizeFontSizes('p{font-variant:small-caps}'), 'p{font-variant:small-caps}')
})

test('(X)HTML: only <style> and style="" change, never the text', () => {
  const html = '<html><head><style>p{font-size:12pt}</style></head><body><p style="font-size: 9pt;color:red">code: font-size: 12px</p></body></html>'
  assert.equal(relativizeHtmlFontSizes(html),
    '<html><head><style>p{font-size:1rem}</style></head><body><p style="font-size: 0.75rem;color:red">code: font-size: 12px</p></body></html>')
})

test('resource hook dispatches by media type', () => {
  assert.equal(relativizeBookResource('text/css', 'p{font-size:32px}'), 'p{font-size:2rem}')
  assert.equal(relativizeBookResource('application/xhtml+xml', '<p style="font-size:8px">x</p>'), '<p style="font-size:0.5rem">x</p>')
  assert.equal(relativizeBookResource('image/jpeg', 'font-size:12px'), 'font-size:12px')
  const blob = { size: 1 }
  assert.equal(relativizeBookResource('text/css', blob), blob)
})

test('style attribute with nested quotes', () => {
  assert.equal(relativizeHtmlFontSizes(`<p style="font-family:'Song'; font-size:12pt">x</p>`), `<p style="font-family:'Song'; font-size:1rem">x</p>`)
  assert.equal(relativizeHtmlFontSizes(`<p style='font-size:24px'>x</p>`), `<p style='font-size:1.5rem'>x</p>`)
})
