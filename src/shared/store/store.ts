import type { AppState } from '@shared/types'
import { DEFAULT_LAYOUT } from '@shared/types/layout.ts'
import type { StoreEvents } from './events.ts'

type EventHandler<K extends keyof StoreEvents> = (...args: StoreEvents[K]) => void
type Unsubscribe = () => void

export interface AppStore {
  getState(): AppState
  setState(partial: Partial<AppState>): void
  on<K extends keyof StoreEvents>(event: K, handler: EventHandler<K>): Unsubscribe
  emit<K extends keyof StoreEvents>(event: K, ...args: StoreEvents[K]): void
}

export function createStore(initial?: Partial<AppState>): AppStore {
  let state: AppState = {
    workspaceRoot: null,
    projects: [],
    activeProjectId: null,
    expandedProjectId: null,
    threads: [],
    activeThreadId: null,
    panelTab: 'file',
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
    filesPaneOpen: false,
    rightPanelMode: 'explorer',
    layout: { ...DEFAULT_LAYOUT },
    theme: 'dark',
    fontSize: 14,
    autoPortraitRightPanel: true,
    ...initial,
  }

  type AnyHandler = (...args: unknown[]) => void
  const listeners = new Map<keyof StoreEvents, Set<AnyHandler>>()

  function on<K extends keyof StoreEvents>(event: K, handler: EventHandler<K>): Unsubscribe {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    set.add(handler as AnyHandler)
    return () => listeners.get(event)?.delete(handler as AnyHandler)
  }

  function emit<K extends keyof StoreEvents>(event: K, ...args: StoreEvents[K]): void {
    listeners.get(event)?.forEach((h) => {
      ;(h as (...a: StoreEvents[K]) => void)(...args)
    })
  }

  function setState(partial: Partial<AppState>): void {
    state = { ...state, ...partial }
  }

  return { getState: () => state, setState, on, emit }
}
