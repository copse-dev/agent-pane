import type { Thread } from './thread.ts'
import type { LayoutState } from './layout.ts'
import type { ProjectWorktreeMode } from './worktree.ts'

export type PanelTab = 'file' | 'diff'
export type RightPanelMode =
  'explorer' | 'terminal' | 'changes' | 'browser' | 'prs' | 'ports' | 'memories' | 'roadmap'
// Where the right panel sits relative to chat. `auto` keeps the legacy behaviour
// (vertical/side, auto-stacking on tall portrait windows); `side` and `bottom`
// pin the panel so users can force a readable terminal on any screen.
export type RightPanelPosition = 'auto' | 'side' | 'bottom'
export const RIGHT_PANEL_POSITIONS: readonly RightPanelPosition[] = ['auto', 'side', 'bottom']
export function isRightPanelPosition(value: unknown): value is RightPanelPosition {
  return typeof value === 'string' && (RIGHT_PANEL_POSITIONS as readonly string[]).includes(value)
}
export type Theme = 'light' | 'dark'
// What the user picked in Settings. `system` follows the OS colour scheme and
// resolves to a concrete `Theme` at runtime; `light`/`dark` pin it. The store
// keeps both: `themePreference` (this) and `theme` (the resolved value panes read).
export type ThemePreference = 'system' | Theme
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark'
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
}

export interface OpenFile {
  path: string
  content: string
  language: string
  /** When set, the viewer scrolls to and positions the caret at this location. */
  reveal?: { line: number; column?: number }
}

export interface ActiveDiff {
  path: string
  before: string
  after: string
  language: string
}

export interface Project {
  id: string
  path: string
  name: string
  /** SSH workspace host id (`sshWorkspaceHosts[].id`) when this project is remote. */
  sshHost?: string
  /**
   * Set when opening the project's folder failed (moved / unmounted / wedged
   * main process). The entry is *quarantined*, not deleted — its threads stay on
   * disk under `~/.copse/workspace/<id>/` and the sidebar offers to relocate it —
   * so a transient failure never silently discards a project and its history
   * (issue #997). Cleared once the folder opens successfully again.
   */
  missing?: boolean
  /** Per-thread checkout policy. Defaults to `never` until rollout is complete. */
  worktreeMode?: ProjectWorktreeMode
}

/**
 * A thread-store directory under `~/.copse/workspace/<id>/` that has no matching
 * project entry in config — threads that would otherwise be invisible. Surfaced
 * so they can be re-attached to a folder rather than recovered by hand (#997).
 */
export interface OrphanProjectStore {
  /** The store directory id (also the project id it would re-attach under). */
  id: string
  /** How many thread directories the store holds. */
  threadCount: number
}

export interface AppState {
  workspaceRoot: string | null
  projects: Project[]
  activeProjectId: string | null
  /** Sidebar expand state; may lead activeProjectId while a workspace switch is in flight. */
  expandedProjectId: string | null
  threads: Thread[]
  activeThreadId: string | null
  panelTab: PanelTab
  openFile: OpenFile | null
  activeDiff: ActiveDiff | null
  stagedDiffs: StagedDiffEntry[] // multi-file queue (see spec 10)
  filesPaneOpen: boolean // right pane (explorer + file viewer) visibility
  rightPanelMode: RightPanelMode // explorer tree vs terminal column in right pane
  // The open pane fills the window over chat. Session-only (never persisted):
  // a window that reopened with chat already covered would read as broken.
  rightPanelMaximized: boolean
  layout: LayoutState
  theme: Theme // Resolved effective theme (never `system`); what panes render.
  themePreference: ThemePreference // The user's choice; `system` tracks the OS.
  fontSize: number // 12–20, applied to Monaco + xterm (then multiplied by uiScale)
  uiScale: number // 0.75–1.5 interface scale; drives CSS --ui-scale tokens
  autoPortraitRightPanel: boolean // Auto-stack the right panel below chat on portrait windows.
  rightPanelPosition: RightPanelPosition // Where the right panel (explorer/terminal/etc.) lives.
  openLinksInBuiltInBrowser: boolean // Clicked http(s) links open in the in-app browser vs the system browser.
  developerMode: boolean // Reveals advanced diagnostics and the native Developer Tools menu item.
  settings?: { model: string }
}

export interface StagedDiffEntry {
  path: string
  language: string
}
