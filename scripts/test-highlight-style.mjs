import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightDrawSpec, drawHighlight, normalizeHighlightStyle, storedHighlightStyle } from '../src/services/highlightStyle.ts'

const fills = { yellow: '#ffd54d', red: '#ff8f8f' }

test('style normalisation: unknown / missing values are marker highlights', () => {
  assert.equal(normalizeHighlightStyle(undefined), 'highlight')
  assert.equal(normalizeHighlightStyle('strike'), 'highlight')
  assert.equal(normalizeHighlightStyle('squiggly'), 'squiggly')
  assert.equal(storedHighlightStyle('highlight'), undefined)
  assert.equal(storedHighlightStyle(null), undefined)
  assert.equal(storedHighlightStyle('underline'), 'underline')
})

test('draw spec: marker uses the fill colour, lines use the deeper line colour', () => {
  assert.deepEqual(highlightDrawSpec(fills, 'yellow', undefined), { kind: 'highlight', options: { color: '#ffd54d' } })
  const u = highlightDrawSpec(fills, 'yellow', 'underline', 'horizontal-tb')
  assert.equal(u.kind, 'underline')
  assert.notEqual(u.options.color, '#ffd54d')
  assert.equal(u.options.writingMode, 'horizontal-tb')
  const s = highlightDrawSpec(fills, '#123456', 'squiggly', 'vertical-rl')
  assert.equal(s.kind, 'squiggly')
  assert.equal(s.options.color, '#123456', 'custom colours pass through')
  assert.equal(s.options.writingMode, 'vertical-rl')
})

test('drawHighlight calls the matching Overlayer method', () => {
  const Overlayer = { highlight: () => 'h', underline: () => 'u', squiggly: () => 's' }
  const calls = []
  const draw = (fn, opts) => calls.push([fn(), opts.color])
  drawHighlight(Overlayer, fills, { draw, annotation: { color: 'red', style: 'underline' } })
  drawHighlight(Overlayer, fills, { draw, annotation: { color: 'red' } })
  assert.deepEqual(calls.map(c => c[0]), ['u', 'h'])
  assert.equal(calls[1][1], '#ff8f8f')
})
