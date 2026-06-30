import type { AppState, PanelTab, RightPanelMode } from '@shared/types/state.ts'

// Per-project right-panel view state. The right side panel (explorer / terminal /
// changes / browser / prs), its open/closed flag, and the file/diff tab are global
// fields on AppState, but conceptually belong to whichever project is active.
// Switching projects used to hard-reset them (closing the panel every time); we now
// snapshot the outgoing project's view state and restore the incoming project's so
// panel visibility persists per project across switches (issue #502 part a).

export interface ProjectViewState {
  filesPaneOpen: boolean
  rightPanelMode: RightPanelMode
  panelTab: PanelTab
}

export type ProjectViewStateRegistry = Map<string, ProjectViewState>

export const DEFAULT_PROJECT_VIEW_STATE: ProjectViewState = {
  filesPaneOpen: false,
  rightPanelMode: 'explorer',
  panelTab: 'file',
}

/** Snapshot the panel-related slice of AppState for stashing against a project id. */
export function captureProjectViewState(state: AppState): ProjectViewState {
  return {
    filesPaneOpen: state.filesPaneOpen,
    rightPanelMode: state.rightPanelMode,
    panelTab: state.panelTab,
  }
}

/** Store a project's view state (no-op for a null/blank id). */
export function recordProjectViewState(
  registry: ProjectViewStateRegistry,
  projectId: string | null,
  view: ProjectViewState,
): void {
  if (!projectId) return
  registry.set(projectId, view)
}

/**
 * Resolve the view state to apply when a project becomes active. Returns the
 * previously-recorded state, or the default (panel closed) for a project seen for
 * the first time.
 */
export function resolveProjectViewState(
  registry: ProjectViewStateRegistry,
  projectId: string,
): ProjectViewState {
  return registry.get(projectId) ?? { ...DEFAULT_PROJECT_VIEW_STATE }
}

/** Forget a project's stashed view state (e.g. when the project is removed). */
export function forgetProjectViewState(
  registry: ProjectViewStateRegistry,
  projectId: string,
): void {
  registry.delete(projectId)
}
