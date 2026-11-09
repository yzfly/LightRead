/*
 * Forked from foliate-js 1.0.1 `paginator.js` (https://github.com/johnfactotum/foliate-js).
 *
 * MIT License
 *
 * Copyright (c) 2022 John Factotum
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * LightRead changes (see docs/continuous-scroll.md):
 *  - Cross-section continuous scrolling: with `flow="scrolled"` and the `continuous`
 *    attribute, sections are stacked as slots in one scroll container, neighbours are
 *    preloaded ahead of time and every height change above the viewport is compensated
 *    in the same frame. Paginated mode and plain scrolled mode are unchanged.
 *  - The fixes vite.legacy.ts used to patch into the upstream file are applied here
 *    directly (no regex lookbehind; guards for documents emptied during unload).
 *  - View.expand() ignores documents that are already gone.
 * Vite resolves `foliate-js/view.js`'s `./paginator.js` to this file (vite.config.ts).
 */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const requestIdle = globalThis.requestIdleCallback
    ? (cb, opts) => globalThis.requestIdleCallback(cb, opts)
    : cb => setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 32)
const cancelIdle = globalThis.cancelIdleCallback
    ? id => globalThis.cancelIdleCallback(id)
    : id => clearTimeout(id)

// continuous scrolling (multi-slot) tuning, see docs/continuous-scroll.md §3–§5
const CONT_READING_LINE = 0.2 // reading line, fraction of the viewport from the top
const CONT_HYSTERESIS = 8 // px past a section boundary before the primary section switches
const CONT_MAX_SLOTS = 5 // soft limit, trimmed when far away
const CONT_PRELOAD_MAX_SLOTS = 7 // non-urgent preloads stop here (unloads aim back at 5 when idle)
const CONT_HARD_MAX_SLOTS = 10 // never load beyond this (urgent loads may exceed the soft limit)
const CONT_IDLE_MS = 150 // recent scrolling: defer non-urgent preloads to an idle callback
// true idle (§12): no touch, no user scroll / touchend for this long, velocity ≈ 0 and scrollTop
// steady across two frames. Only then may anything above the viewport change.
const CONT_TRUE_IDLE_MS = 400
const CONT_RECENT_MS = 10000 // a section loaded this recently is not unloaded at idle
const CONT_SEEN_MS = 2000 // nor one that was on screen this recently
const CONT_UNLOAD_GAP_MS = 1000 // at most one unload per idle period
const CONT_RELOCATE_MS = 250 // relocate throttle while scrolling
const CONT_LONG_SECTION_SCREENS = 20 // keep only one neighbour on each side beyond this
const CONT_PENDING_STYLE = {
    position: 'absolute', bottom: '100%', left: '0', right: '0', visibility: 'hidden',
}

// first rect of a range (or element) that has a height
const firstRect = target => {
    try {
        for (const rect of target.getClientRects()) if (rect.height > 0) return rect
        const rect = target.getBoundingClientRect()
        if (rect.height > 0) return rect
    } catch { /* detached */ }
    return null
}

const sameStyles = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((x, i) => x === b[i]))

const caretRangeAt = (doc, x, y) => {
    try {
        if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y)
        const pos = doc.caretPositionFromPoint?.(x, y)
        if (pos?.offsetNode) {
            const range = doc.createRange()
            range.setStart(pos.offsetNode, pos.offset)
            return range
        }
    } catch { /* ignore */ }
    return null
}

const debounce = (f, wait, immediate) => {
    let timeout
    return (...args) => {
        const later = () => {
            timeout = null
            if (!immediate) f(...args)
        }
        const callNow = immediate && !timeout
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) f(...args)
    }
}

const lerp = (min, max, x) => x * (max - min) + min
const easeOutQuad = x => 1 - (1 - x) * (1 - x)
const animate = (a, b, duration, ease, render) => new Promise(resolve => {
    let start
    const step = now => {
        start ??= now
        const fraction = Math.min(1, (now - start) / duration)
        render(lerp(a, b, ease(fraction)))
        if (fraction < 1) requestAnimationFrame(step)
        else resolve()
    }
    requestAnimationFrame(step)
})
// LightRead (reading focus): a scroll animation that yields — it stops (resolves false) as soon
// as `stop()` says so or someone else (the reader's wheel / finger) moved the position
const easeInOutQuad = x => x < .5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2
const glide = (from, to, duration, ease, read, write, stop) => new Promise(resolve => {
    let start
    let last = read()
    const step = now => {
        if (stop?.() || Math.abs(read() - last) > 2) return resolve(false)
        start ??= now
        const fraction = Math.min(1, (now - start) / Math.max(1, duration))
        write(lerp(from, to, ease(fraction)))
        last = read()
        if (fraction < 1) requestAnimationFrame(step)
        else resolve(true)
    }
    requestAnimationFrame(step)
})
const docOf = target => {
    const node = target?.startContainer ?? target
    return node?.nodeType === 9 ? node : node?.ownerDocument ?? null
}

// collapsed range doesn't return client rects sometimes (or always?)
// try make get a non-collapsed range or element
const uncollapse = range => {
    if (!range?.collapsed) return range
    const { endOffset, endContainer } = range
    if (endContainer.nodeType === 1) {
        const node = endContainer.childNodes[endOffset]
        if (node?.nodeType === 1) return node
        return endContainer
    }
    if (endOffset + 1 < endContainer.length) range.setEnd(endContainer, endOffset + 1)
    else if (endOffset > 1) range.setStart(endContainer, endOffset - 1)
    else return endContainer.parentNode
    return range
}

const makeRange = (doc, node, start, end = start) => {
    const range = doc.createRange()
    range.setStart(node, start)
    range.setEnd(node, end)
    return range
}

// use binary search to find an offset value in a text node
const bisectNode = (doc, node, cb, start = 0, end = node.nodeValue.length) => {
    if (end - start === 1) {
        const result = cb(makeRange(doc, node, start), makeRange(doc, node, end))
        return result < 0 ? start : end
    }
    const mid = Math.floor(start + (end - start) / 2)
    const result = cb(makeRange(doc, node, start, mid), makeRange(doc, node, mid, end))
    return result < 0 ? bisectNode(doc, node, cb, start, mid)
        : result > 0 ? bisectNode(doc, node, cb, mid, end) : mid
}

const { SHOW_ELEMENT, SHOW_TEXT, SHOW_CDATA_SECTION,
    FILTER_ACCEPT, FILTER_REJECT, FILTER_SKIP } = NodeFilter

const filter = SHOW_ELEMENT | SHOW_TEXT | SHOW_CDATA_SECTION

// needed cause there seems to be a bug in `getBoundingClientRect()` in Firefox
// where it fails to include rects that have zero width and non-zero height
// (CSSOM spec says "rectangles [...] of which the height or width is not zero")
// which makes the visible range include an extra space at column boundaries
const getBoundingClientRect = target => {
    let top = Infinity, right = -Infinity, left = Infinity, bottom = -Infinity
    for (const rect of target.getClientRects()) {
        left = Math.min(left, rect.left)
        top = Math.min(top, rect.top)
        right = Math.max(right, rect.right)
        bottom = Math.max(bottom, rect.bottom)
    }
    return new DOMRect(left, top, right - left, bottom - top)
}

const getVisibleRange = (doc, start, end, mapRect) => {
    // first get all visible nodes
    const acceptNode = node => {
        const name = node.localName?.toLowerCase()
        // ignore all scripts, styles, and their children
        if (name === 'script' || name === 'style') return FILTER_REJECT
        if (node.nodeType === 1) {
            const { left, right } = mapRect(node.getBoundingClientRect())
            // no need to check child nodes if it's completely out of view
            if (right < start || left > end) return FILTER_REJECT
            // elements must be completely in view to be considered visible
            // because you can't specify offsets for elements
            if (left >= start && right <= end) return FILTER_ACCEPT
            // TODO: it should probably allow elements that do not contain text
            // because they can exceed the whole viewport in both directions
            // especially in scrolled mode
        } else {
            // ignore empty text nodes
            if (!node.nodeValue?.trim()) return FILTER_SKIP
            // create range to get rect
            const range = doc.createRange()
            range.selectNodeContents(node)
            const { left, right } = mapRect(range.getBoundingClientRect())
            // it's visible if any part of it is in view
            if (right >= start && left <= end) return FILTER_ACCEPT
        }
        return FILTER_SKIP
    }
    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })
    const nodes = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        nodes.push(node)

    // we're only interested in the first and last visible nodes
    const from = nodes[0] ?? doc.body
    const to = nodes[nodes.length - 1] ?? from

    // find the offset at which visibility changes
    const startOffset = from.nodeType === 1 ? 0
        : bisectNode(doc, from, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < start && q.left > start) return 0
            return q.left > start ? -1 : 1
        })
    const endOffset = to.nodeType === 1 ? 0
        : bisectNode(doc, to, (a, b) => {
            const p = mapRect(getBoundingClientRect(a))
            const q = mapRect(getBoundingClientRect(b))
            if (p.right < end && q.left > end) return 0
            return q.left > end ? -1 : 1
        })

    const range = doc.createRange()
    range.setStart(from, startOffset)
    range.setEnd(to, endOffset)
    return range
}

const selectionIsBackward = sel => {
    const range = document.createRange()
    range.setStart(sel.anchorNode, sel.anchorOffset)
    range.setEnd(sel.focusNode, sel.focusOffset)
    return range.collapsed
}

const setSelectionTo = (target, collapse) => {
    let range
    if (target.startContainer) range = target.cloneRange()
    else if (target.nodeType) {
        range = document.createRange()
        range.selectNode(target)
    }
    if (range) {
        const sel = range.startContainer.ownerDocument.defaultView.getSelection()
        sel.removeAllRanges()
        if (collapse === -1) range.collapse(true)
        else if (collapse === 1) range.collapse()
        sel.addRange(range)
    }
}

const getDirection = doc => {
    const { defaultView } = doc
    const { writingMode, direction } = defaultView.getComputedStyle(doc.body)
    const vertical = writingMode === 'vertical-rl'
        || writingMode === 'vertical-lr'
    const rtl = doc.body.dir === 'rtl'
        || direction === 'rtl'
        || doc.documentElement.dir === 'rtl'
    return { vertical, rtl }
}

const getBackground = doc => {
    const bodyStyle = doc.defaultView.getComputedStyle(doc.body)
    return bodyStyle.backgroundColor === 'rgba(0, 0, 0, 0)'
        && bodyStyle.backgroundImage === 'none'
        ? doc.defaultView.getComputedStyle(doc.documentElement).background
        : bodyStyle.background
}

const makeMarginals = (length, part) => Array.from({ length }, () => {
    const div = document.createElement('div')
    const child = document.createElement('div')
    div.append(child)
    child.setAttribute('part', part)
    return div
})

const setStylesImportant = (el, styles) => {
    const { style } = el
    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')
}

class View {
    #observer = new ResizeObserver(() => this.expand())
    #element = document.createElement('div')
    #iframe = document.createElement('iframe')
    #contentRange = document.createRange()
    #overlayer
    #vertical = false
    #rtl = false
    #column = true
    #size
    #layout = {}
    constructor({ container, onExpand }) {
        this.container = container
        this.onExpand = onExpand
        this.#iframe.setAttribute('part', 'filter')
        this.#element.append(this.#iframe)
        Object.assign(this.#element.style, {
            boxSizing: 'content-box',
            position: 'relative',
            overflow: 'hidden',
            flex: '0 0 auto',
            width: '100%', height: '100%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
        })
        Object.assign(this.#iframe.style, {
            overflow: 'hidden',
            border: '0',
            display: 'none',
            width: '100%', height: '100%',
        })
        // `allow-scripts` is needed for events because of WebKit bug
        // https://bugs.webkit.org/show_bug.cgi?id=218086
        this.#iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts')
        this.#iframe.setAttribute('scrolling', 'no')
    }
    get element() {
        return this.#element
    }
    get document() {
        return this.#iframe.contentDocument
    }
    async load(src, afterLoad, beforeRender) {
        if (typeof src !== 'string') throw new Error(`${src} is not string`)
        return new Promise(resolve => {
            this.#iframe.addEventListener('load', () => {
                const doc = this.document
                afterLoad?.(doc)

                // it needs to be visible for Firefox to get computed style
                this.#iframe.style.display = 'block'
                const { vertical, rtl } = getDirection(doc)
                this.docBackground = getBackground(doc)
                doc.body.style.background = 'none'
                const background = this.docBackground
                this.#iframe.style.display = 'none'

                this.#vertical = vertical
                this.#rtl = rtl

                this.#contentRange.selectNodeContents(doc.body)
                const layout = beforeRender?.({ vertical, rtl, background })
                this.#iframe.style.display = 'block'
                this.render(layout)
                this.#observer.observe(doc.body)

                // the resize observer above doesn't work in Firefox
                // (see https://bugzilla.mozilla.org/show_bug.cgi?id=1832939)
                // until the bug is fixed we can at least account for font load
                doc.fonts.ready.then(() => this.expand())

                resolve()
            }, { once: true })
            this.#iframe.src = src
        })
    }
    render(layout) {
        // LightRead: the document may be emptied while a section is being unloaded
        if (!layout || !this.document?.documentElement || !this.document.body) return
        this.#column = layout.flow !== 'scrolled'
        this.#layout = layout
        if (this.#column) this.columnize(layout)
        else this.scrolled(layout)
    }
    scrolled({ margin, gap, columnWidth }) {
        const vertical = this.#vertical
        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'padding': vertical ? `${margin*1.5}px ${gap}px` : `0 ${gap}px`,
            'column-width': 'auto',
            'height': 'auto',
            'width': 'auto',
        })
        setStylesImportant(doc.body, {
            [vertical ? 'max-height' : 'max-width']: `${columnWidth}px`,
            'margin': 'auto',
        })
        this.setImageSize()
        this.expand()
    }
    columnize({ width, height, margin, gap, columnWidth }) {
        const vertical = this.#vertical
        this.#size = vertical ? height : width

        const doc = this.document
        setStylesImportant(doc.documentElement, {
            'box-sizing': 'border-box',
            'column-width': `${Math.trunc(columnWidth)}px`,
            'column-gap': vertical ? `${margin}px` : `${gap}px`,
            'column-fill': 'auto',
            ...(vertical
                ? { 'width': `${width}px` }
                : { 'height': `${height}px` }),
            'padding': vertical ? `${margin / 2}px ${gap}px` : `0 ${gap / 2}px`,
            'overflow': 'hidden',
            // force wrap long words
            'overflow-wrap': 'break-word',
            // reset some potentially problematic props
            'position': 'static', 'border': '0', 'margin': '0',
            'max-height': 'none', 'max-width': 'none',
            'min-height': 'none', 'min-width': 'none',
            // fix glyph clipping in WebKit
            '-webkit-line-box-contain': 'block glyphs replaced',
        })
        setStylesImportant(doc.body, {
            'max-height': 'none',
            'max-width': 'none',
            'margin': '0',
        })
        this.setImageSize()
        this.expand()
    }
    setImageSize() {
        const { width, height, margin } = this.#layout
        const vertical = this.#vertical
        const doc = this.document
        for (const el of doc.body.querySelectorAll('img, svg, video')) {
            // preserve max size if they are already set
            const { maxHeight, maxWidth } = doc.defaultView.getComputedStyle(el)
            setStylesImportant(el, {
                'max-height': vertical
                    ? (maxHeight !== 'none' && maxHeight !== '0px' ? maxHeight : '100%')
                    : `${height - margin * 2}px`,
                'max-width': vertical
                    ? `${width - margin * 2}px`
                    : (maxWidth !== 'none' && maxWidth !== '0px' ? maxWidth : '100%'),
                'object-fit': 'contain',
                'page-break-inside': 'avoid',
                'break-inside': 'avoid',
                'box-sizing': 'border-box',
            })
        }
    }
    expand() {
        // LightRead: late font / resize callbacks after the iframe was removed
        if (!this.document?.documentElement) return
        const { documentElement } = this.document
        if (this.#column) {
            const side = this.#vertical ? 'height' : 'width'
            const otherSide = this.#vertical ? 'width' : 'height'
            const contentRect = this.#contentRange.getBoundingClientRect()
            const rootRect = documentElement.getBoundingClientRect()
            // offset caused by column break at the start of the page
            // which seem to be supported only by WebKit and only for horizontal writing
            const contentStart = this.#vertical ? 0
                : this.#rtl ? rootRect.right - contentRect.right : contentRect.left - rootRect.left
            const contentSize = contentStart + contentRect[side]
            const pageCount = Math.ceil(contentSize / this.#size)
            const expandedSize = pageCount * this.#size
            this.#element.style.padding = '0'
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize + this.#size * 2}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            documentElement.style[side] = `${this.#size}px`
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = '0'
                this.#overlayer.element.style.left = this.#vertical ? '0' : `${this.#size}px`
                this.#overlayer.element.style.top = this.#vertical ? `${this.#size}px` : '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        } else {
            const side = this.#vertical ? 'width' : 'height'
            const otherSide = this.#vertical ? 'height' : 'width'
            const contentSize = documentElement.getBoundingClientRect()[side]
            const expandedSize = contentSize
            const { margin, gap } = this.#layout
            const padding = this.#vertical ? `0 ${gap}px` : `${margin}px 0`
            this.#element.style.padding = padding
            this.#iframe.style[side] = `${expandedSize}px`
            this.#element.style[side] = `${expandedSize}px`
            this.#iframe.style[otherSide] = '100%'
            this.#element.style[otherSide] = '100%'
            if (this.#overlayer) {
                this.#overlayer.element.style.margin = padding
                this.#overlayer.element.style.left = '0'
                this.#overlayer.element.style.top = '0'
                this.#overlayer.element.style[side] = `${expandedSize}px`
                this.#overlayer.redraw()
            }
        }
        this.onExpand()
    }
    set overlayer(overlayer) {
        this.#overlayer = overlayer
        this.#element.append(overlayer.element)
    }
    get overlayer() {
        return this.#overlayer
    }
    destroy() {
        if (this.document) this.#observer.unobserve(this.document.body)
    }
}

// NOTE: everything here assumes the so-called "negative scroll type" for RTL
export class Paginator extends HTMLElement {
    static observedAttributes = [
        'flow', 'gap', 'margin',
        'max-inline-size', 'max-block-size', 'max-column-count',
        'continuous', 'column-count', // LightRead: auto / fixed columns
    ]
    // LightRead: marker so the build can be checked for the fork (scripts / grep dist)
    static lightreadFork = 'lightread-continuous-paginator/1'
    #root = this.attachShadow({ mode: 'closed' })
    #observer = new ResizeObserver(() => this.render())
    #top
    #background
    #container
    #header
    #footer
    #view
    #vertical = false
    #rtl = false
    #margin = 0
    #index = -1
    #anchor = 0 // anchor view to a fraction (0-1), Range, or Element
    #anchorAt = null // LightRead: px from the viewport top where a Range / element anchor sits (null = margin)
    #glideToken = 0 // LightRead: bumped by every scrollToRange; a newer one cancels a running glide
    #justAnchored = false
    #locked = false // while true, prevent any further navigation
    #styles
    #styleMap = new WeakMap()
    #mediaQuery = matchMedia('(prefers-color-scheme: dark)')
    #mediaQueryListener
    #scrollBounds
    #touchState
    #touchScrolled
    #lastVisibleRange
    // ---- LightRead: continuous (multi-slot) scrolling state ----
    #mode = 'single' // 'single' = upstream behaviour, 'cont' = stacked slots
    #contBlocked = false // a vertical-writing section was found: stay single
    #failed = new Set() // sections that failed to load, skipped when stacking
    #busy = null // in-flight display; mode switches wait for it
    #slots = [] // { index, view, iframe, ready, committed, dead, promise, ... } in index order
    #primary = null // slot under the reading line
    #primaryLock = null // slot pinned by navigation until the user scrolls
    #cAnchor = null // { slot, range, y, offset } — what must stay put on relayout
    #lastST = 0 // last scrollTop seen or written by us
    #lastScrollEventAt = 0
    #lastUserScrollAt = -Infinity
    #velocity = 0 // px/ms, EMA of user scrolling (positive = down)
    #loadMs = 400 // EMA of section load + layout time
    #touching = false
    #lastTouchEndAt = -Infinity
    #ownScroll = 0 // sum of our own scrollTop writes (to tell them from a running fling)
    #lastUnloadAt = -Infinity
    #retryTimer = null
    #animating = false
    #loadingSlot = null
    #idleHandle = null
    #frameHandle = null
    #maintainTimer = null
    #relocTimer = null
    constructor() {
        super()
        this.#root.innerHTML = `<style>
        :host {
            display: block;
            container-type: size;
        }
        :host, #top {
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }
        #top {
            --_gap: 7%;
            --_margin: 48px;
            --_max-inline-size: 720px;
            --_max-block-size: 1440px;
            --_max-column-count: 2;
            --_max-column-count-portrait: 1;
            --_max-column-count-spread: var(--_max-column-count);
            --_half-gap: calc(var(--_gap) / 2);
            --_max-width: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            --_max-height: var(--_max-block-size);
            display: grid;
            grid-template-columns:
                minmax(var(--_half-gap), 1fr)
                var(--_half-gap)
                minmax(0, calc(var(--_max-width) - var(--_gap)))
                var(--_half-gap)
                minmax(var(--_half-gap), 1fr);
            grid-template-rows:
                minmax(var(--_margin), 1fr)
                minmax(0, var(--_max-height))
                minmax(var(--_margin), 1fr);
            &.vertical {
                --_max-column-count-spread: var(--_max-column-count-portrait);
                --_max-width: var(--_max-block-size);
                --_max-height: calc(var(--_max-inline-size) * var(--_max-column-count-spread));
            }
            @container (orientation: portrait) {
                & {
                    --_max-column-count-spread: var(--_max-column-count-portrait);
                }
                &.vertical {
                    --_max-column-count-spread: var(--_max-column-count);
                }
            }
        }
        #background {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
        }
        #container {
            grid-column: 2 / 5;
            grid-row: 2;
            overflow: hidden;
        }
        :host([flow="scrolled"]) #container {
            grid-column: 1 / -1;
            grid-row: 1 / -1;
            overflow: auto;
        }
        #container.continuous {
            position: relative;
            overflow-anchor: none;
        }
        #header {
            grid-column: 3 / 4;
            grid-row: 1;
        }
        #footer {
            grid-column: 3 / 4;
            grid-row: 3;
            align-self: end;
        }
        #header, #footer {
            display: grid;
            height: var(--_margin);
        }
        :is(#header, #footer) > * {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        :is(#header, #footer) > * > * {
            width: 100%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            text-align: center;
            font-size: .75em;
            opacity: .6;
        }
        </style>
        <div id="top">
            <div id="background" part="filter"></div>
            <div id="header"></div>
            <div id="container" part="container"></div>
            <div id="footer"></div>
        </div>
        `

        this.#top = this.#root.getElementById('top')
        this.#background = this.#root.getElementById('background')
        this.#container = this.#root.getElementById('container')
        this.#header = this.#root.getElementById('header')
        this.#footer = this.#root.getElementById('footer')

        this.#observer.observe(this.#container)
        this.#container.addEventListener('scroll', () => {
            // LightRead: someone else scrolled (the reader, navigation, compensation): drop the remainder
            if (this.#drift && this.#container.scrollTop !== this.#drift.whole) this.#dropDrift()
        })
        this.#container.addEventListener('scroll', () => this.dispatchEvent(new Event('scroll')))
        this.#container.addEventListener('scroll', () => {
            if (this.#mode === 'cont') this.#contOnScroll()
        })
        this.#container.addEventListener('scroll', debounce(() => {
            if (this.scrolled && this.#mode !== 'cont') {
                if (this.#justAnchored) this.#justAnchored = false
                else this.#afterScroll('scroll')
            }
        }, 250))

        const opts = { passive: false }
        this.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
        this.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
        this.addEventListener('touchend', this.#onTouchEnd.bind(this))
        this.addEventListener('load', ({ detail: { doc } }) => {
            doc.addEventListener('touchstart', this.#onTouchStart.bind(this), opts)
            doc.addEventListener('touchmove', this.#onTouchMove.bind(this), opts)
            doc.addEventListener('touchend', this.#onTouchEnd.bind(this))
        })
        // LightRead: continuous mode needs to know whether a finger is down
        const trackTouch = e => {
            this.#touching = e.type === 'touchstart' || e.touches.length > 0
            // a transformed scroller may lose compositor scrolling: whole pixels before the finger moves
            if (e.type === 'touchstart') this.driftEnd()
            if (!this.#touching) this.#lastTouchEndAt = performance.now()
            // a swipe at the end of the loaded content scrolls nothing: still check the preload
            else if (this.#mode === 'cont') this.#contScheduleFrame()
            if (!this.#touching && this.#mode === 'cont') this.#contScheduleMaintain()
        }
        const passive = { passive: true }
        for (const type of ['touchstart', 'touchend', 'touchcancel'])
            this.addEventListener(type, trackTouch, passive)
        this.addEventListener('load', ({ detail: { doc } }) => {
            for (const type of ['touchstart', 'touchend', 'touchcancel'])
                doc.addEventListener(type, trackTouch, passive)
        })

        this.addEventListener('relocate', ({ detail }) => {
            if (detail.reason === 'selection') setSelectionTo(this.#anchor, 0)
            else if (detail.reason === 'navigation') {
                if (this.#anchor === 1) setSelectionTo(detail.range, 1)
                else if (typeof this.#anchor === 'number')
                    setSelectionTo(detail.range, -1)
                else setSelectionTo(this.#anchor, -1)
            }
        })
        const checkPointerSelection = debounce((range, sel) => {
            if (!sel.rangeCount) return
            const selRange = sel.getRangeAt(0)
            const backward = selectionIsBackward(sel)
            if (backward && selRange.compareBoundaryPoints(Range.START_TO_START, range) < 0)
                this.prev()
            else if (!backward && selRange.compareBoundaryPoints(Range.END_TO_END, range) > 0)
                this.next()
        }, 700)
        this.addEventListener('load', ({ detail: { doc } }) => {
            let isPointerSelecting = false
            doc.addEventListener('pointerdown', () => isPointerSelecting = true)
            doc.addEventListener('pointerup', () => isPointerSelecting = false)
            let isKeyboardSelecting = false
            doc.addEventListener('keydown', () => isKeyboardSelecting = true)
            doc.addEventListener('keyup', () => isKeyboardSelecting = false)
            doc.addEventListener('selectionchange', () => {
                if (this.scrolled) return
                const range = this.#lastVisibleRange
                if (!range) return
                const sel = doc.getSelection()
                if (!sel.rangeCount) return
                if (isPointerSelecting && sel.type === 'Range')
                    checkPointerSelection(range, sel)
                else if (isKeyboardSelecting) {
                    const selRange = sel.getRangeAt(0).cloneRange()
                    const backward = selectionIsBackward(sel)
                    if (!backward) selRange.collapse()
                    this.#scrollToAnchor(selRange)
                }
            })
            doc.addEventListener('focusin', e => this.scrolled ? null :
                // NOTE: `requestAnimationFrame` is needed in WebKit
                requestAnimationFrame(() => this.#scrollToAnchor(e.target)))
        })

        this.#mediaQueryListener = () => {
            if (!this.#view) return
            this.#replaceBackground(this.#view.docBackground, this.columnCount)
        }
        this.#mediaQuery.addEventListener('change', this.#mediaQueryListener)
    }
    attributeChangedCallback(name, _, value) {
        switch (name) {
            case 'flow':
                this.#dropDrift() // LightRead: no sub-pixel remainder outside the scrolled flow
                // LightRead: leave continuous mode while the slots are still laid out
                // as scrolled, so the reading position can be measured
                if (this.#mode === 'cont' && !this.#wantCont() && !this.#busy) {
                    this.#exitCont()
                    this.render()
                } else {
                    this.render()
                    this.#syncMode()
                }
                break
            case 'continuous':
                this.#syncMode()
                break
            case 'column-count':
                // Fixed columns also apply in portrait when portrait scrolling is off.
                this.#top.style.setProperty('--_max-column-count-portrait', value === '2' ? '2' : '1')
                this.render()
                break
            case 'gap':
            case 'margin':
            case 'max-block-size':
            case 'max-column-count':
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
            case 'max-inline-size':
                // needs explicit `render()` as it doesn't necessarily resize
                this.#top.style.setProperty('--_' + name, value)
                this.render()
                break
        }
    }
    open(book) {
        this.bookDir = book.dir
        this.sections = book.sections
        this.#contBlocked = false
        this.#failed = new Set()
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            if (detail.type !== 'text/css') return
            const w = innerWidth
            const h = innerHeight
            detail.data = Promise.resolve(detail.data).then(data => data
                // unprefix as most of the props are (only) supported unprefixed
                // LightRead: no lookbehind (Safari < 16.4), same result
                .replace(/([{\s;])-epub-/gi, '$1')
                // replace vw and vh as they cause problems with layout
                .replace(/(\d*\.?\d+)vw/gi, (_, d) => parseFloat(d) * w / 100 + 'px')
                .replace(/(\d*\.?\d+)vh/gi, (_, d) => parseFloat(d) * h / 100 + 'px')
                // `page-break-*` unsupported in columns; replace with `column-break-*`
                .replace(/page-break-(after|before|inside)\s*:/gi, (_, x) =>
                    `-webkit-column-break-${x}:`)
                .replace(/break-(after|before|inside)\s*:\s*(avoid-)?page/gi, (_, x, y) =>
                    `break-${x}: ${y ?? ''}column`))
        })
    }
    #createView() {
        if (this.#view) {
            this.#view.destroy()
            this.#container.removeChild(this.#view.element)
        }
        this.#view = new View({
            container: this,
            onExpand: () => this.#scrollToAnchor(this.#anchor),
        })
        this.#container.append(this.#view.element)
        return this.#view
    }
    #replaceBackground(background, columnCount) {
        const doc = this.#view?.document
        if (!doc) return
        const htmlStyle = doc.defaultView.getComputedStyle(doc.documentElement)
        const themeBgColor = htmlStyle.getPropertyValue('--theme-bg-color')
        if (background && themeBgColor) {
            const parsedBackground = background.split(/\s(?=(?:url|rgb|hsl|#[0-9a-fA-F]{3,6}))/)
            parsedBackground[0] = themeBgColor
            background = parsedBackground.join(' ')
        }
        if (/cover.*fixed|fixed.*cover/.test(background)) {
            background = background.replace('cover', 'auto 100%').replace('fixed', '')
        }
        this.#background.innerHTML = ''
        this.#background.style.display = 'grid'
        this.#background.style.gridTemplateColumns = `repeat(${columnCount}, 1fr)`
        for (let i = 0; i < columnCount; i++) {
            const column = document.createElement('div')
            column.style.background = background
            column.style.width = '100%'
            column.style.height = '100%'
            this.#background.appendChild(column)
        }
    }
    #beforeRender({ vertical, rtl, background }) {
        this.#vertical = vertical
        this.#rtl = rtl
        this.#top.classList.toggle('vertical', vertical)

        const { width, height } = this.#container.getBoundingClientRect()
        const size = vertical ? height : width

        const style = getComputedStyle(this.#top)
        const maxInlineSize = parseFloat(style.getPropertyValue('--_max-inline-size'))
        const maxColumnCount = parseInt(style.getPropertyValue('--_max-column-count-spread'))
        const margin = parseFloat(style.getPropertyValue('--_margin'))
        this.#margin = margin

        const g = parseFloat(style.getPropertyValue('--_gap')) / 100
        // The gap will be a percentage of the #container, not the whole view.
        // This means the outer padding will be bigger than the column gap. Let
        // `a` be the gap percentage. The actual percentage for the column gap
        // will be (1 - a) * a. Let us call this `b`.
        //
        // To make them the same, we start by shrinking the outer padding
        // setting to `b`, but keep the column gap setting the same at `a`. Then
        // the actual size for the column gap will be (1 - b) * a. Repeating the
        // process again and again, we get the sequence
        //     x₁ = (1 - b) * a
        //     x₂ = (1 - x₁) * a
        //     ...
        // which converges to x = (1 - x) * a. Solving for x, x = a / (1 + a).
        // So to make the spacing even, we must shrink the outer padding with
        //     f(x) = x / (1 + x).
        // But we want to keep the outer padding, and make the inner gap bigger.
        // So we apply the inverse, f⁻¹ = -x / (x - 1) to the column gap.
        const gap = -g / (g - 1) * size

        const flow = this.getAttribute('flow')
        if (flow === 'scrolled') {
            // FIXME: vertical-rl only, not -lr
            this.setAttribute('dir', vertical ? 'rtl' : 'ltr')
            this.#top.style.padding = '0'
            const columnWidth = maxInlineSize

            this.heads = null
            this.feet = null
            this.#header.replaceChildren()
            this.#footer.replaceChildren()

            return { flow, margin, gap, columnWidth }
        }

        const fixedColumns = Number(this.getAttribute('column-count'))
        const divisor = fixedColumns === 1 || fixedColumns === 2
            ? fixedColumns
            : Math.min(maxColumnCount, Math.max(1, Math.ceil(size / maxInlineSize)))
        const columnWidth = vertical ? (size / divisor - margin) : (size / divisor - gap)
        this.setAttribute('dir', rtl ? 'rtl' : 'ltr')

        // set background to `doc` background
        // this is needed because the iframe does not fill the whole element
        this.columnCount = divisor
        this.#replaceBackground(background, this.columnCount)

        const marginalDivisor = vertical
            ? Math.min(2, Math.ceil(width / maxInlineSize))
            : divisor
        const marginalStyle = {
            gridTemplateColumns: `repeat(${marginalDivisor}, 1fr)`,
            gap: `${gap}px`,
            direction: this.bookDir === 'rtl' ? 'rtl' : 'ltr',
        }
        Object.assign(this.#header.style, marginalStyle)
        Object.assign(this.#footer.style, marginalStyle)
        const heads = makeMarginals(marginalDivisor, 'head')
        const feet = makeMarginals(marginalDivisor, 'foot')
        this.heads = heads.map(el => el.children[0])
        this.feet = feet.map(el => el.children[0])
        this.#header.replaceChildren(...heads)
        this.#footer.replaceChildren(...feet)

        return { height, width, margin, gap, columnWidth }
    }
    render() {
        if (this.#mode === 'cont') return this.#contRender()
        if (!this.#view) return
        this.#view.render(this.#beforeRender({
            vertical: this.#vertical,
            rtl: this.#rtl,
        }))
        this.#scrollToAnchor(this.#anchor)
    }
    get scrolled() {
        return this.getAttribute('flow') === 'scrolled'
    }
    get scrollProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'scrollLeft' : 'scrollTop')
            : scrolled ? 'scrollTop' : 'scrollLeft'
    }
    get sideProp() {
        const { scrolled } = this
        return this.#vertical ? (scrolled ? 'width' : 'height')
            : scrolled ? 'height' : 'width'
    }
    get size() {
        return this.#container.getBoundingClientRect()[this.sideProp]
    }
    // LightRead: true while sections are stacked in one scroll container
    get continuous() {
        return this.#mode === 'cont'
    }
    get viewSize() {
        if (this.#mode === 'cont') {
            const slot = this.#primary
            return slot?.view ? slot.view.element.getBoundingClientRect().height : 0
        }
        return this.#view.element.getBoundingClientRect()[this.sideProp]
    }
    get start() {
        if (this.#mode === 'cont') {
            const slot = this.#primary
            const st = this.#container.scrollTop
            return slot?.view ? st - this.#slotTop(slot, st) : st
        }
        return Math.abs(this.#container[this.scrollProp])
    }
    get end() {
        return this.start + this.size
    }
    get page() {
        return Math.floor(((this.start + this.end) / 2) / this.size)
    }
    get pages() {
        return Math.round(this.viewSize / this.size)
    }
    // this is the current position of the container
    get containerPosition() {
        if (this.#mode === 'cont') return this.start
        return this.#container[this.scrollProp]
    }

    // this is the new position of the containr
    set containerPosition(newVal) {
        if (this.#mode === 'cont') {
            const slot = this.#primary
            const st = this.#container.scrollTop
            this.#primaryLock = null
            this.#setScroll(newVal + (slot?.view ? this.#slotTop(slot, st) : 0))
            return
        }
        this.#container[this.scrollProp] = newVal
    }

    // ---- LightRead: sub-pixel drift (auto scroll, typewriter follow) ----
    // scrollTop may quantize writes (depending on zoom / WebView), so a slow auto scroll moved
    // the text 1,0,1,1,0… px per frame and it visibly juddered. driftBy keeps the exact position:
    // the whole-px part goes to scrollTop, the remainder (< 1px) to a transform on the container.
    // Any other scroll (the reader, navigation, relayout compensation) drops the remainder.
    // Returns false where it does not apply (paginated, vertical writing); callers fall back.
    driftBy(dy) {
        if (!this.scrolled || this.#vertical || !Number.isFinite(dy)) return false
        const ct = this.#container
        const st = ct.scrollTop
        const d = this.#drift
        const max = Math.max(0, ct.scrollHeight - ct.clientHeight)
        const exact = Math.max(0, Math.min(max, (d && d.whole === st ? st + d.frac : st) + dy))
        const whole = Math.floor(exact)
        if (whole !== st) {
            if (this.#mode === 'cont') {
                this.#primaryLock = null
                this.#setScroll(whole)
            } else ct.scrollTop = whole
        }
        const now = ct.scrollTop
        // At fractional zoom the browser may round UP to a physical-pixel boundary.
        // Keep the signed residual; clamping negatives loses distance every frame.
        const frac = exact - now
        this.#drift = { whole: now, frac }
        this.#showDrift(frac)
        // the single-section scroll debounce never fires while drifting: report as cont mode does
        if (this.#mode !== 'cont' && !this.#driftRelocTimer) this.#driftRelocTimer = setTimeout(() => {
            this.#driftRelocTimer = null
            if (this.scrolled && this.#mode !== 'cont') this.#afterScroll('scroll')
        }, CONT_RELOCATE_MS)
        return true
    }
    // back to whole pixels (paused / stopped / the reader takes over)
    driftEnd() {
        const d = this.#drift
        if (!d) return
        this.#drift = null
        this.#showDrift(0)
        const ct = this.#container
        if (ct.scrollTop === d.whole) {
            if (this.#mode === 'cont') this.#setScroll(d.whole + d.frac)
            else ct.scrollTop = d.whole + d.frac
        }
    }
    #drift = null // { whole, frac }: scrollTop we wrote and the remainder shown by the transform
    #driftShown = 0
    #driftRelocTimer = null
    #showDrift(frac) {
        this.#driftShown = frac
        const transform = this.#drift ? `translateY(${-frac}px)` : ''
        if (this.#container.style.transform !== transform) this.#container.style.transform = transform
    }
    #dropDrift() {
        if (!this.#drift && !this.#driftShown) return
        this.#drift = null
        this.#showDrift(0)
    }

    scrollBy(dx, dy) {
        if (this.#mode === 'cont') {
            // raw scroll across sections (auto scroll pushes this every frame)
            this.#primaryLock = null
            this.#setScroll(this.#container.scrollTop + dy)
            return
        }
        const delta = this.#vertical ? dy : dx
        const [offset, a, b] = this.#scrollBounds
        const rtl = this.#rtl
        const min = rtl ? offset - b : offset - a
        const max = rtl ? offset + a : offset + b
        this.containerPosition = Math.max(min, Math.min(max,
            this.containerPosition + delta))
    }

    snap(vx, vy) {
        const velocity = this.#vertical ? vy : vx
        const [offset, a, b] = this.#scrollBounds
        const { start, end, pages, size } = this
        const min = Math.abs(offset) - a
        const max = Math.abs(offset) + b
        const d = velocity * (this.#rtl ? -size : size)
        const page = Math.floor(
            Math.max(min, Math.min(max, (start + end) / 2
                + (isNaN(d) ? 0 : d))) / size)

        this.#scrollToPage(page, 'snap').then(() => {
            const dir = page <= 0 ? -1 : page >= pages - 1 ? 1 : null
            if (dir) return this.#goTo({
                index: this.#adjacentIndex(dir),
                anchor: dir < 0 ? () => 1 : () => 0,
            })
        })
    }
    #onTouchStart(e) {
        const touch = e.changedTouches[0]
        this.#touchState = {
            x: touch?.screenX, y: touch?.screenY,
            t: e.timeStamp,
            vx: 0, xy: 0,
        }
    }
    #onTouchMove(e) {
        const state = this.#touchState
        if (state.pinched) return
        state.pinched = globalThis.visualViewport.scale > 1
        if (this.scrolled || state.pinched) return
        if (e.touches.length > 1) {
            if (this.#touchScrolled) e.preventDefault()
            return
        }
        const doc = this.#view?.document
        const selection = doc?.getSelection()
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
            return
        }
        e.preventDefault()
        const touch = e.changedTouches[0]
        const x = touch.screenX, y = touch.screenY
        const dx = state.x - x, dy = state.y - y
        const dt = e.timeStamp - state.t
        state.x = x
        state.y = y
        state.t = e.timeStamp
        state.vx = dx / dt
        state.vy = dy / dt
        this.#touchScrolled = true
        if (Math.abs(dx) >= Math.abs(dy)) {
            this.scrollBy(dx, 0)
        } else if (Math.abs(dy) > Math.abs(dx)) {
            this.scrollBy(0, dy)
        }
    }
    #onTouchEnd() {
        this.#touchScrolled = false
        if (this.scrolled) return

        // XXX: Firefox seems to report scale as 1... sometimes...?
        // at this point I'm basically throwing `requestAnimationFrame` at
        // anything that doesn't work
        requestAnimationFrame(() => {
            if (globalThis.visualViewport.scale === 1)
                this.snap(this.#touchState.vx, this.#touchState.vy)
        })
    }
    // allows one to process rects as if they were LTR and horizontal
    #getRectMapper() {
        if (this.scrolled) {
            const size = this.viewSize
            const margin = this.#margin
            return this.#vertical
                ? ({ left, right }) =>
                    ({ left: size - right - margin, right: size - left - margin })
                : ({ top, bottom }) => ({ left: top + margin, right: bottom + margin })
        }
        const pxSize = this.pages * this.size
        return this.#rtl
            ? ({ left, right }) =>
                ({ left: pxSize - right, right: pxSize - left })
            : this.#vertical
                ? ({ top, bottom }) => ({ left: top, right: bottom })
                : f => f
    }
    async #scrollToRect(rect, reason) {
        if (this.scrolled) {
            const offset = this.#getRectMapper()(rect).left - (this.#anchorAt ?? this.#margin)
            return this.#scrollTo(offset, reason)
        }
        const offset = this.#getRectMapper()(rect).left
        return this.#scrollToPage(Math.floor(offset / this.size) + (this.#rtl ? -1 : 1), reason)
    }
    async #scrollTo(offset, reason, smooth) {
        const { size } = this
        if (this.containerPosition === offset) {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
            return
        }
        // FIXME: vertical-rl only, not -lr
        if (this.scrolled && this.#vertical) offset = -offset
        if ((reason === 'snap' || smooth) && this.hasAttribute('animated')) return animate(
            this.containerPosition, offset, 300, easeOutQuad,
            x => this.containerPosition = x,
        ).then(() => {
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        })
        else {
            this.containerPosition = offset
            this.#scrollBounds = [offset, this.atStart ? 0 : size, this.atEnd ? 0 : size]
            this.#afterScroll(reason)
        }
    }
    async #scrollToPage(page, reason, smooth) {
        const offset = this.size * (this.#rtl ? -page : page)
        return this.#scrollTo(offset, reason, smooth)
    }
    async scrollToAnchor(anchor, select) {
        this.#anchorAt = null
        if (this.#mode === 'cont') return this.#contScrollToAnchor(anchor, select)
        return this.#scrollToAnchor(anchor, select ? 'selection' : 'navigation')
    }
    // ---- LightRead: reading focus (docs/continuous-scroll.md §12) ----
    // Where a Range / element sits in the scroll viewport: { top, bottom, viewport } in px from the
    // viewport's top edge (top = first line, bottom = last line). Works for any laid-out slot.
    // null outside horizontal scrolled flow, or when the target is not in a displayed document.
    rangeBox(anchor) {
        if (!this.scrolled || this.#vertical || !anchor || typeof anchor !== 'object') return null
        const frame = this.#frameOf(docOf(anchor))
        if (!frame) return null
        let top = Infinity
        let bottom = -Infinity
        try {
            const target = anchor.startContainer && anchor.collapsed
                ? uncollapse(anchor.cloneRange()) : anchor
            for (const r of target.getClientRects()) if (r.height > 0) {
                top = Math.min(top, r.top)
                bottom = Math.max(bottom, r.bottom)
            }
            if (!(bottom > top)) {
                const r = target.getBoundingClientRect()
                if (r.height > 0) [top, bottom] = [r.top, r.bottom]
            }
        } catch { return null }
        if (!(bottom > top)) return null
        const offset = frame.getBoundingClientRect().top + frame.clientTop - this.#ctTop()
        return { top: offset + top, bottom: offset + bottom, viewport: this.size }
    }
    #frameOf(doc) {
        if (!doc) return null
        if (this.#mode === 'cont') {
            const slot = this.#slots.find(s => !s.dead && s.ready && s.committed && s.view?.document === doc)
            return slot ? slot.iframe ?? slot.view.element.querySelector('iframe') : null
        }
        return this.#view?.document === doc ? this.#view.element.querySelector('iframe') : null
    }
    // Scroll so the target's first line lands `at` px below the viewport top (default: one margin,
    // like scrollToAnchor). behavior 'smooth' glides for `duration` ms and gives way at once if the
    // reader scrolls; a newer call cancels a running one. In continuous mode the target's slot
    // becomes the primary section and its on-screen position is what relayouts keep. Paginated /
    // vertical: same as scrollToAnchor (the target's page is shown).
    async scrollToRange(anchor, { at, behavior = 'auto', duration = 300, reason = 'navigation' } = {}) {
        if (!this.scrolled || this.#vertical || !anchor || typeof anchor !== 'object')
            return this.scrollToAnchor(anchor)
        const doc = docOf(anchor)
        let slot = null
        if (this.#mode === 'cont') {
            slot = this.#slots.find(s => !s.dead && s.ready && s.view?.document === doc)
            if (!slot) return
            if (!slot.committed) this.#contCommit(slot)
        } else if (!doc || this.#view?.document !== doc) return
        const line = Number.isFinite(at) ? at : this.#margin
        const token = ++this.#glideToken
        const smooth = behavior === 'smooth' && this.hasAttribute('animated')
        if (slot) return this.#contScrollTo(slot, anchor, reason, smooth,
            { at: line, duration, stop: () => token !== this.#glideToken })
        const box = this.rangeBox(anchor)
        if (!box) return this.scrollToAnchor(anchor)
        const ct = this.#container
        const st = ct.scrollTop
        const target = Math.max(0, Math.min(ct.scrollHeight - ct.clientHeight, st + box.top - line))
        this.#anchor = anchor
        this.#anchorAt = line
        if (Math.abs(target - st) < 1) return
        if (smooth) {
            const done = await glide(st, target, duration, easeInOutQuad,
                () => ct.scrollTop, x => { ct.scrollTop = x }, () => token !== this.#glideToken)
            if (!done) return // the reader took over, or a newer call did
        } else ct.scrollTop = target
        this.#afterScroll(reason)
    }
    async #scrollToAnchor(anchor, reason = 'anchor') {
        this.#anchor = anchor
        const rects = uncollapse(anchor)?.getClientRects?.()
        // if anchor is an element or a range
        if (rects) {
            // when the start of the range is immediately after a hyphen in the
            // previous column, there is an extra zero width rect in that column
            const rect = Array.from(rects)
                .find(r => r.width > 0 && r.height > 0) || rects[0]
            if (!rect) return
            await this.#scrollToRect(rect, reason)
            return
        }
        // if anchor is a fraction
        if (this.scrolled) {
            await this.#scrollTo(anchor * this.viewSize, reason)
            return
        }
        const { pages } = this
        if (!pages) return
        const textPages = pages - 2
        const newPage = Math.round(anchor * (textPages - 1))
        await this.#scrollToPage(newPage + 1, reason)
    }
    #getVisibleRange() {
        if (this.scrolled) return getVisibleRange(this.#view.document,
            this.start + this.#margin, this.end - this.#margin, this.#getRectMapper())
        const size = this.#rtl ? -this.size : this.size
        return getVisibleRange(this.#view.document,
            this.start - size, this.end - size, this.#getRectMapper())
    }
    #afterScroll(reason) {
        if (!this.#view?.document?.body) return
        const range = this.#getVisibleRange()
        this.#lastVisibleRange = range
        // don't set new anchor if relocation was to scroll to anchor
        if (reason !== 'selection' && reason !== 'navigation' && reason !== 'anchor') {
            this.#anchor = range
            this.#anchorAt = null
        }
        else this.#justAnchored = true

        const index = this.#index
        const detail = { reason, range, index }
        if (this.scrolled) detail.fraction = this.start / this.viewSize
        else if (this.pages > 0) {
            const { page, pages } = this
            this.#header.style.visibility = page > 1 ? 'visible' : 'hidden'
            detail.fraction = (page - 1) / (pages - 2)
            detail.size = 1 / (pages - 2)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    async #display(promise) {
        const { index, src, anchor, onLoad, select, focus } = await promise
        this.#index = index
        const hasFocus = this.#view?.document?.hasFocus()
        if (src) {
            const view = this.#createView()
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                onLoad?.({ doc, index })
            }
            const beforeRender = this.#beforeRender.bind(this)
            await view.load(src, afterLoad, beforeRender)
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            this.#view = view
        }
        const target = (typeof anchor === 'function' ? anchor(this.#view.document) : anchor) ?? 0
        // LightRead: goTo({ focus: { at } }) puts a Range / element target `at` px below the top
        if (focus && Number.isFinite(focus.at) && this.scrolled && !this.#vertical
            && target && typeof target === 'object') {
            this.#anchorAt = focus.at
            await this.#scrollToAnchor(target, select ? 'selection' : 'navigation')
        } else await this.scrollToAnchor(target, select)
        if (hasFocus) this.focusView()
    }
    #canGoToIndex(index) {
        return index >= 0 && index <= this.sections.length - 1
    }
    async #goTo({ index, anchor, select, focus }) {
        if (index === this.#index) await this.#display({ index, anchor, select, focus })
        else {
            const oldIndex = this.#index
            const onLoad = detail => {
                this.sections[oldIndex]?.unload?.()
                this.setStyles(this.#styles)
                this.dispatchEvent(new CustomEvent('load', { detail }))
            }
            await this.#display(Promise.resolve(this.sections[index].load())
                .then(src => ({ index, src, anchor, onLoad, select, focus }))
                .catch(e => {
                    console.warn(e)
                    console.warn(new Error(`Failed to load section ${index}`))
                    return {}
                }))
        }
    }
    async goTo(target) {
        if (this.#locked) return
        const resolved = await target
        if (!this.#canGoToIndex(resolved.index)) return
        // LightRead: nothing displayed yet → start directly in the wanted mode
        if (this.#mode !== 'cont' && !this.#view && !this.#busy && this.#wantCont())
            this.#setMode('cont')
        return this.#track(this.#mode === 'cont'
            ? this.#contGoTo(resolved) : this.#goTo(resolved))
    }
    #scrollPrev(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.start > 0) return this.#scrollTo(
                Math.max(0, this.start - (distance ?? this.size)), null, true)
            return !this.atStart
        }
        if (this.atStart) return
        const page = this.page - 1
        return this.#scrollToPage(page, 'page', true).then(() => page <= 0)
    }
    #scrollNext(distance) {
        if (!this.#view) return true
        if (this.scrolled) {
            if (this.viewSize - this.end > 2) return this.#scrollTo(
                Math.min(this.viewSize, distance ? this.start + distance : this.end), null, true)
            return !this.atEnd
        }
        if (this.atEnd) return
        const page = this.page + 1
        const pages = this.pages
        return this.#scrollToPage(page, 'page', true).then(() => page >= pages - 1)
    }
    get atStart() {
        if (this.#mode === 'cont') {
            const first = this.#slots.find(s => s.ready && s.committed)
            return !!first && this.#adjacentOf(first.index, -1) == null
                && this.#container.scrollTop <= 1
        }
        return this.#adjacentIndex(-1) == null && this.page <= 1
    }
    get atEnd() {
        if (this.#mode === 'cont') {
            const last = this.#slots.at(-1)
            const ct = this.#container
            return !!last?.ready && this.#adjacentOf(last.index, 1) == null
                && ct.scrollTop + ct.clientHeight >= ct.scrollHeight - 2
        }
        return this.#adjacentIndex(1) == null && this.page >= this.pages - 2
    }
    #adjacentIndex(dir) {
        for (let index = this.#index + dir; this.#canGoToIndex(index); index += dir)
            if (this.sections[index]?.linear !== 'no') return index
    }
    async #turnPage(dir, distance) {
        if (this.#locked) return
        this.#locked = true
        const prev = dir === -1
        const shouldGo = await (prev ? this.#scrollPrev(distance) : this.#scrollNext(distance))
        if (shouldGo) await this.#goTo({
            index: this.#adjacentIndex(dir),
            anchor: prev ? () => 1 : () => 0,
        })
        if (shouldGo || !this.hasAttribute('animated')) await wait(100)
        this.#locked = false
    }
    async prev(distance) {
        if (this.#mode === 'cont') return await this.#contTurn(-1, distance)
        return await this.#turnPage(-1, distance)
    }
    async next(distance) {
        if (this.#mode === 'cont') return await this.#contTurn(1, distance)
        return await this.#turnPage(1, distance)
    }
    prevSection() {
        return this.goTo({ index: this.#adjacentIndex(-1) })
    }
    nextSection() {
        return this.goTo({ index: this.#adjacentIndex(1) })
    }
    firstSection() {
        const index = this.sections.findIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    lastSection() {
        const index = this.sections.findLastIndex(section => section.linear !== 'no')
        return this.goTo({ index })
    }
    getContents() {
        if (this.#mode === 'cont') {
            // every slot whose document exists, the primary section first
            const docs = this.#slots.filter(s => s.docReady && !s.dead && s.view?.document)
            const primary = docs.includes(this.#primary) ? [this.#primary] : []
            return [...primary, ...docs.filter(s => s !== this.#primary)].map(s => ({
                index: s.index,
                overlayer: s.view.overlayer,
                doc: s.view.document,
            }))
        }
        if (this.#view) return [{
            index: this.#index,
            overlayer: this.#view.overlayer,
            doc: this.#view.document,
        }]
        return []
    }
    setStyles(styles) {
        this.#styles = styles
        if (this.#mode === 'cont') return this.#contSetStyles()
        const $$styles = this.#styleMap.get(this.#view?.document)
        if (!$$styles) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles

        // NOTE: needs `requestAnimationFrame` in Chromium
        requestAnimationFrame(() => {
            // LightRead: 换书 / 关书后这一帧才到, #view 已经是 null
            if (this.#view) this.#replaceBackground(this.#view.docBackground, this.columnCount)
        })

        // needed because the resize observer doesn't work in Firefox
        this.#view?.document?.fonts?.ready?.then(() => this.#view.expand())
    }
    focusView() {
        this.#view.document.defaultView.focus()
    }
    destroy() {
        this.#observer.unobserve(this)
        this.#observer.disconnect() // LightRead: it observes #container, not `this`
        clearTimeout(this.#driftRelocTimer)
        this.#dropDrift()
        if (this.#mode === 'cont') {
            this.#contCancelTimers()
            for (const slot of [...this.#slots]) this.#contUnload(slot, false)
            this.#slots = []
            this.#primary = null
            this.#cAnchor = null
            this.#view = null
        } else {
            this.#view?.destroy()
            this.#view = null
            this.sections[this.#index]?.unload?.()
        }
        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)
    }

    // =====================================================================
    // LightRead: continuous scrolling (docs/continuous-scroll.md §2–§7, §11)
    // =====================================================================

    #wantCont() {
        return this.scrolled && this.hasAttribute('continuous') && !this.#contBlocked
            // a vertical-writing section on screen keeps the upstream behaviour
            && !(this.#mode !== 'cont' && this.#view && this.#vertical)
    }
    #setMode(mode) {
        this.#mode = mode
        this.#container.classList.toggle('continuous', mode === 'cont')
    }
    #track(promise) {
        const tracked = Promise.resolve(promise)
        this.#busy = tracked
        const clear = () => { if (this.#busy === tracked) this.#busy = null }
        tracked.then(clear, clear)
        return tracked
    }
    #syncMode() {
        if (this.#busy) {
            const again = () => this.#syncMode()
            this.#busy.then(again, again)
            return
        }
        const want = this.#wantCont()
        if (want === (this.#mode === 'cont')) return
        if (want) this.#enterCont()
        else {
            this.#exitCont()
            this.render()
        }
    }
    // single → continuous: the section on screen becomes the first slot (no reload)
    #enterCont() {
        this.#setMode('cont')
        const view = this.#view
        if (!view?.document?.body) return
        const slot = {
            index: this.#index, view, iframe: view.element.querySelector('iframe'),
            ready: true, docReady: true, committed: true, srcLoaded: true,
            vertical: this.#vertical, rtl: this.#rtl, styled: this.#styles,
        }
        view.onExpand = () => this.#contOnExpand(slot)
        this.#slots = [slot]
        this.#primary = slot
        this.#primaryLock = null
        this.#lastST = this.#container.scrollTop
        this.#contPickAnchor()
        this.#contIdlePrefetch()
    }
    // continuous → single: keep only the primary section, re-anchored to what is visible
    #exitCont(explicitAnchor) {
        const primary = this.#primary
        let anchor = explicitAnchor
        if (anchor === undefined && primary?.ready && primary.view.document?.body) {
            if (this.scrolled) try { anchor = this.#contVisibleRange(primary) } catch { /* */ }
            anchor ??= this.#cAnchor?.range ?? 0
        }
        this.#contCancelTimers()
        for (const slot of [...this.#slots]) if (slot !== primary) this.#contUnload(slot)
        this.#slots = []
        this.#primary = null
        this.#primaryLock = null
        this.#cAnchor = null
        this.#setMode('single')
        if (!primary?.ready || primary.dead) {
            if (primary) this.#contUnload(primary)
            this.#view = null
            return
        }
        Object.assign(primary.view.element.style, {
            position: 'relative', bottom: '', left: '', right: '', visibility: '' })
        primary.view.onExpand = () => this.#scrollToAnchor(this.#anchor)
        this.#view = primary.view
        this.#index = primary.index
        this.#vertical = primary.vertical
        this.#rtl = primary.rtl
        this.#anchor = anchor ?? 0
        this.#anchorAt = null
    }
    #contCancelTimers() {
        if (this.#idleHandle != null) cancelIdle(this.#idleHandle)
        if (this.#frameHandle != null) cancelAnimationFrame(this.#frameHandle)
        clearTimeout(this.#maintainTimer)
        clearTimeout(this.#relocTimer)
        clearTimeout(this.#retryTimer)
        this.#idleHandle = this.#frameHandle = null
        this.#maintainTimer = this.#relocTimer = null
    }
    #adjacentOf(index, dir) {
        for (let i = index + dir; this.#canGoToIndex(i); i += dir)
            if (this.sections[i]?.linear !== 'no' && !this.#failed.has(i)) return i
    }

    // ---- geometry (content coordinates of the scroll container) ----
    #ctTop() {
        const ct = this.#container
        return ct.getBoundingClientRect().top + ct.clientTop
    }
    #slotTop(slot, st = this.#container.scrollTop, ctTop = this.#ctTop()) {
        return slot.view.element.getBoundingClientRect().top - ctTop + st
    }
    #contentTop(slot, st = this.#container.scrollTop, ctTop = this.#ctTop()) {
        return (slot.iframe ?? slot.view.element).getBoundingClientRect().top - ctTop + st
    }
    #committed() {
        return this.#slots.filter(s => s.ready && s.committed && !s.dead)
    }
    #setScroll(value, compensate) {
        const ct = this.#container
        const before = this.#lastST
        const actual = ct.scrollTop
        ct.scrollTop = value
        const after = ct.scrollTop
        this.#lastST = after
        this.#ownScroll += after - actual
        // a compensation keeps the anchor where it is on screen; any other write moves it
        if (!compensate && this.#cAnchor) {
            this.#cAnchor.y -= after - before
            this.#cAnchor.offset += after - before
        }
    }
    #vel() {
        const idle = performance.now() - this.#lastScrollEventAt
        return this.#velocity * Math.exp(-Math.max(0, idle) / 150)
    }

    // ---- anchor: the text at the reading line must not move on relayout ----
    #contPickAnchor() {
        const slot = this.#primary
        const doc = slot?.ready ? slot.view.document : null
        if (!doc?.body || !slot.committed) {
            this.#cAnchor = null
            return
        }
        const st = this.#container.scrollTop
        const ctTop = this.#ctTop()
        const size = this.size
        const line = size * CONT_READING_LINE
        const contentTop = this.#contentTop(slot, st, ctTop)
        const offset = st - this.#slotTop(slot, st, ctTop)
        const y = st + line - contentTop
        let range = null
        if (y >= 0 && y < (slot.iframe?.getBoundingClientRect().height ?? 0)) {
            const body = doc.body.getBoundingClientRect()
            range = caretRangeAt(doc, (body.left + body.right) / 2, y)
            if (range?.collapsed && range.startContainer.nodeType === 3) {
                const node = range.startContainer
                if (range.startOffset < node.length) range.setEnd(node, range.startOffset + 1)
                else if (range.startOffset > 0) range.setStart(node, range.startOffset - 1)
            }
        }
        const rect = range ? firstRect(range) : null
        this.#cAnchor = rect
            ? { slot, range, y: contentTop + rect.top - st, offset }
            : { slot, range: null, y: line, offset }
        this.#lastST = st
    }
    #contEnsureAnchor() {
        const a = this.#cAnchor
        if (!a || a.slot.dead || a.slot !== this.#primary) this.#contPickAnchor()
    }
    // put the anchor back at the same place on screen (same task as the layout change)
    #contRestore() {
        const a = this.#cAnchor
        if (!a || a.slot.dead || !a.slot.committed || !a.slot.view?.document?.body) return
        // NOTE: scrollTop may already be clamped here (a tall slot above was removed and the
        // content got shorter); everything below is in content coordinates, so that's fine
        const st = this.#container.scrollTop
        const ctTop = this.#ctTop()
        const rect = a.range ? firstRect(a.range) : null
        const target = rect
            ? this.#contentTop(a.slot, st, ctTop) + rect.top - a.y
            : this.#slotTop(a.slot, st, ctTop) + a.offset
        if (Math.abs(target - st) >= 0.5) this.#setScroll(target, true)
    }

    // ---- scrolling ----
    #contOnScroll() {
        const now = performance.now()
        const st = this.#container.scrollTop
        const d = st - this.#lastST
        this.#lastST = st
        if (Math.abs(d) >= 0.5) {
            const a = this.#cAnchor
            if (a) {
                a.y -= d
                a.offset += d
            }
            const dt = now - this.#lastScrollEventAt
            const v = d / Math.max(dt, 4)
            this.#velocity = dt > 120 ? v * 0.5 : this.#velocity * 0.6 + v * 0.4
            this.#lastScrollEventAt = now
            if (!this.#animating) {
                this.#lastUserScrollAt = now
                this.#primaryLock = null
            }
        }
        this.#contScheduleFrame()
        if (!this.#relocTimer) this.#relocTimer = setTimeout(() => {
            this.#relocTimer = null
            this.#contRelocate('scroll')
        }, CONT_RELOCATE_MS)
        // only the user's scrolling postpones idle work; our own writes (auto scroll calls
        // scrollBy every frame) must not keep pushing the timer away
        if (Math.abs(d) >= 0.5 || this.#maintainTimer == null) this.#contScheduleMaintain()
    }
    #contScheduleFrame() {
        if (this.#frameHandle != null) return
        this.#frameHandle = requestAnimationFrame(() => {
            this.#frameHandle = null
            this.#contFrame()
        })
    }
    #contFrame() {
        if (this.#mode !== 'cont') return
        this.#contUpdatePrimary()
        const a = this.#cAnchor
        const size = this.size
        if (!a || a.slot !== this.#primary || a.slot.dead
        || Math.abs(a.y - size * CONT_READING_LINE) > size * 0.25) {
            // settle any pending layout change against the old anchor first
            this.#contRestore()
            this.#contPickAnchor()
        }
        const run = this.#run()
        const before = run ? this.#slots[run.lo - 1] : null
        if (before?.ready && !before.committed
        && (this.#contCanCommitNow(before) || this.#contUrgentUp()))
            this.#contCommit(before)
        this.#contCheckPreload()
    }
    #contUpdatePrimary() {
        const slots = this.#committed()
        if (!slots.length) return
        const lock = this.#primaryLock
        if (lock && slots.includes(lock)) {
            if (this.#primary !== lock) this.#contSetPrimary(lock)
            return
        }
        const st = this.#container.scrollTop
        const ctTop = this.#ctTop()
        const line = st + this.size * CONT_READING_LINE
        const now = performance.now()
        let found = null
        let nearest = Infinity
        let cur = null
        for (const slot of slots) {
            const top = this.#slotTop(slot, st, ctTop)
            const bottom = top + slot.view.element.getBoundingClientRect().height
            if (bottom > st && top < st + this.size) slot.lastUsed = now // on screen
            const distance = line < top ? top - line : line >= bottom ? line - bottom + 1 : 0
            if (distance < nearest) {
                nearest = distance
                found = slot
            }
            if (slot === this.#primary) cur = { top, bottom }
        }
        if (found === this.#primary) return
        // hysteresis: only switch once the line is clearly past the boundary
        if (cur && line >= cur.top - CONT_HYSTERESIS && line < cur.bottom + CONT_HYSTERESIS) return
        this.#contSetPrimary(found)
    }
    #contSetPrimary(slot, emit = true) {
        const previous = this.#primary
        this.#primary = slot
        this.#index = slot.index
        this.#view = slot.view
        if (!emit || previous === slot) return
        this.#contRelocate('scroll')
        this.dispatchEvent(new CustomEvent('section-change', {
            detail: { index: slot.index, doc: slot.view.document, previous: previous?.index ?? null },
        }))
    }
    #contVisibleRange(slot) {
        const st = this.#container.scrollTop
        const start = st - this.#slotTop(slot, st)
        const margin = this.#margin
        return getVisibleRange(slot.view.document, start + margin, start + this.size - margin,
            ({ top, bottom }) => ({ left: top + margin, right: bottom + margin }))
    }
    #contRelocate(reason) {
        clearTimeout(this.#relocTimer)
        this.#relocTimer = null
        const slot = this.#primary
        if (this.#mode !== 'cont' || !slot?.ready || !slot.view.document?.body) return
        const range = this.#contVisibleRange(slot)
        this.#lastVisibleRange = range
        const viewSize = this.viewSize
        const fraction = viewSize > 0 ? Math.max(0, Math.min(1, this.start / viewSize)) : 0
        this.dispatchEvent(new CustomEvent('relocate', {
            detail: { reason, range, index: slot.index, fraction },
        }))
    }

    // ---- loading / unloading slots ----
    // contiguous run of committed slots around the primary (placeholders / pending end it)
    #run() {
        const slots = this.#slots
        const p = slots.indexOf(this.#primary)
        if (p < 0 || !this.#primary.ready || !this.#primary.committed) return null
        const ok = s => s && s.ready && s.committed && !s.dead
        let lo = p
        let hi = p
        while (ok(slots[lo - 1])) lo--
        while (ok(slots[hi + 1])) hi++
        return { lo, hi }
    }
    #contDistanceUp() {
        const run = this.#run()
        if (!run) return Infinity
        const st = this.#container.scrollTop
        return st - this.#slotTop(this.#slots[run.lo], st)
    }
    // slots holding (or loading) a document, i.e. everything but placeholders
    #loadedCount() {
        return this.#slots.filter(s => !s.placeholder && !s.dead).length
    }
    // where: 'only' | 'append' | 'prepend' | 'into' (load into the placeholder `ph`)
    #contLoad(index, where, ph = null) {
        const slot = {
            index, view: null, iframe: null, ready: false, docReady: false,
            committed: where === 'only' || where === 'append', dead: false, srcLoaded: false,
            vertical: false, rtl: false, styled: undefined,
            ph: ph?.ph ?? null, phHeight: ph?.phHeight ?? 0, lastUsed: performance.now(), loadedAt: 0,
        }
        if (ph) {
            this.#slots[this.#slots.indexOf(ph)] = slot
            ph.dead = true
        } else if (where === 'prepend') this.#slots.unshift(slot)
        else this.#slots.push(slot)
        this.#loadingSlot = slot
        const started = performance.now()
        const killed = new Promise(resolve => slot.kill = resolve)
        slot.promise = (async () => {
            let src
            try {
                src = await this.sections[index].load()
            } catch (e) {
                console.warn(e)
            }
            slot.srcLoaded = src != null
            if (slot.dead) {
                this.#releaseSection(slot)
                return null
            }
            if (!src) {
                console.warn(new Error(`Failed to load section ${index}`))
                this.#failed.add(index)
                this.#contUnload(slot, false, true)
                return null
            }
            const view = new View({ container: this, onExpand: () => this.#contOnExpand(slot) })
            slot.view = view
            slot.iframe = view.element.querySelector('iframe')
            view.element.style.height = '0px'
            // not committed = out of flow and hidden until it may change the geometry
            if (!slot.committed) Object.assign(view.element.style, CONT_PENDING_STYLE)
            // NOTE: the element must never move in the DOM once loaded (that reloads the iframe)
            let before = slot.ph
            if (!before) {
                const pos = this.#slots.indexOf(slot)
                before = this.#slots.slice(pos + 1).map(s => s.view?.element ?? s.ph)
                    .find(Boolean) ?? null
            }
            this.#container.insertBefore(view.element, before)
            const afterLoad = doc => {
                if (doc.head) {
                    const $styleBefore = doc.createElement('style')
                    doc.head.prepend($styleBefore)
                    const $style = doc.createElement('style')
                    doc.head.append($style)
                    this.#styleMap.set(doc, [$styleBefore, $style])
                }
                this.#contApplyStyles(slot, false)
                slot.docReady = true
                this.dispatchEvent(new CustomEvent('load', { detail: { doc, index } }))
            }
            const beforeRender = info => {
                slot.vertical = info.vertical
                slot.rtl = info.rtl
                if (info.vertical) this.#contBlocked = true
                return this.#beforeRender(info)
            }
            await Promise.race([view.load(src, afterLoad, beforeRender), killed])
            if (slot.dead) return null
            this.dispatchEvent(new CustomEvent('create-overlayer', {
                detail: {
                    doc: view.document, index,
                    attach: overlayer => view.overlayer = overlayer,
                },
            }))
            slot.ready = true
            slot.lastUsed = slot.loadedAt = performance.now()
            this.#loadMs = this.#loadMs * 0.6 + (performance.now() - started) * 0.4
            return slot
        })().finally(() => {
            if (this.#loadingSlot === slot) this.#loadingSlot = null
        })
        return slot
    }
    #releaseSection(slot) {
        if (!slot.srcLoaded || slot.released) return
        slot.released = true
        this.sections[slot.index]?.unload?.()
    }
    // keepPlace: leave a placeholder of exactly the slot's height, so the scroll geometry
    // does not change and scrollTop never has to be written for an unload
    #contUnload(slot, notify = true, keepPlace = false) {
        const i = this.#slots.indexOf(slot)
        let ph = slot.placeholder ? slot.ph : null
        let phHeight = slot.phHeight ?? 0
        if (keepPlace && !slot.placeholder) {
            if (slot.committed && slot.view?.element.isConnected) {
                phHeight = slot.view.element.getBoundingClientRect().height
                ph = document.createElement('div')
                ph.setAttribute('aria-hidden', 'true')
                ph.style.cssText = `display:block;width:100%;height:${phHeight}px;`
                this.#container.insertBefore(ph, slot.view.element)
            } else ph = slot.ph // pending: its placeholder (if any) is still in place
        }
        if (keepPlace && ph && i >= 0) this.#slots[i] = {
            index: slot.index, placeholder: true, ph, phHeight, dead: false,
            ready: false, committed: false, view: null,
        }
        else {
            if (i >= 0) this.#slots.splice(i, 1)
            slot.ph?.remove()
        }
        if (slot.placeholder) {
            slot.dead = true
            return
        }
        const doc = slot.view?.document
        if (notify && slot.docReady && doc && !slot.dead)
            this.dispatchEvent(new CustomEvent('unload', { detail: { index: slot.index, doc } }))
        slot.dead = true
        slot.kill?.()
        slot.view?.destroy()
        slot.view?.element.remove()
        this.#releaseSection(slot)
        if (this.#loadingSlot === slot) this.#loadingSlot = null
    }
    // height the slot adds to the flow when committed
    #commitDelta(slot) {
        return slot.view.element.getBoundingClientRect().height - (slot.ph ? slot.phHeight : 0)
    }
    #contCommit(slot) {
        if (slot.committed || slot.dead || !slot.view) return
        this.#contEnsureAnchor()
        slot.committed = true
        Object.assign(slot.view.element.style, {
            position: 'relative', bottom: '', left: '', right: '', visibility: '' })
        slot.ph?.remove()
        slot.ph = null
        this.#contRestore()
    }
    // a pending slot may enter the flow at any time if that changes nothing on screen
    #contCanCommitNow(slot) {
        if (!slot.ready || slot.committed || slot.dead) return false
        if (Math.abs(this.#commitDelta(slot)) < 0.5) return true
        if (!slot.ph) return false
        // a placeholder below the anchor: its height doesn't move anything on screen
        const st = this.#container.scrollTop
        const line = this.#cAnchor ? this.#cAnchor.y : this.size
        return slot.ph.getBoundingClientRect().top - this.#ctTop() >= line + 1
    }
    // the only exception to "above-viewport mutations wait for true idle" (§5)
    #contUrgentUp() {
        return this.#vel() < 0 && this.#contDistanceUp() <= this.size
    }
    #contOnExpand(slot) {
        if (this.#mode !== 'cont' || slot.dead || !slot.committed) return
        this.#contRestore()
        this.#contScheduleFrame()
    }
    #contAfterLoad(slot) {
        if (this.#mode !== 'cont') return
        if (this.#contBlocked) return this.#contFallback()
        if (slot && !slot.committed && (this.#contCanCommitNow(slot) || this.#contUrgentUp()))
            this.#contCommit(slot)
        this.#contCheckPreload()
        this.#contScheduleMaintain()
    }
    // a vertical-writing section showed up: back to one section at a time
    #contFallback() {
        this.#exitCont()
        this.render()
    }

    // ---- true idle: the only time anything above the viewport may change ----
    // ms until "no touch, no user scroll / touchend for CONT_TRUE_IDLE_MS, velocity ≈ 0" holds
    #contIdleWait() {
        if (this.#touching || this.#animating) return CONT_TRUE_IDLE_MS
        const since = performance.now() - Math.max(this.#lastUserScrollAt, this.#lastTouchEndAt)
        let wait = CONT_TRUE_IDLE_MS - since
        if (Math.abs(this.#vel()) > 0.02) wait = Math.max(wait, 100)
        return Math.max(0, wait)
    }
    #contHasIdleWork() {
        const run = this.#run()
        const before = run ? this.#slots[run.lo - 1] : null
        if (before?.ready && !before.committed) return true
        return this.#loadedCount() > CONT_MAX_SLOTS
            || this.#slots.some(s => s.ready && !s.dead && !sameStyles(s.styled, this.#styles))
    }
    #contScheduleMaintain(delay = CONT_TRUE_IDLE_MS + 20) {
        clearTimeout(this.#maintainTimer)
        this.#maintainTimer = setTimeout(() => {
            this.#maintainTimer = null
            this.#contMaintain()
        }, delay)
    }
    #contMaintain() {
        if (this.#mode !== 'cont') return
        this.#contCheckPreload()
        const wait = this.#contIdleWait()
        if (wait > 0) return this.#contScheduleMaintain(wait + 20)
        if (!this.#contHasIdleWork()) return
        // scrollTop must not move (other than by our own writes) across two consecutive frames:
        // a compositor fling keeps moving it even when the main thread is too busy for events
        requestAnimationFrame(() => {
            const st1 = this.#container.scrollTop
            const own1 = this.#ownScroll
            requestAnimationFrame(() => {
                if (this.#mode !== 'cont') return
                const moved = (this.#container.scrollTop - st1) - (this.#ownScroll - own1)
                if (Math.abs(moved) >= 0.5 || this.#contIdleWait() > 0)
                    return this.#contScheduleMaintain()
                this.#contIdleWork()
                if (this.#contHasIdleWork()) this.#contScheduleMaintain(250)
            })
        })
    }
    // one mutation per idle period: insert the pending section above, or else unload one
    #contIdleWork() {
        const run = this.#run()
        const before = run ? this.#slots[run.lo - 1] : null
        if (before?.ready && !before.committed) {
            this.#contCommit(before)
            return
        }
        const restyle = this.#slots.find(s => s.ready && !s.dead && !sameStyles(s.styled, this.#styles))
        if (restyle) {
            this.#contApplyStyles(restyle)
            return
        }
        if (performance.now() - this.#lastUnloadAt >= CONT_UNLOAD_GAP_MS && this.#contTrimOne())
            this.#lastUnloadAt = performance.now()
        this.#contCheckPreload(true)
    }
    // unload the farthest stale section, never the primary or its neighbours (§5, §12)
    #contTrimOne() {
        if (this.#loadedCount() <= CONT_MAX_SLOTS || !this.#primary?.ready) return false
        const ct = this.#container
        const st = ct.scrollTop
        const ctTop = this.#ctTop()
        const size = this.size
        const now = performance.now()
        const p = this.#primary.index
        const keep = new Set([p, this.#adjacentOf(p, -1), this.#adjacentOf(p, 1)])
        // farther than the resting preload distance (2 screens) + 3 screens
        const far = 5 * size
        const dUp = this.#contDistanceUp()
        let victim = null
        let victimDistance = far
        for (const slot of this.#slots) {
            if (slot.placeholder || slot.dead || !slot.ready || slot === this.#loadingSlot) continue
            if (keep.has(slot.index) || now - (slot.loadedAt ?? 0) < CONT_RECENT_MS
                || now - (slot.lastUsed ?? 0) < CONT_SEEN_MS) continue
            let distance
            if (!slot.committed) distance = dUp // pending: sits right above the run
            else {
                const top = this.#slotTop(slot, st, ctTop)
                const bottom = top + slot.view.element.getBoundingClientRect().height
                distance = bottom <= st ? st - bottom : top >= st + size ? top - st - size : 0
            }
            if (distance > victimDistance) {
                victim = slot
                victimDistance = distance
            }
        }
        if (!victim) return false
        // a placeholder keeps the geometry (and the order of sections) on both sides
        this.#contUnload(victim, true, true)
        return true
    }
    // cap pressure (a needed load is blocked): free the farthest slot on the side the reader
    // is moving away from, > 2 screens off screen, never the primary or its neighbours. The
    // placeholder keeps the geometry, so this is safe even in the middle of a fling.
    #contUnloadUnderPressure(dir) {
        const st = this.#container.scrollTop
        const ctTop = this.#ctTop()
        const size = this.size
        const p = this.#primary.index
        const keep = new Set([p, this.#adjacentOf(p, -1), this.#adjacentOf(p, 1)])
        const dUp = this.#contDistanceUp()
        let victim = null
        let best = 2 * size
        for (const slot of this.#slots) {
            if (slot.placeholder || slot.dead || !slot.ready || slot === this.#loadingSlot) continue
            if (keep.has(slot.index)) continue
            let distance = -1
            if (!slot.committed) {
                if (dir > 0) distance = dUp // pending, right above the run
            } else {
                const top = this.#slotTop(slot, st, ctTop)
                const bottom = top + slot.view.element.getBoundingClientRect().height
                if (dir > 0 && bottom <= st) distance = st - bottom
                if (dir < 0 && top >= st + size) distance = top - st - size
            }
            if (distance > best) {
                victim = slot
                best = distance
            }
        }
        if (!victim) return false
        this.#contUnload(victim, true, true)
        return true
    }
    #contCheckPreload(fromIdle = false) {
        if (this.#mode !== 'cont' || this.#loadingSlot || !this.#primary?.ready) return
        const run = this.#run()
        if (!run) return
        let loaded = this.#loadedCount()
        const ct = this.#container
        const st = ct.scrollTop
        const ctTop = this.#ctTop()
        const size = this.size
        const loS = this.#slots[run.lo]
        const hiS = this.#slots[run.hi]
        const bottom = this.#slotTop(hiS, st, ctTop) + hiS.view.element.getBoundingClientRect().height
        const dDown = bottom - (st + size)
        const dUp = st - this.#slotTop(loS, st, ctTop)
        const v = this.#vel()
        const T = this.#loadMs
        // what would come next on each side: nothing to do while something there is loading
        const after = this.#slots[run.hi + 1]
        const before = this.#slots[run.lo - 1]
        const next = after ? (after.placeholder ? after : null)
            : this.#adjacentOf(hiS.index, 1) ?? null
        const prev = before ? (before.placeholder ? before : null)
            : this.#adjacentOf(loS.index, -1) ?? null
        const needDown = next != null && (dDown < Math.max(2 * size, Math.max(0, v) * T * 2)
            || hiS === this.#primary)
        // NOTE: §4 says max(1 × size, …) for upwards, but that equals the urgency threshold,
        // so every insertion above would happen mid-fling; load at 2 × size and let the
        // insertion wait for true idle unless D↑ ≤ size (see §12)
        const needUp = prev != null && dUp < Math.max(2 * size, Math.max(0, -v) * T * 2)
        let dir = 0
        if (v < 0 && needUp) dir = -1
        else if (needDown) dir = 1
        else if (needUp) dir = -1
        if (!dir) return
        const urgent = dir > 0 ? dDown <= size : dUp <= size
        const flinging = this.#touching
            || performance.now() - this.#lastUserScrollAt < CONT_IDLE_MS
        if (!urgent && (flinging || this.#animating) && !fromIdle) {
            this.#idleHandle ??= requestIdle(() => {
                this.#idleHandle = null
                this.#contCheckPreload(true)
            }, { timeout: 500 })
            return
        }
        // at the cap: make room behind the reader first (one unload per call = per frame)
        if (loaded >= CONT_PRELOAD_MAX_SLOTS && this.#contUnloadUnderPressure(dir))
            loaded = this.#loadedCount()
        if (loaded >= (urgent ? CONT_HARD_MAX_SLOTS : CONT_PRELOAD_MAX_SLOTS)) {
            clearTimeout(this.#retryTimer)
            this.#retryTimer = setTimeout(() => this.#contCheckPreload(), 250)
            return
        }
        const target = dir > 0 ? next : prev
        const slot = typeof target === 'object'
            ? this.#contLoad(target.index, 'into', target)
            : this.#contLoad(target, dir > 0 ? 'append' : 'prepend')
        slot.promise.then(s => this.#contAfterLoad(s))
    }
    #contIdlePrefetch() {
        this.#idleHandle ??= requestIdle(() => {
            this.#idleHandle = null
            this.#contCheckPreload(true)
        }, { timeout: 1000 })
    }
    // wait for loads in flight, then make sure `index` is a committed slot (navigation may
    // write scrollTop, so a pending slot is committed right away)
    async #contEnsureSlot(index) {
        for (let guard = 0; this.#loadingSlot && guard < 16; guard++)
            await this.#loadingSlot.promise.catch(() => null)
        if (this.#mode !== 'cont') return null
        let slot = this.#slots.find(s => s.index === index && !s.dead)
        if (slot?.placeholder) slot = await this.#contLoad(index, 'into', slot).promise
        else if (!slot) {
            const first = this.#slots[0]
            const last = this.#slots.at(-1)
            if (last && index === this.#adjacentOf(last.index, 1))
                slot = await this.#contLoad(index, 'append').promise
            else if (first && index === this.#adjacentOf(first.index, -1))
                slot = await this.#contLoad(index, 'prepend').promise
            else return null
        } else if (!slot.ready) slot = await slot.promise
        if (this.#contBlocked) {
            this.#contFallback()
            return null
        }
        if (!slot?.ready || slot.dead) return null
        if (!slot.committed) this.#contCommit(slot)
        return slot
    }

    // ---- navigation ----
    async #contGoTo({ index, anchor, select, focus }) {
        const reason = select ? 'selection' : 'navigation'
        const first = this.#slots[0]
        const last = this.#slots.at(-1)
        const near = this.#slots.some(s => s.index === index && !s.dead)
            || (last && index === this.#adjacentOf(last.index, 1))
            || (first && index === this.#adjacentOf(first.index, -1))
        if (near) {
            const slot = await this.#contEnsureSlot(index)
            if (this.#mode !== 'cont') return
            if (slot) return this.#contScrollTo(slot, anchor, reason, focus?.behavior !== 'auto', focus)
        }
        return this.#contRebuild({ index, anchor, select, focus })
    }
    async #contRebuild({ index, anchor, select, focus }) {
        this.#contCancelTimers()
        for (const slot of [...this.#slots]) this.#contUnload(slot)
        this.#cAnchor = null
        this.#primaryLock = null
        this.#lastST = this.#container.scrollTop = 0
        const hasFocus = this.#view?.document?.hasFocus()
        this.#index = index
        const pending = this.#contLoad(index, 'only')
        this.#primary = pending
        const slot = await pending.promise
        if (!slot || this.#mode !== 'cont') return
        if (this.#contBlocked) {
            // first section is vertical: show it the upstream way
            this.#exitCont((typeof anchor === 'function'
                ? anchor(slot.view.document) : anchor) ?? 0)
            this.render()
            if (hasFocus) this.focusView()
            return
        }
        this.#contSetPrimary(slot, false)
        await this.#contScrollTo(slot, anchor, select ? 'selection' : 'navigation', false, focus)
        if (hasFocus) this.focusView()
        this.#contIdlePrefetch()
    }
    // `place` (LightRead reading focus): { at } puts a Range / element target `at` px below the
    // viewport top instead of one margin; with `stop` (scrollToRange) the caller already chose
    // the motion, the glide yields to the reader and a superseded call does nothing more
    async #contScrollTo(slot, anchor, reason, smooth, place) {
        const doc = slot.view.document
        const resolved = (typeof anchor === 'function' ? anchor(doc) : anchor) ?? 0
        this.#anchor = resolved
        const ct = this.#container
        const st = ct.scrollTop
        const ctTop = this.#ctTop()
        const size = this.size
        const top = this.#slotTop(slot, st, ctTop)
        const height = slot.view.element.getBoundingClientRect().height
        let target = top
        let range = null
        if (typeof resolved === 'number') {
            target = top + Math.max(0, Math.min(resolved * height, height - size))
        } else {
            const rect = firstRect(uncollapse(resolved) ?? resolved)
            // same as upstream scrolled mode: the target line starts one margin below the top
            const at = Number.isFinite(place?.at) ? place.at : this.#margin
            if (rect) target = this.#contentTop(slot, st, ctTop) + rect.top - at
            if (resolved?.startContainer) range = resolved
            else if (resolved?.nodeType === 1) {
                range = doc.createRange()
                range.selectNode(resolved)
            }
        }
        target = Math.max(0, Math.min(target, ct.scrollHeight - ct.clientHeight))
        this.#primaryLock = slot
        if (this.#primary !== slot) {
            const previous = this.#primary
            this.#contSetPrimary(slot, false)
            if (previous && previous !== slot) this.dispatchEvent(new CustomEvent('section-change', {
                detail: { index: slot.index, doc, previous: previous.index },
            }))
        }
        const distance = Math.abs(target - st)
        if (place?.stop) {
            if (smooth && distance > 1) {
                const done = await this.#contAnimate(st, target, place.duration, easeInOutQuad, place.stop)
                if (!done) return // the reader took over, or a newer call did
            } else if (distance >= 0.5) this.#setScroll(target)
        } else if (smooth && distance > 1 && distance <= 3 * size && this.hasAttribute('animated'))
            await this.#contAnimate(st, target)
        else this.#setScroll(target)
        if (slot.dead || this.#mode !== 'cont') return
        const rect = range ? firstRect(range) : null
        if (rect) {
            const now = ct.scrollTop
            this.#cAnchor = {
                slot, range, y: this.#contentTop(slot, now) + rect.top - now,
                offset: now - this.#slotTop(slot, now),
            }
        } else this.#contPickAnchor()
        this.#contRelocate(reason)
        this.#contScheduleFrame()
    }
    async #contScrollToAnchor(anchor, select) {
        let slot = this.#primary
        if (anchor != null && typeof anchor === 'object') {
            const node = anchor.startContainer ?? anchor
            const doc = node.nodeType === 9 ? node : node.ownerDocument
            slot = this.#slots.find(s => !s.dead && s.view?.document === doc) ?? slot
        }
        if (!slot?.ready || slot.dead) return
        if (!slot.committed) this.#contCommit(slot)
        return this.#contScrollTo(slot, anchor, select ? 'selection' : 'navigation', false)
    }
    async #contAnimate(from, to, duration = 300, ease = easeOutQuad, stop = null) {
        this.#animating = true
        try {
            if (!stop) return await animate(from, to, duration, ease, x => this.#setScroll(x))
            const ct = this.#container
            return await glide(from, to, duration, ease, () => ct.scrollTop, x => this.#setScroll(x), stop)
        } finally {
            this.#animating = false
            this.#lastUserScrollAt = performance.now()
            this.#contScheduleMaintain()
        }
    }
    async #contTurn(dir, distance) {
        if (this.#locked) return
        // nothing displayed yet (view.init() calls next()): open the first section, like upstream
        if (!this.#slots.length) {
            const index = this.#adjacentIndex(dir)
            if (index == null) return
            return this.goTo({ index, anchor: dir < 0 ? () => 1 : () => 0 })
        }
        if (!this.#primary?.ready) return
        this.#locked = true
        try {
            const ct = this.#container
            const d = distance || this.size
            const max = () => ct.scrollHeight - ct.clientHeight
            let st = ct.scrollTop
            const run = this.#run()
            if (run) {
                // about to leave the loaded run: load (or fill the placeholder of) the neighbour first
                const ctTop = this.#ctTop()
                const loS = this.#slots[run.lo]
                const hiS = this.#slots[run.hi]
                const top = this.#slotTop(loS, st, ctTop)
                const bottom = this.#slotTop(hiS, st, ctTop) + hiS.view.element.getBoundingClientRect().height
                if (dir > 0 && st + this.size + d > bottom - 1) {
                    const next = this.#slots[run.hi + 1]?.index ?? this.#adjacentOf(hiS.index, 1)
                    if (next != null) await this.#contEnsureSlot(next)
                }
                if (dir < 0 && st - d < top + 1) {
                    const prev = this.#slots[run.lo - 1]?.index ?? this.#adjacentOf(loS.index, -1)
                    if (prev != null) await this.#contEnsureSlot(prev)
                }
            }
            if (this.#mode !== 'cont') return
            st = ct.scrollTop
            const target = Math.max(0, Math.min(max(), st + dir * d))
            if (Math.abs(target - st) < 1) return
            this.#primaryLock = null
            if (this.hasAttribute('animated')) await this.#contAnimate(st, target)
            else this.#setScroll(target)
            this.#contUpdatePrimary()
            this.#contRelocate('page')
        } finally {
            this.#locked = false
        }
    }

    // ---- layout & styles ----
    #contRender() {
        if (!this.scrolled || !this.#slots.some(s => s.ready)) return
        // keep the tracked anchor: the layout may already have changed (container resize)
        if (!this.#cAnchor) this.#contPickAnchor()
        for (const slot of this.#slots) {
            if (!slot.ready || slot.dead || !slot.view.document?.body) continue
            slot.view.render(this.#beforeRender({ vertical: slot.vertical, rtl: slot.rtl }))
        }
        this.#contRestore()
        this.#contScheduleFrame()
    }
    #contApplyStyles(slot, expand = true) {
        const styles = this.#styles
        // rewriting identical CSS would restyle the whole section for nothing
        if (slot.styled !== undefined && sameStyles(slot.styled, styles)) return
        slot.styled = styles
        const doc = slot.view?.document
        const $$styles = this.#styleMap.get(doc)
        if (!$$styles || styles === undefined) return
        const [$beforeStyle, $style] = $$styles
        if (Array.isArray(styles)) {
            const [beforeStyle, style] = styles
            $beforeStyle.textContent = beforeStyle
            $style.textContent = style
        } else $style.textContent = styles
        if (expand) doc.fonts?.ready?.then(() => {
            if (!slot.dead) slot.view.expand()
        })
    }
    #contSetStyles() {
        // the text at the reading line stays put: take a fresh anchor before restyling
        if (this.#primary?.ready && this.#primary.committed) {
            this.#contRestore()
            this.#contPickAnchor()
        }
        const ct = this.#container
        const st = ct.scrollTop
        const ctTop = this.#ctTop()
        const size = this.size
        for (const slot of this.#slots) {
            if (!slot.ready || slot.dead) continue
            const top = this.#slotTop(slot, st, ctTop)
            const bottom = top + slot.view.element.getBoundingClientRect().height
            const visible = slot.committed && bottom > st && top < st + size
            if (slot === this.#primary || visible) this.#contApplyStyles(slot)
        }
        this.#contScheduleMaintain() // the rest are restyled at true idle, one per period
        requestAnimationFrame(() => {
            if (this.#view) this.#replaceBackground(this.#view.docBackground, this.columnCount)
        })
    }
}

customElements.define('foliate-paginator', Paginator)
