/**
 * Scroll following and reading-position preservation for the transcript: the
 * pin to the live end, telling our own scroll writes apart from the reader's,
 * the stream-follow glide, the jump-to-bottom button, and holding the first
 * visible item in place while content above it changes height.
 *
 * Extracted from `mountConversation` (#3962). The view owns the list and
 * what it renders; it calls in here for every scroll write, and the hooks in
 * {@link TranscriptScrollHost} reach back for the sticky image preview and the
 * disclosure model's deferred compaction.
 */
import { STREAM_PAINT_EVENT } from '../markdown/message-markdown.ts'
import { createFrameLoop } from './frame-loop.ts'

const SCROLL_PIN_THRESHOLD_PX = 48
/** Ignore auto-scroll briefly after the user scrolls up during streaming. */
const USER_SCROLL_UP_DEBOUNCE_MS = 150
/** Time constant of the glide that keeps streamed text in view. */
const STREAM_FOLLOW_EASE_MS = 90

/** Top-level transcript items a reading anchor can hold on to. */
const READING_ANCHOR_CANDIDATES =
  ':scope > .msg, :scope > [data-review-card], :scope > [data-review-report-card], :scope > [data-comparison-card]'

export interface ReadingAnchor {
  element: HTMLElement
  viewportTop: number
}

export interface TranscriptScrollHost {
  /** The scrollable messages list. */
  list: HTMLElement
  /** The jump-to-bottom button, hidden while the view is near the bottom. */
  scrollToBottomBtn: HTMLElement
  /**
   * Runs after every scroll write and every reader scroll. `releaseOnScrollUp`
   * is true only for a genuine upward scroll by the reader.
   */
  syncStickyImagePreview: (releaseOnScrollUp: boolean) => void
  /** The reader is back at the live end (scrolled there, or forced there). */
  onReturnToLiveEnd: () => void
}

export interface TranscriptScroll {
  isPinnedToBottom: () => boolean
  /** Scroll to the live end if following it; `force` follows it again first. */
  scrollToBottom: (force?: boolean) => void
  /** Every scroll write of ours goes through here so its echo is not read as the reader's. */
  setScrollTopProgrammatically: (top: number) => void
  updateScrollButton: () => void
  /** Bring a just-sent prompt fully into view, or its top when it is too tall. */
  scrollUserPromptIntoView: (msgEl: HTMLElement) => void
  captureReadingAnchor: () => ReadingAnchor | null
  restoreReadingAnchor: (anchor: ReadingAnchor | null, fallbackScrollTop: number) => void
  /** Run `update`, then follow the live end if pinned, else hold the first visible item. */
  keepReadingPosition: (update: () => void) => void
  /** Stop following, as if the reader scrolled away (navigating to an older item). */
  unpin: () => void
  /** A different thread is about to render: follow its live end from the top. */
  resetForThread: () => void
}

export function createTranscriptScroll(host: TranscriptScrollHost): TranscriptScroll {
  const { list, scrollToBottomBtn } = host
  let pinnedToBottom = true
  let lastScrollTop = 0
  // The scrollTop our own scrollToBottom() last landed on. Used to tell our
  // programmatic scroll echo apart from a genuine user scroll, so a user scroll
  // (especially scrolling up mid-stream) is never mistaken for autoscroll (#468).
  let lastProgrammaticScrollTop = -1
  let userScrolledUpAt = 0

  function isNearBottom(): boolean {
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight
    return distance <= SCROLL_PIN_THRESHOLD_PX
  }

  function shouldAutoScroll(): boolean {
    return pinnedToBottom && Date.now() - userScrolledUpAt > USER_SCROLL_UP_DEBOUNCE_MS
  }

  function updateScrollButton(): void {
    scrollToBottomBtn.hidden = isNearBottom()
  }

  function handleUserScroll(): void {
    const scrollTop = list.scrollTop
    // Ignore the scroll event emitted by our own scrollToBottom(): it lands on
    // an exact, known position. Everything else is a real user scroll. Matching
    // the position (rather than suppressing for a time window) means a user
    // scroll-up during rapid autoscroll is never dropped, so the view reliably
    // unpins instead of being yanked back to the bottom (#468). Consume the echo
    // once so a later user scroll to the same pixel isn't swallowed too.
    if (scrollTop === lastProgrammaticScrollTop) {
      lastProgrammaticScrollTop = -1
      lastScrollTop = scrollTop
      return
    }
    // A drop that lands flush with the bottom is the browser clamping scrollTop
    // after the content shrank (a finished turn's disclosures compacting), not
    // the reader: scrolling up always leaves the bottom by at least the scroll.
    // A clamp says nothing about what the reader wants, so it keeps the pin
    // state it found: a pinned view keeps following (treating the clamp as a
    // scroll-up used to unpin it), and one the reader scrolled away from is not
    // re-pinned just because layout pulled it onto the bottom.
    const dropped = scrollTop < lastScrollTop - 1
    const clamped = dropped && list.scrollHeight - scrollTop - list.clientHeight <= 1
    // A reader scrolling up can restore the full preview as soon as the prompt
    // leaves its sticky position. A clamp caused by the preview shrinking cannot.
    host.syncStickyImagePreview(dropped && !clamped)
    if (clamped) {
      // Layout, not the reader; the pin state stands.
    } else if (dropped) {
      userScrolledUpAt = Date.now()
      pinnedToBottom = false
    } else if (isNearBottom()) {
      pinnedToBottom = true
      host.onReturnToLiveEnd()
    }
    lastScrollTop = scrollTop
    updateScrollButton()
  }

  // Single place that performs our own scroll bookkeeping. Assigns scrollTop,
  // reads back the actual landed value (the browser may clamp it, e.g. when a
  // rebuild shrank scrollHeight), and records it. The programmatic-echo arming
  // is guarded on the position actually changing: when scrollTop doesn't move
  // (already at the requested position, common while pinned during streaming)
  // the browser fires NO scroll event, so handleUserScroll would never consume
  // lastProgrammaticScrollTop back to -1 and it would silently swallow the next
  // genuine user scroll landing on that pixel. Leaving it at -1 avoids that.
  function setScrollTopProgrammatically(top: number): void {
    const before = list.scrollTop
    list.scrollTop = top
    const landed = list.scrollTop
    // Reading-anchor and layout corrections can move upward without reader
    // intent. Keep the compact preview's hysteresis; only handleUserScroll
    // releases it early for a genuine upward scroll.
    host.syncStickyImagePreview(false)
    lastScrollTop = landed
    if (landed !== before) {
      // Remember exactly where we landed so the resulting scroll event is
      // recognized as ours and not treated as a user scroll (see handleUserScroll).
      lastProgrammaticScrollTop = landed
    }
  }

  function scrollToBottom(force = false): void {
    if (!force && !shouldAutoScroll()) return
    // The scrollable element is the messages list, not the mount root.
    setScrollTopProgrammatically(list.scrollHeight)
    if (force) {
      userScrolledUpAt = 0
      pinnedToBottom = true
      host.onReturnToLiveEnd()
    }
    updateScrollButton()
  }

  /**
   * scrollToBottom(true) flushes the transcript's bottom edge against the
   * viewport, which is right for a short prompt but hides the start of one
   * taller than the visible list: the reader only ever sees its tail (#2457).
   * Nudge the scroll position, on top of scrollToBottom's, just enough to
   * bring the whole row into view — or, when it can't fit, to show its top
   * rather than its bottom, mirroring `scrollIntoView({ block: 'nearest' })`.
   * Computed from rects (like captureReadingAnchor/restoreReadingAnchor below)
   * and applied through setScrollTopProgrammatically so the programmatic-echo
   * bookkeeping stays consistent with every other scroll in this module.
   *
   * When a correction was needed, this also un-pins autoscroll: otherwise the
   * very next unforced scrollToBottom() (e.g. the reply's first token, which a
   * mock model can emit before this function returns) would hug the tail
   * again and immediately undo the correction. A pane wide enough to keep the
   * prompt sticky-to-top never takes this branch, so this only affects the
   * narrow layout where CSS stops anchoring it (`@container chat-pane
   * (max-width: 360px)`) — the same layout the fold's own hand-off already
   * treats as ordinary, unpinned transcript content.
   */
  function scrollUserPromptIntoView(msgEl: HTMLElement): void {
    const listRect = list.getBoundingClientRect()
    const msgRect = msgEl.getBoundingClientRect()
    let delta = 0
    if (msgRect.top < listRect.top) {
      delta = msgRect.top - listRect.top
    } else if (msgRect.bottom > listRect.bottom) {
      delta =
        msgRect.height > listRect.height
          ? msgRect.top - listRect.top
          : msgRect.bottom - listRect.bottom
    }
    if (delta === 0) return
    setScrollTopProgrammatically(list.scrollTop + delta)
    pinnedToBottom = false
    updateScrollButton()
  }

  function captureReadingAnchor(): ReadingAnchor | null {
    const listRect = list.getBoundingClientRect()
    const candidates = list.querySelectorAll<HTMLElement>(READING_ANCHOR_CANDIDATES)
    for (const element of candidates) {
      const rect = element.getBoundingClientRect()
      if (rect.bottom > listRect.top) return { element, viewportTop: rect.top }
    }
    return null
  }

  function restoreReadingAnchor(anchor: ReadingAnchor | null, fallbackScrollTop: number): void {
    if (anchor?.element.isConnected) {
      const delta = anchor.element.getBoundingClientRect().top - anchor.viewportTop
      if (Math.abs(delta) > 0.5) setScrollTopProgrammatically(list.scrollTop + delta)
      return
    }
    if (list.scrollTop !== fallbackScrollTop) setScrollTopProgrammatically(fallbackScrollTop)
  }

  function keepReadingPosition(update: () => void): void {
    // Preserve the first visible transcript item's viewport offset. Numeric
    // scrollTop alone cannot protect what the reader is looking at when a
    // disclosure above that item changes height (#468).
    const prevScrollTop = list.scrollTop
    const wasPinned = pinnedToBottom
    const readingAnchor = wasPinned ? null : captureReadingAnchor()
    update()
    if (wasPinned) {
      scrollToBottom()
    } else restoreReadingAnchor(readingAnchor, prevScrollTop)
  }

  list.addEventListener('scroll', handleUserScroll, { passive: true })
  // A wheel-up that a nested scroller (a long code block, tool output) takes
  // for itself leaves the transcript where it is; unpinning on it would stop
  // autoscroll with the view still at the bottom and no jump button to resume.
  function nestedScrollerTakesWheelUp(target: EventTarget | null): boolean {
    for (
      let node = target instanceof Element ? target : null;
      node && node !== list;
      node = node.parentElement
    ) {
      if (node.scrollTop <= 0 || node.scrollHeight <= node.clientHeight) continue
      const { overflowY } = window.getComputedStyle(node)
      if (overflowY === 'auto' || overflowY === 'scroll') return true
    }
    return false
  }
  list.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY < 0 && !nestedScrollerTakesWheelUp(event.target)) {
        userScrolledUpAt = Date.now()
        pinnedToBottom = false
        updateScrollButton()
      }
    },
    { passive: true },
  )
  scrollToBottomBtn.addEventListener('click', () => {
    userScrolledUpAt = 0
    scrollToBottom(true)
  })

  // Streamed prose grows a line at a time. Snapping to the bottom on every
  // paint jerks the whole transcript up a line-height at once; glide there
  // instead, closing a fixed fraction of the distance each frame.
  const streamFollow = createFrameLoop((dt) => {
    if (!shouldAutoScroll()) return false
    const gap = list.scrollHeight - list.clientHeight - list.scrollTop
    if (gap <= 1 || dt === Infinity) {
      scrollToBottom()
      return false
    }
    setScrollTopProgrammatically(
      list.scrollTop + Math.ceil(gap * (1 - Math.exp(-dt / STREAM_FOLLOW_EASE_MS))),
    )
    // Still following: the view is pinned, only a few pixels short mid-glide.
    scrollToBottomBtn.hidden = true
    return true
  })
  list.addEventListener(STREAM_PAINT_EVENT, () => {
    if (shouldAutoScroll()) streamFollow.start()
  })

  return {
    isPinnedToBottom: () => pinnedToBottom,
    scrollToBottom,
    setScrollTopProgrammatically,
    updateScrollButton,
    scrollUserPromptIntoView,
    captureReadingAnchor,
    restoreReadingAnchor,
    keepReadingPosition,
    unpin: (): void => {
      pinnedToBottom = false
      userScrolledUpAt = Date.now()
    },
    resetForThread: (): void => {
      pinnedToBottom = true
      userScrolledUpAt = 0
      lastScrollTop = 0
    },
  }
}
