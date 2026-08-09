export interface KeyboardShortcutEvent {
  key: string
  code?: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type PdfReaderShortcutCommandId =
  | 'copy'
  | 'print'
  | 'saveAs'
  | 'open'
  | 'search'
  | 'findNext'
  | 'findPrevious'
  | 'historyBack'
  | 'historyForward'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'actualSize'
  | 'fitWidth'
  | 'layoutSingle'
  | 'layoutFacing'
  | 'layoutBook'
  | 'focusPage'
  | 'screenUp'
  | 'screenDown'
  | 'closePanels'
  | 'toggleHelp'
  | 'toggleFullscreen'
  | 'presentation'
  | 'toggleToc'
  | 'cycleFit'
  | 'togglePageMode'
  | 'firstPage'
  | 'lastPage'
  | 'nextPage'
  | 'previousPage'
  | 'pageUp'
  | 'pageDown'
  | 'lineUp'
  | 'lineDown'
  | 'lineLeft'
  | 'lineRight'

export interface PdfReaderShortcutState {
  isPaper: boolean
  pdfLayout: 'original' | 'reflow'
}

type ShiftRequirement = boolean | 'any'

interface PdfShortcutChord {
  keys: string[]
  codes?: string[]
  primary?: boolean
  alt?: boolean
  shift?: ShiftRequirement
  display: string[]
}

export interface PdfReaderShortcutDefinition {
  id: PdfReaderShortcutCommandId
  chords: PdfShortcutChord[]
  helpGroup: string
  helpLabelKey: string
  isAvailable: (state: PdfReaderShortcutState) => boolean
}

export interface PdfShortcutHelpRow {
  id: string
  commandIds: PdfReaderShortcutCommandId[]
  shortcuts: string[][]
  labelKey: string
}

const alwaysAvailable = () => true
const originalLayoutOnly = (state: PdfReaderShortcutState) => state.pdfLayout === 'original'
const bookOnly = (state: PdfReaderShortcutState) => !state.isPaper
const originalBookOnly = (state: PdfReaderShortcutState) => !state.isPaper && state.pdfLayout === 'original'

const primaryChord = (
  keys: string | string[],
  display: string,
  options: Pick<PdfShortcutChord, 'codes' | 'shift'> = {},
): PdfShortcutChord => ({
  keys: Array.isArray(keys) ? keys : [keys],
  primary: true,
  display: ['$primary', ...(options.shift === true ? ['⇧'] : []), display],
  ...options,
})

const plainChord = (
  keys: string | string[],
  display: string | string[],
  options: Pick<PdfShortcutChord, 'codes' | 'shift'> = {},
): PdfShortcutChord => ({
  keys: Array.isArray(keys) ? keys : [keys],
  display: Array.isArray(display) ? display : [display],
  ...options,
})

const altChord = (key: string, display: string): PdfShortcutChord => ({
  keys: [key],
  alt: true,
  display: ['Alt', display],
})

/** Every app-owned PDF reader command has runtime matching and help metadata here. */
export const PDF_READER_SHORTCUTS: readonly PdfReaderShortcutDefinition[] = [
  { id: 'copy', chords: [primaryChord('c', 'C')], helpGroup: 'copy', helpLabelKey: 'paper.copy', isAvailable: alwaysAvailable },
  { id: 'print', chords: [primaryChord('p', 'P')], helpGroup: 'print', helpLabelKey: 'reader.print', isAvailable: alwaysAvailable },
  { id: 'saveAs', chords: [primaryChord('s', 'S'), primaryChord('s', 'S', { shift: true })], helpGroup: 'save', helpLabelKey: 'reader.saveAs', isAvailable: alwaysAvailable },
  { id: 'open', chords: [primaryChord('o', 'O')], helpGroup: 'open', helpLabelKey: 'reader.openPdf', isAvailable: alwaysAvailable },
  { id: 'search', chords: [primaryChord('f', 'F'), plainChord('/', '/')], helpGroup: 'search', helpLabelKey: 'reader.searchInBook', isAvailable: alwaysAvailable },
  { id: 'findNext', chords: [plainChord('F3', 'F3')], helpGroup: 'find-results', helpLabelKey: 'reader.shortcutFindResults', isAvailable: alwaysAvailable },
  { id: 'findPrevious', chords: [plainChord('F3', ['⇧', 'F3'], { shift: true })], helpGroup: 'find-results', helpLabelKey: 'reader.shortcutFindResults', isAvailable: alwaysAvailable },
  { id: 'historyBack', chords: [altChord('ArrowLeft', '←'), plainChord('Backspace', 'Backspace')], helpGroup: 'history', helpLabelKey: 'reader.shortcutHistory', isAvailable: alwaysAvailable },
  { id: 'historyForward', chords: [altChord('ArrowRight', '→'), plainChord('Backspace', ['⇧', 'Backspace'], { shift: true })], helpGroup: 'history', helpLabelKey: 'reader.shortcutHistory', isAvailable: alwaysAvailable },
  {
    id: 'zoomIn',
    chords: [
      primaryChord(['+', '='], '＋', { codes: ['Equal', 'NumpadAdd'], shift: 'any' }),
      plainChord(['+', '='], '＋', { codes: ['Equal', 'NumpadAdd'], shift: 'any' }),
    ],
    helpGroup: 'zoom-in',
    helpLabelKey: 'reader.shortcutZoomIn',
    isAvailable: alwaysAvailable,
  },
  {
    id: 'zoomOut',
    chords: [
      primaryChord(['-', '_'], '−', { codes: ['Minus', 'NumpadSubtract'], shift: 'any' }),
      plainChord(['-', '_'], '−', { codes: ['Minus', 'NumpadSubtract'], shift: 'any' }),
    ],
    helpGroup: 'zoom-out',
    helpLabelKey: 'reader.shortcutZoomOut',
    isAvailable: alwaysAvailable,
  },
  { id: 'zoomReset', chords: [primaryChord('0', '0')], helpGroup: 'zoom-reset', helpLabelKey: 'reader.shortcutResetZoom', isAvailable: alwaysAvailable },
  { id: 'actualSize', chords: [primaryChord('1', '1')], helpGroup: 'zoom-modes', helpLabelKey: 'reader.shortcutZoomModes', isAvailable: originalLayoutOnly },
  { id: 'fitWidth', chords: [primaryChord('2', '2')], helpGroup: 'zoom-modes', helpLabelKey: 'reader.shortcutZoomModes', isAvailable: originalLayoutOnly },
  { id: 'layoutSingle', chords: [primaryChord('6', '6')], helpGroup: 'page-layouts', helpLabelKey: 'reader.shortcutPageLayouts', isAvailable: bookOnly },
  { id: 'layoutFacing', chords: [primaryChord('7', '7')], helpGroup: 'page-layouts', helpLabelKey: 'reader.shortcutPageLayouts', isAvailable: bookOnly },
  { id: 'layoutBook', chords: [primaryChord('8', '8')], helpGroup: 'page-layouts', helpLabelKey: 'reader.shortcutPageLayouts', isAvailable: bookOnly },
  { id: 'focusPage', chords: [primaryChord('g', 'G'), plainChord('g', 'G', { shift: 'any' })], helpGroup: 'focus-page', helpLabelKey: 'reader.shortcutGoToPage', isAvailable: alwaysAvailable },
  { id: 'screenUp', chords: [primaryChord('ArrowUp', '↑')], helpGroup: 'screen-scroll', helpLabelKey: 'reader.shortcutScreenScroll', isAvailable: alwaysAvailable },
  { id: 'screenDown', chords: [primaryChord('ArrowDown', '↓')], helpGroup: 'screen-scroll', helpLabelKey: 'reader.shortcutScreenScroll', isAvailable: alwaysAvailable },
  { id: 'closePanels', chords: [plainChord('Escape', 'Esc')], helpGroup: 'close', helpLabelKey: 'reader.shortcutClose', isAvailable: alwaysAvailable },
  {
    id: 'toggleHelp',
    chords: [plainChord('?', '?', { shift: 'any' }), plainChord('/', '?', { codes: ['Slash'], shift: true })],
    helpGroup: 'help',
    helpLabelKey: 'reader.shortcutHelp',
    isAvailable: alwaysAvailable,
  },
  { id: 'toggleFullscreen', chords: [plainChord('f', 'F', { shift: 'any' }), plainChord('F11', 'F11')], helpGroup: 'fullscreen', helpLabelKey: 'reader.shortcutFullscreen', isAvailable: alwaysAvailable },
  { id: 'presentation', chords: [plainChord('F5', 'F5')], helpGroup: 'presentation', helpLabelKey: 'reader.shortcutPresentation', isAvailable: alwaysAvailable },
  { id: 'toggleToc', chords: [plainChord('F12', 'F12')], helpGroup: 'toc', helpLabelKey: 'reader.shortcutToc', isAvailable: alwaysAvailable },
  { id: 'cycleFit', chords: [plainChord('z', 'Z', { shift: 'any' })], helpGroup: 'cycle-fit', helpLabelKey: 'reader.shortcutCycleFit', isAvailable: originalLayoutOnly },
  { id: 'togglePageMode', chords: [plainChord('c', 'C', { shift: 'any' })], helpGroup: 'page-mode', helpLabelKey: 'reader.shortcutPageMode', isAvailable: originalBookOnly },
  { id: 'firstPage', chords: [plainChord('Home', 'Home')], helpGroup: 'first-last', helpLabelKey: 'reader.shortcutFirstLast', isAvailable: alwaysAvailable },
  { id: 'lastPage', chords: [plainChord('End', 'End')], helpGroup: 'first-last', helpLabelKey: 'reader.shortcutFirstLast', isAvailable: alwaysAvailable },
  { id: 'nextPage', chords: [plainChord('n', 'N', { shift: 'any' })], helpGroup: 'prev-next', helpLabelKey: 'reader.shortcutPrevNextPage', isAvailable: alwaysAvailable },
  { id: 'previousPage', chords: [plainChord('p', 'P', { shift: 'any' })], helpGroup: 'prev-next', helpLabelKey: 'reader.shortcutPrevNextPage', isAvailable: alwaysAvailable },
  { id: 'pageUp', chords: [plainChord('PageUp', 'Page Up'), plainChord(' ', ['⇧', 'Space'], { shift: true })], helpGroup: 'page-up', helpLabelKey: 'reader.shortcutPrevPage', isAvailable: alwaysAvailable },
  { id: 'pageDown', chords: [plainChord('PageDown', 'Page Down'), plainChord(' ', 'Space')], helpGroup: 'page-down', helpLabelKey: 'reader.shortcutNextPage', isAvailable: alwaysAvailable },
  { id: 'lineUp', chords: [plainChord('ArrowUp', '↑'), plainChord('k', 'K', { shift: 'any' })], helpGroup: 'line-scroll', helpLabelKey: 'reader.shortcutScroll', isAvailable: alwaysAvailable },
  { id: 'lineDown', chords: [plainChord('ArrowDown', '↓'), plainChord('j', 'J', { shift: 'any' })], helpGroup: 'line-scroll', helpLabelKey: 'reader.shortcutScroll', isAvailable: alwaysAvailable },
  { id: 'lineLeft', chords: [plainChord('ArrowLeft', '←'), plainChord('h', 'H', { shift: 'any' })], helpGroup: 'line-scroll', helpLabelKey: 'reader.shortcutScroll', isAvailable: alwaysAvailable },
  { id: 'lineRight', chords: [plainChord('ArrowRight', '→'), plainChord('l', 'L', { shift: 'any' })], helpGroup: 'line-scroll', helpLabelKey: 'reader.shortcutScroll', isAvailable: alwaysAvailable },
]

/** macOS 只认 Command，Windows/Linux 只认 Ctrl，避免组合修饰键误触。 */
function hasPlatformPrimaryModifier(event: KeyboardShortcutEvent, isMacPlatform: boolean): boolean {
  return isMacPlatform
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

function matchesChord(
  event: KeyboardShortcutEvent,
  chord: PdfShortcutChord,
  isMacPlatform: boolean,
  matchBy: 'key' | 'code',
): boolean {
  if (chord.primary) {
    if (!hasPlatformPrimaryModifier(event, isMacPlatform)) return false
  } else if (event.ctrlKey || event.metaKey) {
    return false
  }
  if (Boolean(chord.alt) !== event.altKey) return false
  if (chord.shift !== 'any' && Boolean(chord.shift) !== event.shiftKey) return false
  if (matchBy === 'key') {
    return chord.keys.some(key => key.toLowerCase() === event.key.toLowerCase())
  }
  return Boolean(event.code && chord.codes?.includes(event.code))
}

export function resolvePdfReaderShortcut(
  event: KeyboardShortcutEvent,
  isMacPlatform: boolean,
  state: PdfReaderShortcutState,
): PdfReaderShortcutCommandId | null {
  // Prefer the character produced by the active keyboard layout. Physical-code
  // fallbacks are only consulted when no exact key chord matches anywhere.
  for (const matchBy of ['key', 'code'] as const) {
    for (const command of PDF_READER_SHORTCUTS) {
      if (!command.isAvailable(state)) continue
      if (command.chords.some(chord => matchesChord(event, chord, isMacPlatform, matchBy))) return command.id
    }
  }
  return null
}

export function getPdfShortcutHelpRows(
  state: PdfReaderShortcutState,
  isMacPlatform: boolean,
): PdfShortcutHelpRow[] {
  const primaryLabel = isMacPlatform ? '⌘' : 'Ctrl'
  const groups = new Map<string, PdfShortcutHelpRow>()
  for (const command of PDF_READER_SHORTCUTS) {
    if (!command.isAvailable(state)) continue
    const row = groups.get(command.helpGroup) ?? {
      id: command.helpGroup,
      commandIds: [],
      shortcuts: [],
      labelKey: command.helpLabelKey,
    }
    row.commandIds.push(command.id)
    for (const chord of command.chords) {
      const display = chord.display.map(key => key === '$primary' ? primaryLabel : key)
      if (!row.shortcuts.some(existing => existing.join('\u0000') === display.join('\u0000'))) {
        row.shortcuts.push(display)
      }
    }
    groups.set(command.helpGroup, row)
  }
  return [...groups.values()]
}

interface PdfReaderShortcutEvent extends KeyboardShortcutEvent {
  repeat?: boolean
  preventDefault: () => void
}

interface PdfReaderShortcutContext {
  state: PdfReaderShortcutState
  isEditableTarget: () => boolean
  canHandleCommand?: (command: PdfReaderShortcutCommandId) => boolean
  runCommand: (command: PdfReaderShortcutCommandId) => void
}

/** Recognizes first, then performs lazy target/selection probes and one shared repeat gate. */
export function dispatchPdfReaderShortcut(
  event: PdfReaderShortcutEvent,
  isMacPlatform: boolean,
  context: PdfReaderShortcutContext,
): boolean {
  const command = resolvePdfReaderShortcut(event, isMacPlatform, context.state)
  if (!command) return false
  if (context.isEditableTarget()) return false
  if (context.canHandleCommand && !context.canHandleCommand(command)) return false
  event.preventDefault()
  if (!event.repeat) context.runCommand(command)
  return true
}

/** An older asynchronous copy must not dismiss a newer custom selection. */
export function shouldClearCopiedSelection<T extends object>(current: T | null | undefined, copied: T): boolean {
  return current === copied
}
