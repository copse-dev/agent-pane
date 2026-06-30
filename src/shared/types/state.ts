import type { Thread } from './thread.ts'
import type { LayoutState } from './layout.ts'

export type PanelTab = 'file' | 'diff'
export type RightPanelMode = 'explorer' | 'terminal' | 'changes' | 'browser' | 'prs'
// Where the right panel sits relative to chat. `auto` keeps the legacy behaviour
// (vertical/side, auto-stacking on tall portrait windows); `side` and `bottom`
// pin the panel so users can force a readable terminal on any screen.
export type RightPanelPosition = 'auto' | 'side' | 'bottom'
export const RIGHT_PANEL_POSITIONS: readonly RightPanelPosition[] = ['auto', 'side', 'bottom']
export function isRightPanelPosition(value: unknown): value is RightPanelPosition {
  return typeof value === 'string' && (RIGHT_PANEL_POSITIONS as readonly string[]).includes(value)
}
export type Theme = 'light' | 'dark'

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
  layout: LayoutState
  theme: Theme
  fontSize: number // 12–20, applied to app + Monaco
  autoPortraitRightPanel: boolean // Auto-stack the right panel below chat on portrait windows.
  rightPanelPosition: RightPanelPosition // Where the right panel (explorer/terminal/etc.) lives.
  settings?: { model: string }
}

export interface StagedDiffEntry {
  path: string
  language: string
}
