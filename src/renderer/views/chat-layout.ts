import type { AppStore } from '@shared/store/store.ts'
import { needsHydration } from '../controller/thread-hydration.ts'

/**
 * No messages *and* nothing still to load. A thread selected metadata-first has
 * `messages: []` until its transcript arrives; calling that empty would flash the
 * new-thread screen over a conversation that is about to appear, and would cover
 * the "Couldn't load the conversation" notice if the read fails.
 */
function isActiveThreadEmpty(store: AppStore): boolean {
  const { activeThreadId, threads } = store.getState()
  if (!activeThreadId) return false
  const thread = threads.find((t) => t.id === activeThreadId)
  return thread ? thread.messages.length === 0 && !needsHydration(thread) : false
}

/**
 * Pin #input-bar to the bottom of #pane-chat and inset #conversation so it cannot overlap.
 *
 * While the active thread has no messages the pane is the Activity home
 * (`.is-activity-home`): the composer stays docked and `onActivityHome` shows the
 * Activity view above it. Reported on every sync, so the callback must be idempotent.
 */
export function bindChatComposerLayout(
  store: AppStore,
  onActivityHome?: (shown: boolean) => void,
): () => void {
  const pane = document.getElementById('pane-chat')
  const input = document.getElementById('input-bar')
  const conversation = document.getElementById('conversation')
  if (!pane || !input || !conversation) return () => {}

  // The empty thread the composer was last focused for. Focus follows the user
  // into an empty thread once, never again on every store event: the Activity
  // list shares this pane, and a re-focus would pull the caret out of a row the
  // user is arrowing through.
  let focusedFor: string | null = null

  const sync = (): void => {
    const home = isActiveThreadEmpty(store)
    pane.classList.toggle('is-activity-home', home)
    onActivityHome?.(home)

    if (home) {
      const threadId = store.getState().activeThreadId
      if (threadId !== focusedFor) {
        focusedFor = threadId
        // The browser demo can be embedded high on another page. Taking focus
        // there focuses its iframe too, which scrolls the containing page back to
        // the demo while a visitor is reading further down.
        if (document.documentElement.dataset['demoEmbedded'] !== 'on') {
          const composer = input.querySelector<HTMLElement>('.prompt-input')
          composer?.focus({ preventScroll: true })
        }
      }
    } else {
      focusedFor = null
    }

    const height = Math.max(Math.ceil(input.getBoundingClientRect().height), 72)
    pane.style.setProperty('--chat-composer-height', `${String(height)}px`)
  }

  sync()
  requestAnimationFrame(sync)

  const observer = new ResizeObserver(sync)
  observer.observe(input)

  window.addEventListener('resize', sync, { passive: true })

  const unsubs = [store.on('threads_changed', sync), store.on('message_added', sync)]

  return () => {
    unsubs.forEach((u) => {
      u()
    })
    observer.disconnect()
    window.removeEventListener('resize', sync)
  }
}
