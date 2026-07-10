import type { AppStore } from '@shared/store/store.ts'

function isActiveThreadEmpty(store: AppStore): boolean {
  const { activeThreadId, threads } = store.getState()
  if (!activeThreadId) return false
  const thread = threads.find((t) => t.id === activeThreadId)
  return thread ? thread.messages.length === 0 : false
}

/** Pin #input-bar to the bottom of #pane-chat and inset #conversation so it cannot overlap. */
export function bindChatComposerLayout(store: AppStore): () => void {
  const pane = document.getElementById('pane-chat')
  const input = document.getElementById('input-bar')
  const conversation = document.getElementById('conversation')
  if (!pane || !input || !conversation) return () => {}

  const sync = (): void => {
    const centered = isActiveThreadEmpty(store)
    pane.classList.toggle('composer-centered', centered)

    if (centered) {
      pane.style.setProperty('--chat-composer-height', '0px')
      const composer = input.querySelector<HTMLElement>('.prompt-input')
      composer?.focus()
      return
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
