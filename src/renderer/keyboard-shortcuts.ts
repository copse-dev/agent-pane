import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../preload/api.d.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { openNewThread } from '@shared/store/thread-helpers.ts'
import { openRightPanelWithWorkspace, toggleFilesPaneWithWorkspace } from './controller/panels.ts'

type KeyboardShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>

export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || !('tagName' in target) || typeof target.tagName !== 'string') return false
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return true
  return 'isContentEditable' in target && target.isContentEditable === true
}

/** Cmd/Ctrl+N starts a new thread, matching the File ▸ New Thread menu item. */
export function matchNewThreadShortcut(e: KeyboardShortcutEvent): boolean {
  const meta = e.ctrlKey || e.metaKey
  if (!meta || e.altKey || e.shiftKey) return false
  return e.key === 'n' || e.key === 'N'
}

/** Cmd/Ctrl+F opens the in-conversation find bar (find-in-page for the chat). */
export function matchFindInChatShortcut(e: KeyboardShortcutEvent): boolean {
  const meta = e.ctrlKey || e.metaKey
  if (!meta || e.altKey || e.shiftKey) return false
  return e.key === 'f' || e.key === 'F'
}

/** Result of matching Cmd/Ctrl++/−/0 interface-scale shortcuts. */
export type UiScaleShortcutAction = 'in' | 'out' | 'reset'

/**
 * Cmd/Ctrl+= (or +) zooms the interface in, Cmd/Ctrl+- zooms out, Cmd/Ctrl+0
 * resets. These replace Chromium page-zoom roles so scale stays crisp via
 * `--ui-scale` (see `src/shared/ui-scale.ts`).
 */
export function matchUiScaleShortcut(e: KeyboardShortcutEvent): UiScaleShortcutAction | null {
  const meta = e.ctrlKey || e.metaKey
  if (!meta || e.altKey || e.shiftKey) return null
  if (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0') return 'reset'
  if (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd') return 'in'
  if (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract') {
    return 'out'
  }
  return null
}

/** Cmd/Ctrl+Shift+K opens the command palette ("filter all the things"). */
export function matchCommandPaletteShortcut(e: KeyboardShortcutEvent): boolean {
  const meta = e.ctrlKey || e.metaKey
  if (!meta || e.altKey || !e.shiftKey) return false
  return e.key === 'k' || e.key === 'K'
}

export type PanelShortcutAction = 'togglePanel' | { openPanel: RightPanelMode }

export function matchPanelShortcut(e: KeyboardShortcutEvent): PanelShortcutAction | null {
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
