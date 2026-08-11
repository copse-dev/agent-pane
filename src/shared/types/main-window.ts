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

export interface MainWindowRecord extends MainWindowNavigation {
  id: string
  bounds: MainWindowBounds
  displayId?: string
  maximized: boolean
  fullscreen: boolean
  lastFocusedAt: number
}

export interface MainWindowState {
  version: 1
  windows: MainWindowRecord[]
}
