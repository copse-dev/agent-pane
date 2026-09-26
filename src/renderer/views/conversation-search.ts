import { el } from '../dom/helpers.ts'
import { searchIcon, chevronUpIcon, chevronDownIcon, closeIcon } from '../dom/icons.ts'

// In-conversation find bar (Cmd/Ctrl+F) — "find in page" for the chat transcript.
//
// Highlighting uses the CSS Custom Highlight API (CSS.highlights + Highlight +
// Range) rather than wrapping matches in <mark> elements. The conversation DOM is
// owned by the streaming-markdown renderers and is torn down / rebuilt on every
// token, tool update and thread switch; injecting wrapper nodes would be clobbered
// on the next render and could corrupt the markdown structure. Ranges live outside
// the DOM tree, so they layer highlights over the messages without touching them.
// A MutationObserver re-runs the search after those rebuilds so matches stay live.

const BASE_HIGHLIGHT = 'chat-search'
const CURRENT_HIGHLIGHT = 'chat-search-current'

// Feature-detect the Highlight API. Electron (Chromium) ships it, but guarding
// keeps the bar functional (count + scroll-to-match still work) in a jsdom/test
// or otherwise unsupported context instead of throwing on the missing global.
const highlightsSupported =
  typeof CSS !== 'undefined' &&
  'highlights' in CSS &&
  typeof (globalThis as { Highlight?: unknown }).Highlight === 'function'

/**
 * Byte offsets of every (case-insensitive) occurrence of `needle` in `haystack`.
 * Overlapping matches advance by the needle length, mirroring browser find. Pure
 * and DOM-free so the match logic is unit-testable without the Highlight API.
 */
export function findMatchOffsets(haystack: string, needle: string): number[] {
  if (!needle) return []
  const hay = haystack.toLowerCase()
  const q = needle.toLowerCase()
  const offsets: number[] = []
  let from = 0
  for (;;) {
    const idx = hay.indexOf(q, from)
    if (idx === -1) break
    offsets.push(idx)
    from = idx + q.length
  }
  return offsets
}

/**
 * Collapse whitespace runs to one space and trim the ends. Both the query and
 * the transcript text go through this, so a selection copied across lines or
 * paragraphs (which picks up newlines), or a query typed with different
 * spacing, still matches the rendered text.
 */
export function normalizeSearchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** One transcript text node's contribution to the flattened search text. */
export interface SearchSegment {
  text: string
  /** True when this text starts a different block than the previous segment. */
  breakBefore: boolean
}

/**
 * The transcript's text nodes flattened into one whitespace-normalised string,
 * with each character mapped back to the segment and raw offset it came from.
 * Matching runs over `text`, so a query can span formatting (bold, inline
 * code, links) and block boundaries, which live in separate text nodes.
 */
export interface SearchIndex {
  text: string
  segmentAt: Int32Array
  offsetAt: Int32Array
}

const WHITESPACE_CHAR = /\s/

export function buildSearchIndex(segments: readonly SearchSegment[]): SearchIndex {
  const capacity = segments.reduce((n, segment) => n + segment.text.length + 1, 0)
  const segmentAt = new Int32Array(capacity)
  const offsetAt = new Int32Array(capacity)
  const chars: string[] = []
  let pendingSpace = false
  segments.forEach((segment, seg) => {
    if (segment.breakBefore && chars.length > 0) pendingSpace = true
    for (let i = 0; i < segment.text.length; i++) {
      const ch = segment.text.charAt(i)
      if (WHITESPACE_CHAR.test(ch)) {
        if (chars.length > 0) pendingSpace = true
        continue
      }
      if (pendingSpace) {
        // A collapsed whitespace run (or a block boundary) becomes one space.
        // Normalised queries are trimmed, so it is never a match endpoint.
        segmentAt[chars.length] = seg
        offsetAt[chars.length] = i
        chars.push(' ')
        pendingSpace = false
      }
      segmentAt[chars.length] = seg
      offsetAt[chars.length] = i
      chars.push(ch)
    }
  })
  return {
    text: chars.join(''),
    segmentAt: segmentAt.subarray(0, chars.length),
    offsetAt: offsetAt.subarray(0, chars.length),
  }
}

/** A match's raw endpoints in the indexed segments; `endOffset` is exclusive. */
export interface SegmentMatch {
  startSegment: number
  startOffset: number
  endSegment: number
  endOffset: number
}

/** Every (case-insensitive, whitespace-normalised) match of `query` in `index`. */
export function findSegmentMatches(index: SearchIndex, query: string): SegmentMatch[] {
  const needle = normalizeSearchText(query)
  return findMatchOffsets(index.text, needle).map((start) => {
    const last = start + needle.length - 1
    return {
      startSegment: index.segmentAt[start] ?? 0,
      startOffset: index.offsetAt[start] ?? 0,
      endSegment: index.segmentAt[last] ?? 0,
      endOffset: (index.offsetAt[last] ?? 0) + 1,
    }
  })
}

// Text in a different one of these than the previous text node renders on a
// new line (and a copied selection carries a newline there), though the DOM
// holds no whitespace between them.
const SEARCH_BLOCK_SELECTOR =
  'p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th, dt, dd, summary, figcaption, div'

let openImpl: ((query?: string) => void) | null = null
let closeImpl: (() => void) | null = null
let isOpenImpl: (() => boolean) | null = null

/**
 * Open the find bar. With `query`, prefills it and runs the search — used by
 * the transcript's "Search" context menu action to reuse this bar instead of
 * inventing a second search surface.
 */
export function openConversationSearch(query?: string): void {
  openImpl?.(query)
}

export function closeConversationSearch(): void {
  closeImpl?.()
}

export function isConversationSearchOpen(): boolean {
  return isOpenImpl?.() ?? false
}

/**
 * Mount the find bar into the conversation root (`#conversation`). The bar floats
 * over the transcript; the scrollable message list is discovered lazily so this
 * can run right after `mountConversation` regardless of child-render timing.
 */
export function mountConversationSearch(root: HTMLElement): void {
  const input = el('input', {
    type: 'text',
    class: 'chat-search-input',
    placeholder: 'Find in conversation…',
    'aria-label': 'Find in conversation',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  const count = el('span', { class: 'chat-search-count', 'aria-live': 'polite' })
  const prevBtn = el(
    'button',
    {
      type: 'button',
      class: 'chat-search-nav',
      'aria-label': 'Previous match',
      'data-tooltip': 'Previous match (Shift+Enter)',
    },
    chevronUpIcon('ui-icon ui-icon-sm'),
  )
  const nextBtn = el(
    'button',
    {
      type: 'button',
      class: 'chat-search-nav',
      'aria-label': 'Next match',
      'data-tooltip': 'Next match (Enter)',
    },
    chevronDownIcon('ui-icon ui-icon-sm'),
  )
  const closeBtn = el(
    'button',
    {
      type: 'button',
      class: 'chat-search-close',
      'aria-label': 'Close find',
      'data-tooltip': 'Close find (Esc)',
    },
    closeIcon('ui-icon ui-icon-sm'),
  )

  const bar = el(
    'div',
    { class: 'chat-search', role: 'search', hidden: true },
    el(
      'span',
      { class: 'chat-search-icon', 'aria-hidden': 'true' },
      searchIcon('ui-icon ui-icon-sm'),
    ),
    input,
    count,
    el('div', { class: 'chat-search-actions' }, prevBtn, nextBtn, closeBtn),
  )
  // Float the bar over the chat pane rather than inside `.conversation`, whose
  // `overflow: hidden` + padding would otherwise constrain it. The transcript
  // (`.messages-list`) is still discovered under `root` for match collection.
  const host = root.closest('.pane-chat') ?? root
  host.append(bar)

  let ranges: Range[] = []
  let currentIdx = 0
  let debounce: ReturnType<typeof setTimeout> | null = null
  let observer: MutationObserver | null = null

  function messagesList(): HTMLElement | null {
    return root.querySelector<HTMLElement>('.messages-list')
  }

  function clearHighlights(): void {
    if (!highlightsSupported) return
    CSS.highlights.delete(BASE_HIGHLIGHT)
    CSS.highlights.delete(CURRENT_HIGHLIGHT)
  }

  function collectRanges(query: string): Range[] {
    const container = messagesList()
    if (!container || !normalizeSearchText(query)) return []
    const nodes: Node[] = []
    const segments: SearchSegment[] = []
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let previousBlock: Element | null = null
    let node = walker.nextNode()
    while (node) {
      const block = node.parentElement?.closest(SEARCH_BLOCK_SELECTOR) ?? null
      nodes.push(node)
      segments.push({ text: node.nodeValue ?? '', breakBefore: block !== previousBlock })
      previousBlock = block
      node = walker.nextNode()
    }
    const found: Range[] = []
    for (const match of findSegmentMatches(buildSearchIndex(segments), query)) {
      const start = nodes[match.startSegment]
      const end = nodes[match.endSegment]
      if (!start || !end) continue
      const range = document.createRange()
      range.setStart(start, match.startOffset)
      range.setEnd(end, match.endOffset)
      found.push(range)
    }
    return found
  }

  function paintHighlights(): void {
    if (!highlightsSupported) return
    if (ranges.length === 0) {
      clearHighlights()
      return
    }
    // The current match sits in both sets; a higher priority makes its dedicated
    // style win the overlap so it reads as the active match, not just a match.
    CSS.highlights.set(BASE_HIGHLIGHT, new Highlight(...ranges))
    const current = ranges[currentIdx]
    if (current) {
      const currentHighlight = new Highlight(current)
      currentHighlight.priority = 1
      CSS.highlights.set(CURRENT_HIGHLIGHT, currentHighlight)
    } else {
      CSS.highlights.delete(CURRENT_HIGHLIGHT)
    }
  }

  function updateCount(): void {
    const total = ranges.length
    const query = input.value
    if (!query) {
      count.textContent = ''
      input.classList.remove('chat-search-nomatch')
      return
    }
    count.textContent = total === 0 ? '0/0' : `${String(currentIdx + 1)}/${String(total)}`
    input.classList.toggle('chat-search-nomatch', total === 0)
  }

  function scrollCurrentIntoView(): void {
    const current = ranges[currentIdx]
    const target = current?.startContainer.parentElement
    target?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }

  function runSearch(preserveIndex = false): void {
    const query = input.value
    const prev = preserveIndex ? currentIdx : 0
    ranges = collectRanges(query)
    currentIdx = ranges.length === 0 ? 0 : Math.min(prev, ranges.length - 1)
    paintHighlights()
    updateCount()
  }

  function step(delta: number): void {
    if (ranges.length === 0) return
    currentIdx = (currentIdx + delta + ranges.length) % ranges.length
    paintHighlights()
    updateCount()
    scrollCurrentIntoView()
  }

  input.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      runSearch(false)
      scrollCurrentIntoView()
    }, 120)
  })

  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      // Stop the app-level Escape handler (which would abort a running agent).
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  })

  prevBtn.addEventListener('click', () => {
    step(-1)
  })
  nextBtn.addEventListener('click', () => {
    step(1)
  })
  closeBtn.addEventListener('click', () => {
    close()
  })

  function open(query?: string): void {
    const alreadyOpen = !bar.hidden
    bar.hidden = false
    if (query !== undefined) input.value = query
    if (!alreadyOpen) {
      // Re-run after the transcript rebuilds (streaming tokens, tool updates,
      // thread switches) so highlighted ranges never point at detached nodes.
      const container = messagesList()
      if (container) {
        observer = new MutationObserver(() => {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            runSearch(true)
          }, 120)
        })
        observer.observe(container, { childList: true, subtree: true, characterData: true })
      }
    }
    input.focus()
    input.select()
    if (query !== undefined) {
      // A new query starts from its first match, shown on screen.
      runSearch(false)
      scrollCurrentIntoView()
    } else if (input.value) {
      runSearch(true)
    }
  }

  function close(): void {
    if (bar.hidden) return
    bar.hidden = true
    if (debounce) {
      clearTimeout(debounce)
      debounce = null
    }
    observer?.disconnect()
    observer = null
    ranges = []
    currentIdx = 0
    clearHighlights()
    // Hiding the focused input drops focus to <body>; nothing else to restore.
  }

  openImpl = open
  closeImpl = close
  isOpenImpl = (): boolean => !bar.hidden
}
