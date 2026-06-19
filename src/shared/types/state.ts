import type { Thread } from './thread.ts'

export type PanelTab = 'file' | 'diff'
export type Theme = 'light' | 'dark'

export interface OpenFile {
  path: string
  content: string
  language: string
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
  threads: Thread[]
  activeThreadId: string | null
  panelTab: PanelTab
  openFile: OpenFile | null
  activeDiff: ActiveDiff | null
  stagedDiffs: StagedDiffEntry[] // multi-file queue (see spec 10)
  filesPaneOpen: boolean // right pane (explorer + file viewer) visibility
  theme: Theme
  fontSize: number // 12–20, applied to app + Monaco
  settings?: { model: string }
}

export interface StagedDiffEntry {
  path: string
  language: string
}
