import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  handleReaderCopyShortcut,
  isPlatformCopyShortcut,
  shouldClearCopiedSelection,
} from '../src/services/keyboardShortcuts.ts'

const keyEvent = (overrides = {}) => ({
  key: 'c',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
})

test('uses Command+C on macOS', () => {
  assert.equal(isPlatformCopyShortcut(keyEvent({ metaKey: true }), true), true)
  assert.equal(isPlatformCopyShortcut(keyEvent({ ctrlKey: true }), true), false)
})

test('uses Ctrl+C on Windows and other non-Mac platforms', () => {
  assert.equal(isPlatformCopyShortcut(keyEvent({ ctrlKey: true }), false), true)
  assert.equal(isPlatformCopyShortcut(keyEvent({ metaKey: true }), false), false)
})

test('accepts uppercase C but rejects modified or unrelated shortcuts', () => {
  assert.equal(isPlatformCopyShortcut(keyEvent({ key: 'C', ctrlKey: true }), false), true)
  assert.equal(isPlatformCopyShortcut(keyEvent({ ctrlKey: true, shiftKey: true }), false), false)
  assert.equal(isPlatformCopyShortcut(keyEvent({ ctrlKey: true, altKey: true }), false), false)
  assert.equal(isPlatformCopyShortcut(keyEvent({ key: 'v', ctrlKey: true }), false), false)
})

const readerCopyDispatch = (eventOverrides = {}, contextOverrides = {}) => {
  const calls = { copied: 0, editableChecks: 0, nativeChecks: 0, prevented: 0 }
  const event = keyEvent({
    ctrlKey: true,
    preventDefault: () => { calls.prevented += 1 },
    ...eventOverrides,
  })
  const context = {
    hasCustomSelection: true,
    isEditableTarget: () => {
      calls.editableChecks += 1
      return false
    },
    hasNativeSelection: () => {
      calls.nativeChecks += 1
      return false
    },
    copySelection: () => { calls.copied += 1 },
    ...contextOverrides,
  }
  return {
    calls,
    handled: handleReaderCopyShortcut(event, false, context),
  }
}

test('dispatches custom copy and prevents the browser default', () => {
  const { calls, handled } = readerCopyDispatch()
  assert.equal(handled, true)
  assert.deepEqual(calls, { copied: 1, editableChecks: 1, nativeChecks: 1, prevented: 1 })
})

test('prevents held-key repeats without dispatching another copy', () => {
  const { calls, handled } = readerCopyDispatch({ repeat: true })
  assert.equal(handled, true)
  assert.equal(calls.prevented, 1)
  assert.equal(calls.copied, 0)
})

test('preserves editable-target and browser-native copy behavior', () => {
  const editable = readerCopyDispatch({}, { isEditableTarget: () => true })
  assert.equal(editable.handled, false)
  assert.equal(editable.calls.prevented, 0)
  assert.equal(editable.calls.copied, 0)
  assert.equal(editable.calls.nativeChecks, 0)

  const native = readerCopyDispatch({}, { hasNativeSelection: () => true })
  assert.equal(native.handled, false)
  assert.equal(native.calls.prevented, 0)
  assert.equal(native.calls.copied, 0)
})

test('ignores ineligible shortcuts before probing the DOM', () => {
  const noSelection = readerCopyDispatch({}, { hasCustomSelection: false })
  assert.equal(noSelection.handled, false)
  assert.deepEqual(noSelection.calls, { copied: 0, editableChecks: 0, nativeChecks: 0, prevented: 0 })

  const wrongModifier = readerCopyDispatch({ metaKey: true, ctrlKey: false })
  assert.equal(wrongModifier.handled, false)
  assert.deepEqual(wrongModifier.calls, { copied: 0, editableChecks: 0, nativeChecks: 0, prevented: 0 })
})

test('only clears the selection copied by the completed async operation', () => {
  const copied = { text: 'first' }
  const newer = { text: 'second' }
  assert.equal(shouldClearCopiedSelection(copied, copied), true)
  assert.equal(shouldClearCopiedSelection(newer, copied), false)
})
