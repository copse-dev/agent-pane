import type { BackgroundThread, Thread } from '@shared/types'
import type { AppStore } from '@shared/store/store.ts'

export const AUTOMATION_ACTIVE_ATTRIBUTE = 'data-automation-active'

export interface AutomationAppearanceApi {
  setAutomationMode(active: boolean): Promise<void>
}

export function hasRunningAutomation(
  threads: readonly Thread[],
  backgroundThreads: readonly BackgroundThread[],
): boolean {
  return [...threads, ...backgroundThreads.map(({ thread }) => thread)].some(
    (thread) => thread.automation !== undefined && thread.status === 'running',
  )
}

/**
 * Reflect whether a scheduled run is live in the transient document theme and
 * native app icon. The user’s saved appearance remains the source of truth once
 * the last automation settles.
 */
export function attachAutomationAppearance(
  store: AppStore,
  api: AutomationAppearanceApi,
  root: HTMLElement = document.documentElement,
): () => void {
  let active: boolean | null = null

  const sync = (): void => {
    const state = store.getState()
    const next = hasRunningAutomation(state.threads, state.backgroundThreads)
    if (next === active) return
    active = next
    root.toggleAttribute(AUTOMATION_ACTIVE_ATTRIBUTE, next)
    void api.setAutomationMode(next).catch((error: unknown) => {
      console.error('[automations] Failed to apply transient appearance:', error)
    })
  }

  const unsubs = [
    store.on('thread_status_changed', sync),
    store.on('threads_changed', sync),
    store.on('workspace_changed', sync),
  ]
  sync()

  return () => {
    unsubs.forEach((unsubscribe) => {
      unsubscribe()
    })
    root.removeAttribute(AUTOMATION_ACTIVE_ATTRIBUTE)
    if (active === true) {
      void api.setAutomationMode(false).catch((error: unknown) => {
        console.error('[automations] Failed to restore the native app icon:', error)
      })
    }
  }
}
