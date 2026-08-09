interface KeyboardShortcutEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

interface ReaderCopyShortcutEvent extends KeyboardShortcutEvent {
  repeat?: boolean
  preventDefault: () => void
}

interface ReaderCopyShortcutContext {
  hasCustomSelection: boolean
  isEditableTarget: () => boolean
  hasNativeSelection: () => boolean
  copySelection: () => void
}

/** macOS 只认 Command，Windows/Linux 只认 Ctrl，避免组合修饰键误触。 */
export function isPlatformCopyShortcut(
  event: KeyboardShortcutEvent,
  isMacPlatform: boolean,
): boolean {
  const primaryPressed = isMacPlatform
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  return primaryPressed
    && !event.altKey
    && !event.shiftKey
    && event.key.toLowerCase() === 'c'
}

/** Handles the reader's custom Copy path while preserving browser-native copy targets. */
export function handleReaderCopyShortcut(
  event: ReaderCopyShortcutEvent,
  isMacPlatform: boolean,
  context: ReaderCopyShortcutContext,
): boolean {
  if (!context.hasCustomSelection || !isPlatformCopyShortcut(event, isMacPlatform)) return false
  if (context.isEditableTarget() || context.hasNativeSelection()) return false
  event.preventDefault()
  if (!event.repeat) context.copySelection()
  return true
}

/** An older asynchronous copy must not dismiss a newer custom selection. */
export function shouldClearCopiedSelection<T extends object>(current: T | null | undefined, copied: T): boolean {
  return current === copied
}
