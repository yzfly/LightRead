import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  PDF_READER_SHORTCUTS,
  dispatchPdfReaderShortcut,
  getPdfShortcutHelpRows,
  resolvePdfReaderShortcut,
  shouldClearCopiedSelection,
} from '../src/services/keyboardShortcuts.ts'
import en from '../src/i18n/en.ts'
import zh from '../src/i18n/zh.ts'

const keyEvent = (overrides = {}) => ({
  key: 'c',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
})

test('only clears the selection copied by the completed async operation', () => {
  const copied = { text: 'first' }
  const newer = { text: 'second' }
  assert.equal(shouldClearCopiedSelection(copied, copied), true)
  assert.equal(shouldClearCopiedSelection(newer, copied), false)
})

const readerState = { isPaper: false, pdfLayout: 'original' }

test('resolves primary commands with the strict platform modifier', () => {
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'C', metaKey: true }), true, readerState), 'copy')
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'c', ctrlKey: true }), false, readerState), 'copy')
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'c', metaKey: true }), false, readerState), null)
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'c', ctrlKey: true, shiftKey: true }), false, readerState), null)
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'f', metaKey: true }), true, readerState), 'search')
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'f', ctrlKey: true }), true, readerState), null)
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'f', ctrlKey: true }), false, readerState), 'search')
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'f', metaKey: true }), false, readerState), null)
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'f', ctrlKey: true, metaKey: true }), false, readerState), null)
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'f', ctrlKey: true, altKey: true }), false, readerState), null)
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 'f', ctrlKey: true, shiftKey: true }), false, readerState), null)
})

test('filters commands by PDF reader capability', () => {
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: '6', ctrlKey: true }), false, readerState), 'layoutSingle')
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: '6', ctrlKey: true }), false, { ...readerState, isPaper: true }), null)
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: '1', ctrlKey: true }), false, { ...readerState, pdfLayout: 'reflow' }), null)
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: '0', ctrlKey: true }), false, { ...readerState, pdfLayout: 'reflow' }), 'zoomReset')
})

test('prefers localized key meaning over physical-code zoom fallbacks', () => {
  assert.equal(
    resolvePdfReaderShortcut(keyEvent({ key: '?', code: 'Minus', shiftKey: true }), false, readerState),
    'toggleHelp',
  )
  assert.equal(
    resolvePdfReaderShortcut(keyEvent({ key: 'ß', code: 'Minus' }), false, readerState),
    'zoomOut',
  )
  assert.equal(
    resolvePdfReaderShortcut(keyEvent({ key: '§', code: 'Slash', shiftKey: true }), false, readerState),
    'toggleHelp',
  )
})

const dispatchReaderCommand = (eventOverrides = {}, contextOverrides = {}) => {
  const calls = { actions: [], canHandleChecks: 0, editableChecks: 0, prevented: 0 }
  const event = keyEvent({
    key: 'f',
    ctrlKey: true,
    preventDefault: () => { calls.prevented += 1 },
    ...eventOverrides,
  })
  const context = {
    state: readerState,
    isEditableTarget: () => {
      calls.editableChecks += 1
      return false
    },
    canHandleCommand: () => {
      calls.canHandleChecks += 1
      return true
    },
    runCommand: command => { calls.actions.push(command) },
    ...contextOverrides,
  }
  return {
    calls,
    handled: dispatchPdfReaderShortcut(event, false, context),
  }
}

test('dispatches recognized commands through one repeat-safe boundary', () => {
  const initial = dispatchReaderCommand()
  assert.equal(initial.handled, true)
  assert.deepEqual(initial.calls, {
    actions: ['search'],
    canHandleChecks: 1,
    editableChecks: 1,
    prevented: 1,
  })

  const repeated = dispatchReaderCommand({ repeat: true })
  assert.equal(repeated.handled, true)
  assert.deepEqual(repeated.calls, {
    actions: [],
    canHandleChecks: 1,
    editableChecks: 1,
    prevented: 1,
  })
})

test('dispatches custom Copy while preserving browser-native Copy', () => {
  const custom = dispatchReaderCommand({ key: 'c' })
  assert.equal(custom.handled, true)
  assert.deepEqual(custom.calls.actions, ['copy'])
  assert.equal(custom.calls.prevented, 1)

  const repeated = dispatchReaderCommand({ key: 'c', repeat: true })
  assert.equal(repeated.handled, true)
  assert.deepEqual(repeated.calls.actions, [])
  assert.equal(repeated.calls.prevented, 1)

  const native = dispatchReaderCommand({ key: 'c' }, { canHandleCommand: () => false })
  assert.equal(native.handled, false)
  assert.deepEqual(native.calls.actions, [])
  assert.equal(native.calls.prevented, 0)
})

test('preserves native behavior for editable targets before command-specific probes', () => {
  const result = dispatchReaderCommand({}, { isEditableTarget: () => true })
  assert.equal(result.handled, false)
  assert.equal(result.calls.prevented, 0)
  assert.equal(result.calls.canHandleChecks, 0)
  assert.deepEqual(result.calls.actions, [])
})

test('keeps common primary shortcuts native in editable controls', () => {
  for (const key of ['c', 's', 'o', 'f', 'p']) {
    const result = dispatchReaderCommand({ key }, { isEditableTarget: () => true })
    assert.equal(result.handled, false, `${key} should remain native`)
    assert.equal(result.calls.prevented, 0, `${key} should not be prevented`)
    assert.deepEqual(result.calls.actions, [], `${key} should not dispatch`)
  }
})

test('does not inspect DOM or selection state for unrelated keys', () => {
  const result = dispatchReaderCommand({ key: 'v', ctrlKey: false })
  assert.equal(result.handled, false)
  assert.deepEqual(result.calls, {
    actions: [],
    canHandleChecks: 0,
    editableChecks: 0,
    prevented: 0,
  })
})

test('projects every runtime command into capability-aware help', () => {
  const bookRows = getPdfShortcutHelpRows(readerState, false)
  const paperRows = getPdfShortcutHelpRows({ ...readerState, isPaper: true }, false)
  const reflowRows = getPdfShortcutHelpRows({ ...readerState, pdfLayout: 'reflow' }, false)
  const visibleIds = new Set(bookRows.flatMap(row => row.commandIds))

  assert.deepEqual(
    PDF_READER_SHORTCUTS.filter(command => command.isAvailable(readerState)).map(command => command.id).sort(),
    [...visibleIds].sort(),
  )
  assert.equal(bookRows.some(row => row.commandIds.includes('layoutSingle')), true)
  assert.equal(paperRows.some(row => row.commandIds.includes('layoutSingle')), false)
  assert.equal(reflowRows.some(row => row.commandIds.includes('actualSize')), false)
  assert.equal(reflowRows.some(row => row.commandIds.includes('zoomReset')), true)
})

test('maps standard and compatibility Save chords to one command', () => {
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 's', ctrlKey: true }), false, readerState), 'saveAs')
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 's', ctrlKey: true, shiftKey: true }), false, readerState), 'saveAs')
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 's', metaKey: true }), true, readerState), 'saveAs')
  assert.equal(resolvePdfReaderShortcut(keyEvent({ key: 's', metaKey: true, shiftKey: true }), true, readerState), 'saveAs')
})

test('dispatches Open once while suppressing held-key repeats', () => {
  const initial = dispatchReaderCommand({ key: 'o' })
  assert.deepEqual(initial.calls.actions, ['open'])
  assert.equal(initial.calls.prevented, 1)

  const repeated = dispatchReaderCommand({ key: 'o', repeat: true })
  assert.deepEqual(repeated.calls.actions, [])
  assert.equal(repeated.calls.prevented, 1)
})

test('localizes every shortcut help row in English and Chinese', () => {
  const labelKeys = new Set(PDF_READER_SHORTCUTS.map(command => command.helpLabelKey))
  for (const key of labelKeys) {
    assert.equal(typeof en[key], 'string', `missing English shortcut label: ${key}`)
    assert.equal(typeof zh[key], 'string', `missing Chinese shortcut label: ${key}`)
  }
})
