import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../preload/api.d.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { openNewThread } from '@shared/store/thread-helpers.ts'
import { openRightPanelWithWorkspace, toggleFilesPaneWithWorkspace } from './controller/panels.ts'

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as { tagName?: string; isContentEditable?: boolean }
  if (!('tagName' in el) || typeof el.tagName !== 'string') return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

/** Cmd/Ctrl+N starts a new thread, matching the File ▸ New Thread menu item. */
export function matchNewThreadShortcut(e: KeyboardEvent): boolean {
  const meta = e.ctrlKey || e.metaKey
  if (!meta || e.altKey || e.shiftKey) return false
  return e.key === 'n' || e.key === 'N'
}

/** Cmd/Ctrl+F opens the in-conversation find bar (find-in-page for the chat). */
export function matchFindInChatShortcut(e: KeyboardEvent): boolean {
  const meta = e.ctrlKey || e.metaKey
  if (!meta || e.altKey || e.shiftKey) return false
  return e.key === 'f' || e.key === 'F'
}

export type PanelShortcutAction = 'togglePanel' | { openPanel: RightPanelMode }

export function matchPanelShortcut(e: KeyboardEvent): PanelShortcutAction | null {
  const meta = e.ctrlKey || e.metaKey
  if (!meta || e.altKey) return null

  if (!e.shiftKey && (e.key === 'b' || e.key === 'B')) return 'togglePanel'
  if (!e.shiftKey && (e.key === 'j' || e.key === 'J')) return 'togglePanel'
  if (e.shiftKey && (e.key === 'e' || e.key === 'E')) return { openPanel: 'explorer' }
  if (e.shiftKey && (e.key === 'g' || e.key === 'G')) return { openPanel: 'changes' }
  if (e.shiftKey && (e.key === 'b' || e.key === 'B')) return { openPanel: 'browser' }
  if (!e.shiftKey && (e.key === '`' || e.code === 'Backquote')) return { openPanel: 'terminal' }

  return null
}

export function handlePanelShortcut(
  store: AppStore,
  api: ApiClient,
  action: PanelShortcutAction,
): void {
  if (action === 'togglePanel') {
    toggleFilesPaneWithWorkspace(store, api)
    return
  }
  openRightPanelWithWorkspace(store, api, action.openPanel)
}

export function registerPanelKeyboardShortcuts(store: AppStore, api: ApiClient): void {
  document.addEventListener('keydown', (e) => {
    // New thread fires even from the composer, so it's checked before the
    // typing-target guard that the panel chords skip on.
    if (matchNewThreadShortcut(e)) {
      if (!store.getState().workspaceRoot) return
      e.preventDefault()
      openNewThread(store)
      return
    }
    if (isTypingTarget(e.target)) return
    const action = matchPanelShortcut(e)
    if (!action) return
    e.preventDefault()
    handlePanelShortcut(store, api, action)
  })
}
