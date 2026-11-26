import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { AppState, RightPanelMode } from '@shared/types/state.ts'
import type { CanvasArtefact, CanvasArtefactIdentity } from '@shared/types/canvas.ts'
import { addProject } from './projects.ts'

/** Keep `#pane-files` visibility in sync with store state (also selected on `filesPaneOpen`). */
export function syncFilesPaneDom(store: AppStore): void {
  if (typeof document === 'undefined') return
  const pane = document.getElementById('pane-files')
  if (pane) pane.hidden = !store.getState().filesPaneOpen
}

/**
 * Modes that can share the right panel with another. Context and pull requests
 * lay the whole panel out themselves (no list column, their own header), so
 * they only ever show alone.
 */
const SPLITTABLE_MODES: ReadonlySet<RightPanelMode> = new Set<RightPanelMode>([
  'explorer',
  'side-chat',
  'terminal',
  'changes',
  'browser',
  'memories',
  'roadmap',
  'vnc',
])

export function canSplitRightPanel(mode: RightPanelMode): boolean {
  return SPLITTABLE_MODES.has(mode)
}

/**
 * The panel's two slots after applying the split rules: the second pane must
 * differ from the first and both must be splittable. Review always takes the
 * first (top) slot, because its subject header spans the top of the panel.
 */
export function normalizeRightPanelSplit(
  primary: RightPanelMode,
  split: RightPanelMode | null,
): { rightPanelMode: RightPanelMode; rightPanelSplitMode: RightPanelMode | null } {
  if (split === null || split === primary || !canSplitRightPanel(primary)) {
    return { rightPanelMode: primary, rightPanelSplitMode: null }
  }
  if (!canSplitRightPanel(split)) return { rightPanelMode: primary, rightPanelSplitMode: null }
  if (split === 'changes') return { rightPanelMode: 'changes', rightPanelSplitMode: primary }
  return { rightPanelMode: primary, rightPanelSplitMode: split }
}

/** The second pane on screen under the first, or null when the panel shows one pane. */
export function rightPanelSplitOf(state: AppState): RightPanelMode | null {
  if (!state.filesPaneOpen) return null
  return normalizeRightPanelSplit(state.rightPanelMode, state.rightPanelSplitMode)
    .rightPanelSplitMode
}

/** Whether `mode`'s pane is on screen: the right panel is open and showing it, alone or split. */
export function rightPanelShows(state: AppState, mode: RightPanelMode): boolean {
  if (!state.filesPaneOpen) return false
  return state.rightPanelMode === mode || rightPanelSplitOf(state) === mode
}

/**
 * Call `listener` after any `setState` that puts `mode`'s pane on screen or
 * takes it off. Opening a closed panel on another mode is one change, so the
 * listener runs once for it. Not called on subscribe.
 */
export function selectRightPanelMode(
  store: AppStore,
  mode: RightPanelMode,
  listener: (active: boolean) => void,
): () => void {
  return store.select((state) => rightPanelShows(state, mode), listener)
}

/**
 * Call `listener` after any `setState` that opens, closes or switches the right
 * panel, including opening or closing its split pane. A closed panel selects as
 * `null`, so switching mode while it is closed is not a change. Not called on
 * subscribe.
 */
export function selectRightPanel(store: AppStore, listener: () => void): () => void {
  return store.select(
    (state) =>
      state.filesPaneOpen ? `${state.rightPanelMode}|${rightPanelSplitOf(state) ?? ''}` : null,
    listener,
  )
}

/**
 * Expand the open pane over chat, or restore the split view. Purely a layout
 * state: the pane keeps its mode and selection either way.
 */
export function setRightPanelMaximized(store: AppStore, maximized: boolean): void {
  if (store.getState().rightPanelMaximized === maximized) return
  store.setState({ rightPanelMaximized: maximized })
}

export function toggleRightPanelMaximized(store: AppStore): void {
  setRightPanelMaximized(store, !store.getState().rightPanelMaximized)
}

/** Whether a pane is actually covering chat — only an open panel can. */
export function isRightPanelMaximized(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMaximized } = store.getState()
  return filesPaneOpen && rightPanelMaximized
}

/**
 * Closing the panel gives chat the window back, so the expanded state has
 * nothing left to apply to. Clearing it here also means reopening the panel
 * lands on the ordinary split rather than silently covering chat again.
 */
function clearMaximizedOnClose(store: AppStore): void {
  if (!store.getState().rightPanelMaximized) return
  store.setState({ rightPanelMaximized: false })
}

export function toggleProjectsPane(store: AppStore): void {
  store.setState({ projectsPaneOpen: !store.getState().projectsPaneOpen })
}

export function toggleFilesPane(store: AppStore): void {
  const open = !store.getState().filesPaneOpen
  store.setState({
    filesPaneOpen: open,
    // Closing the whole panel closes both of its panes.
    ...(open ? { rightPanelMode: 'explorer' as const } : { rightPanelSplitMode: null }),
  })
  if (!open) clearMaximizedOnClose(store)
  syncFilesPaneDom(store)
}

export function openRightPanel(store: AppStore, mode: RightPanelMode): void {
  const state = store.getState()
  // Already on screen, alone or as either half of a split: nothing to move.
  if (rightPanelShows(state, mode)) {
    syncFilesPaneDom(store)
    return
  }
  const split = state.filesPaneOpen ? rightPanelSplitOf(state) : null
  store.setState({ filesPaneOpen: true, ...normalizeRightPanelSplit(mode, split) })
  syncFilesPaneDom(store)
}

/**
 * Show `mode` stacked with the pane already open, so two panes share the panel
 * (a thread beside both its diff and its browser). A closed panel, or a pane
 * that cannot share it, just opens `mode` alone.
 */
export function openRightPanelBeside(store: AppStore, mode: RightPanelMode): void {
  const state = store.getState()
  if (
    !state.filesPaneOpen ||
    !canSplitRightPanel(mode) ||
    !canSplitRightPanel(state.rightPanelMode)
  ) {
    openRightPanel(store, mode)
    return
  }
  if (rightPanelShows(state, mode)) return
  store.setState(normalizeRightPanelSplit(state.rightPanelMode, mode))
  syncFilesPaneDom(store)
}

/** Close the second pane, leaving the first filling the panel. */
export function closeRightPanelSplit(store: AppStore): void {
  if (store.getState().rightPanelSplitMode === null) return
  store.setState({ rightPanelSplitMode: null })
}

/** Open the Changes panel and reveal the diff for a workspace-relative file path. */
export function navigateToChange(store: AppStore, path: string): void {
  store.emit('git_change_navigate', path)
  openRightPanel(store, 'changes')
}

/** Open the Roadmap pane with a specific item selected (quick-open palette hit). */
export function navigateToRoadmapItem(store: AppStore, itemId: string): void {
  openRightPanel(store, 'roadmap')
  store.emit('roadmap_reveal', itemId)
}

export function openBrowserUrl(store: AppStore, url: string): void {
  openRightPanel(store, 'browser')
  store.emit('browser_url_requested', url)
}

export function openPullRequest(
  store: AppStore,
  ref: { owner: string; repo: string; number: number },
): void {
  openRightPanel(store, 'prs')
  store.emit('pr_open_requested', ref.owner, ref.repo, ref.number)
}

/**
 * Surface an MCP-UI artefact in the canvas (Browser pane).
 *
 * Deliberately does not open the pane: only the Browser pane knows whether this
 * title is already on a tab, and a re-render of an open artefact must refresh
 * quietly rather than seize the pane while the user is reading something else.
 * The pane opens itself for a title it has not rendered before.
 */
export function openCanvasArtefact(store: AppStore, artefact: CanvasArtefact): void {
  store.emit('canvas_artefact_requested', artefact)
}

/** Bring an already-rendered artefact tab to the front (the promote step). */
export function showCanvasArtefact(store: AppStore, identity: CanvasArtefactIdentity): void {
  store.emit('canvas_artefact_show_requested', identity)
}

export function toggleRightPanel(store: AppStore, mode: RightPanelMode): void {
  const state = store.getState()
  const split = rightPanelSplitOf(state)
  // Toggling one half of a split closes just that half; the other fills the panel.
  if (split !== null && split === mode) {
    store.setState({ rightPanelSplitMode: null })
    return
  }
  if (split !== null && state.rightPanelMode === mode) {
    store.setState({ rightPanelMode: split, rightPanelSplitMode: null })
    return
  }
  if (state.filesPaneOpen && state.rightPanelMode === mode) {
    store.setState({ filesPaneOpen: false, rightPanelSplitMode: null })
    clearMaximizedOnClose(store)
    syncFilesPaneDom(store)
    return
  }
  openRightPanel(store, mode)
}

export function ensureWorkspaceForPanel(api: ApiClient, store: AppStore): boolean {
  if (store.getState().workspaceRoot) return true
  void addProject(store, api)
  return false
}

export function openRightPanelWithWorkspace(
  store: AppStore,
  api: ApiClient,
  mode: RightPanelMode,
): void {
  if (!ensureWorkspaceForPanel(api, store)) return
  openRightPanel(store, mode)
}

export function openRightPanelBesideWithWorkspace(
  store: AppStore,
  api: ApiClient,
  mode: RightPanelMode,
): void {
  if (!ensureWorkspaceForPanel(api, store)) return
  openRightPanelBeside(store, mode)
}

export function toggleRightPanelWithWorkspace(
  store: AppStore,
  api: ApiClient,
  mode: RightPanelMode,
): void {
  if (!ensureWorkspaceForPanel(api, store)) return
  toggleRightPanel(store, mode)
}

export function toggleFilesPaneWithWorkspace(store: AppStore, api: ApiClient): void {
  if (!store.getState().workspaceRoot) {
    void addProject(store, api)
    return
  }
  toggleFilesPane(store)
}
