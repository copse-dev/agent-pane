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
  /**
   * Call `listener` after any `setState` that changes what `selector` reads, as
   * judged by `equals` (default `Object.is`). Subscribe to the state a view
   * renders rather than to an event its writer has to remember to emit. Not
   * called on subscribe; read the current value with `getState()` to paint once.
   */
  select<T>(
    selector: (state: AppState) => T,
    listener: (next: T, prev: T) => void,
    equals?: (a: T, b: T) => boolean,
  ): Unsubscribe
}

/**
 * `select` equality for a selector that builds a fresh tuple on every read:
 * equal when each item is `Object.is`-equal to its counterpart.
 */
export function sameItems<T extends readonly unknown[]>(a: T, b: T): boolean {
  return a.length === b.length && a.every((item, index) => Object.is(item, b[index]))
}

export function createStore(initial?: Partial<AppState>): AppStore {
  let state: AppState = {
    workspaceRoot: null,
    projects: [],
    projectGroups: [],
    activeProjectId: null,
    expandedProjectId: null,
    threads: [],
    backgroundThreads: [],
    activeThreadId: null,
    panelTab: 'file',
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
    filesPaneOpen: false,
    rightPanelMode: 'explorer',
    rightPanelMaximized: false,
    projectsPaneOpen: true,
    layout: { ...DEFAULT_LAYOUT },
    theme: 'dark',
    themePreference: DEFAULT_THEME_PREFERENCE,
    fontSize: 14,
    uiScale: 1,
    animateAgentAvatars: true,
    conciseThreadsEnabled: true,
    autoPortraitRightPanel: true,
    rightPanelPosition: 'auto',
    sidebarProjectFilterId: null,
    sidebarThreadSort: 'activity',
    sidebarThreadSortReverse: false,
    sidebarThreadGroup: 'project',
    openLinksInBuiltInBrowser: true,
    developerMode: false,
    ...initial,
  }

  const listeners: { [K in keyof StoreEvents]: Set<EventHandler<K>> } = {
    message_added: new Set(),
    message_queued: new Set(),
    message_token: new Set(),
    message_reasoning: new Set(),
    message_acp_content: new Set(),
    message_canvas_artefacts_changed: new Set(),
    message_visual_evidence_changed: new Set(),
    message_done: new Set(),
    tool_call_started: new Set(),
    tool_call_updated: new Set(),
    thread_model_resolved: new Set(),
    thread_status_changed: new Set(),
    agent_activity: new Set(),
    threads_changed: new Set(),
    reviewer_input_open: new Set(),
    reviewer_input_jump: new Set(),
    thread_draft_changed: new Set(),
    new_thread_opened: new Set(),
    explorer_reveal: new Set(),
    workspace_changed: new Set(),
    projects_changed: new Set(),
    git_change_navigate: new Set(),
    roadmap_reveal: new Set(),
    thread_plan_open: new Set(),
    thread_plan_changed: new Set(),
    browser_url_requested: new Set(),
    browser_url_bar_focus_requested: new Set(),
    pr_open_requested: new Set(),
    thread_archive_requested: new Set(),
    side_chat_open_requested: new Set(),
    canvas_artefact_requested: new Set(),
    canvas_artefact_show_requested: new Set(),
    settings_changed: new Set(),
    usage_updated: new Set(),
    context_updated: new Set(),
    todos_changed: new Set(),
    review_changed: new Set(),
    hook_card_added: new Set(),
    comparison_changed: new Set(),
    review_report_changed: new Set(),
    git_branch_changed: new Set(),
    thread_checkout_changed: new Set(),
    composer_draft_flush: new Set(),
    agent_task_selected: new Set(),
    shell_tab_activated: new Set(),
    request_terminal_command: new Set(),
    code_block_run_requested: new Set(),
    code_block_run_finished: new Set(),
    thread_reference_attach: new Set(),
    attention_changed: new Set(),
    sidebar_threads_loaded: new Set(),
    automation_schedules_loaded: new Set(),
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

  const selections = new Set<() => void>()

  function select<T>(
    selector: (state: AppState) => T,
    listener: (next: T, prev: T) => void,
    equals: (a: T, b: T) => boolean = Object.is,
  ): Unsubscribe {
    let value = selector(state)
    const check = (): void => {
      const next = selector(state)
      const prev = value
      if (equals(prev, next)) return
      // Record before notifying so a listener that writes state again sees a
      // settled baseline and is not re-notified for the same change.
      value = next
      listener(next, prev)
    }
    selections.add(check)
    return () => {
      selections.delete(check)
    }
  }

  function setState(partial: Partial<AppState>): void {
    state = { ...state, ...partial }
    // Snapshot: a listener may subscribe or unsubscribe while we notify.
    for (const check of [...selections]) {
      if (selections.has(check)) check()
    }
  }

  return { getState: () => state, setState, on, emit, select }
}
