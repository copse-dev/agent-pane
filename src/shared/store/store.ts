import { DEFAULT_THEME_PREFERENCE, type AppState } from '@shared/types'
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
    themePreference: DEFAULT_THEME_PREFERENCE,
    fontSize: 14,
    uiScale: 1,
    autoPortraitRightPanel: true,
    rightPanelPosition: 'auto',
    openLinksInBuiltInBrowser: true,
    developerMode: false,
    ...initial,
  }

  const listeners: { [K in keyof StoreEvents]: Set<EventHandler<K>> } = {
    message_added: new Set(),
    message_queued: new Set(),
    message_token: new Set(),
    message_reasoning: new Set(),
    message_done: new Set(),
    tool_call_started: new Set(),
    tool_call_updated: new Set(),
    thread_status_changed: new Set(),
    agent_activity: new Set(),
    threads_changed: new Set(),
    thread_draft_changed: new Set(),
    new_thread_opened: new Set(),
    panel_changed: new Set(),
    explorer_reveal: new Set(),
    workspace_changed: new Set(),
    projects_changed: new Set(),
    files_pane_changed: new Set(),
    right_panel_mode_changed: new Set(),
    git_change_navigate: new Set(),
    roadmap_reveal: new Set(),
    browser_url_requested: new Set(),
    browser_url_bar_focus_requested: new Set(),
    pr_open_requested: new Set(),
    canvas_artefact_requested: new Set(),
    settings_changed: new Set(),
    theme_changed: new Set(),
    staged_diffs_changed: new Set(),
    usage_updated: new Set(),
    context_updated: new Set(),
    todos_changed: new Set(),
    review_changed: new Set(),
    hook_card_added: new Set(),
    comparison_changed: new Set(),
    git_branch_changed: new Set(),
    thread_checkout_changed: new Set(),
    composer_draft_flush: new Set(),
    composer_checkout_preferred: new Set(),
    agent_task_selected: new Set(),
    shell_tab_activated: new Set(),
    request_terminal_command: new Set(),
    attention_changed: new Set(),
  }

  function on<K extends keyof StoreEvents>(event: K, handler: EventHandler<K>): Unsubscribe {
    listeners[event].add(handler)
    return () => {
      listeners[event].delete(handler)
    }
  }

  function emit<K extends keyof StoreEvents>(event: K, ...args: StoreEvents[K]): void {
    listeners[event].forEach((handler) => {
      handler(...args)
    })
  }

  function setState(partial: Partial<AppState>): void {
    state = { ...state, ...partial }
  }

  return { getState: () => state, setState, on, emit }
}
