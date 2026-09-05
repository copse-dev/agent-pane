/**
 * The Browser pane's session: the tabs a window had open, kept across a quit.
 *
 * Everything the pane holds is per-window and in memory — a tab is a live
 * `<webview>`, and a canvas artefact is an opaque `data:` URL inside one — so
 * quitting Copse threw the whole canvas away. What survives instead is a small
 * description of each tab, stored beside that window's navigation record
 * (`main-window-state.ts`) and replayed on the next launch.
 *
 * An artefact tab is described by *title*, never by address. The live URL is a
 * whole document inlined, and the durable copy already lives beside its thread
 * (`canvas-store.ts`), so restoring one asks the canvas store to render it
 * again — which also means a restored artefact reflects edits made to its
 * source file in between, rather than a snapshot of the tab that was closed.
 */
import { MAX_RESTORED_BROWSER_TABS } from '@shared/types/main-window.ts'
import type { BrowserPaneSession, BrowserPaneSessionTab } from '@shared/types/main-window.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { ownsWindowSession } from './persistence.ts'

/**
 * One live tab as the pane can describe it. Deliberately the same shape the
 * pop-out seed captures, so the pane has one capture and two consumers; the
 * artefact fields are nullable there because a tab carries `null`, not a
 * missing key, when it is showing an ordinary page.
 */
export interface BrowserTabSnapshot {
  url: string
  label?: string | undefined
  artefactTitle?: string | null | undefined
  artefactThreadId?: string | null | undefined
  artefactProjectId?: string | null | undefined
}

/** Longest address worth storing; matches the schema that guards the record. */
const MAX_STORED_URL_LENGTH = 4096

/** An address that says nothing about what the tab was showing. */
function isBlankUrl(url: string): boolean {
  const trimmed = url.trim()
  return trimmed === '' || trimmed === 'about:blank'
}

/**
 * Whether an address is worth writing to disk. `data:` is refused rather than
 * truncated: an artefact tab's address is its whole document, and the stored
 * record is not the place to keep page content — the schema in
 * `main-window-state.ts` refuses it too, so a tab that kept one would take the
 * entire write down with it.
 */
function isStorableUrl(url: string): boolean {
  if (isBlankUrl(url) || url.length > MAX_STORED_URL_LENGTH) return false
  return !/^data:/i.test(url.trim())
}

/**
 * Reduce one live tab to what restores it, or null when nothing would.
 *
 * A canvas tab needs its owning thread: `canvas:reopenArtefact` is keyed on
 * (project, thread, title), so a title with no thread behind it cannot be read
 * back and the tab is dropped rather than restored empty.
 */
function toStoredTab(tab: BrowserTabSnapshot): BrowserPaneSessionTab | null {
  const label = tab.label && tab.label.length <= 256 ? tab.label : undefined
  if (tab.artefactTitle) {
    if (!tab.artefactThreadId) return null
    if (tab.artefactTitle.length > 200) return null
    return {
      url: '',
      ...(label ? { label } : {}),
      artefactTitle: tab.artefactTitle,
      artefactThreadId: tab.artefactThreadId,
      ...(tab.artefactProjectId ? { artefactProjectId: tab.artefactProjectId } : {}),
    }
  }
  if (!isStorableUrl(tab.url)) return null
  return { url: tab.url, ...(label ? { label } : {}) }
}

/**
 * Turn the pane's live tabs into the record to store, or null when there is
 * nothing worth restoring — an empty pane, or one holding only the blank tab
 * the pane opens for itself. Callers persist that null as an empty session, so
 * closing every tab is remembered rather than resurrecting yesterday's set.
 *
 * Tabs that cannot be restored are dropped, so the active index is recomputed
 * from the tab that was actually in front rather than carried over blindly.
 */
export function toBrowserPaneSession(
  tabs: readonly BrowserTabSnapshot[],
  activeTabIndex: number,
  paneOpen: boolean,
): BrowserPaneSession | null {
  const kept: BrowserPaneSessionTab[] = []
  let activeIndex = -1
  for (const [index, tab] of tabs.entries()) {
    const stored = toStoredTab(tab)
    if (!stored) continue
    if (index === activeTabIndex) activeIndex = kept.length
    kept.push(stored)
  }
  if (kept.length === 0) return null
  // Keep the newest tabs when a pane has run past the cap; the oldest are the
  // ones a user has stopped looking at.
  const overflow = Math.max(0, kept.length - MAX_RESTORED_BROWSER_TABS)
  const trimmed = kept.slice(overflow)
  const shifted = activeIndex < 0 ? 0 : Math.max(0, activeIndex - overflow)
  return {
    tabs: trimmed,
    activeTabIndex: Math.min(shifted, trimmed.length - 1),
    paneOpen,
  }
}

/**
 * The tabs to recreate from a stored record, with the active index clamped into
 * range. Runs the stored tabs back through the same filter that wrote them, so
 * a record that was hand-edited (or written by a newer build) cannot ask the
 * pane to open a `data:` tab or an artefact with no thread behind it.
 */
export function restorableBrowserPaneSession(
  session: BrowserPaneSession | null,
): BrowserPaneSession | null {
  if (!session || session.tabs.length === 0) return null
  return toBrowserPaneSession(session.tabs, session.activeTabIndex, session.paneOpen)
}

/** Read the tabs this window last had open. Absent on a first launch. */
export async function loadBrowserPaneSession(api: ApiClient): Promise<BrowserPaneSession | null> {
  if (!ownsWindowSession()) return null
  return restorableBrowserPaneSession(await api.windowState.getBrowserSession())
}

/** How long a burst of tab changes settles before one write goes out. */
export const BROWSER_SESSION_SAVE_DEBOUNCE_MS = 500

export interface BrowserSessionWriter {
  /**
   * Persist once the current burst of tab changes settles. Silent until
   * {@link BrowserSessionWriter.enable} has run, so the blank pane a window
   * mounts with never lands on top of the session it is still restoring.
   */
  schedule(): void
  /** Start honouring `schedule`, and record the pane as it now stands. */
  enable(): void
  /** Write immediately (the window is going away). */
  flush(): Promise<void>
  dispose(): void
}

/**
 * Persist `capture()` on a debounce, in submission order.
 *
 * Writes are chained because a tab change and the `pagehide` flush that follows
 * it are separate IPC calls to the same record: unchained, the earlier one
 * could land last and put a stale tab list back.
 */
export function createBrowserSessionWriter(
  api: ApiClient,
  capture: () => BrowserPaneSession | null,
): BrowserSessionWriter {
  let timer: ReturnType<typeof setTimeout> | null = null
  let enabled = false
  let chain: Promise<void> = Promise.resolve()

  const write = (): Promise<void> => {
    if (!enabled || !ownsWindowSession()) return Promise.resolve()
    // A pane with nothing to restore still records that fact: an empty session
    // is how "I closed every tab" is told apart from "this window has never
    // reported one", which is what a fresh profile looks like.
    const session = capture() ?? { tabs: [], activeTabIndex: 0, paneOpen: false }
    chain = chain
      .catch(() => undefined)
      .then(() => api.windowState.setBrowserSession(session))
      .catch(() => {
        // Losing the session is a worse next launch, not a broken pane.
      })
    return chain
  }

  const cancelTimer = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  const flush = (): Promise<void> => {
    cancelTimer()
    return write()
  }

  const onPagehide = (): void => {
    void flush()
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPagehide)

  return {
    schedule(): void {
      if (!enabled || timer !== null) return
      timer = setTimeout(() => {
        timer = null
        void write()
      }, BROWSER_SESSION_SAVE_DEBOUNCE_MS)
    },
    enable(): void {
      if (enabled) return
      enabled = true
      void write()
    },
    flush,
    dispose(): void {
      cancelTimer()
      enabled = false
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPagehide)
    },
  }
}
