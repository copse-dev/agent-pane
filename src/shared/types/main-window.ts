export interface MainWindowNavigation {
  activeProjectId: string | null
  activeThreadId: string | null
}

export interface MainWindowBounds {
  width: number
  height: number
  x?: number
  y?: number
}

/**
 * One restorable Browser-pane tab.
 *
 * A canvas artefact is identified by `artefactTitle` (plus the thread that owns
 * it) rather than by address: its live tab holds the document in an opaque
 * `data:` URL that would be both enormous and stale on disk, and the durable
 * copy already lives beside the thread (see `canvas-store.ts`). Restoring one
 * therefore re-reads the saved artefact instead of replaying a URL.
 */
export interface BrowserPaneSessionTab {
  /** Address the tab was pointed at; empty for a tab that never navigated. */
  url: string
  /** Label as it was shown, so a restored tab reads right before it loads. */
  label?: string
  /** Canvas artefact this tab was showing, re-read from the thread's store. */
  artefactTitle?: string
  /** Thread that owns the artefact; equal titles in other threads are distinct. */
  artefactThreadId?: string
  /**
   * Project the artefact was rendered under. Tabs outlive a project switch, so
   * a window can quit holding artefacts from a project other than the one it
   * reopens on — without this the restore would look for them under the wrong
   * store and quietly drop the tab.
   */
  artefactProjectId?: string
}

/**
 * How many Browser-pane tabs one window restores. Bounded because the record is
 * written by the renderer into `config.json`, which is read on every launch:
 * without a cap a runaway (or compromised) pane could grow it without limit.
 */
export const MAX_RESTORED_BROWSER_TABS = 24

/** The Browser pane as one window left it: its tabs, and whether it was open. */
export interface BrowserPaneSession {
  tabs: BrowserPaneSessionTab[]
  /** Index into `tabs` of the tab that was in front. */
  activeTabIndex: number
  /** Whether the Browser pane was the visible right panel. */
  paneOpen: boolean
}

export interface MainWindowRecord extends MainWindowNavigation {
  id: string
  bounds: MainWindowBounds
  displayId?: string
  maximized: boolean
  fullscreen: boolean
  lastFocusedAt: number
  /** Restorable Browser-pane tabs; absent for a window that never opened one. */
  browserSession?: BrowserPaneSession
}

export interface MainWindowState {
  version: 1
  windows: MainWindowRecord[]
}
