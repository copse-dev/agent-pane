import type { ApiClient } from '../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getActiveThread } from '@shared/store/thread-helpers.ts'
import { createChatComposer } from './chat-composer.ts'
import { mountNextStepHint } from './next-step-hint.ts'
import { el } from '../dom/helpers.ts'

export interface ChatTransport {
  send(projectId: string, threadId: string, text: string): Promise<void>
  stop(projectId: string, threadId: string): Promise<void>
  connected(): boolean
}

/** Replica orchestration around the desktop's editor, buttons and hint controller. */
export function mountRemoteComposer(
  root: HTMLElement,
  store: AppStore,
  api: ApiClient,
  transport: ChatTransport,
): {
  handleStopShortcut(key: 'Escape' | 'Enter', target?: EventTarget | null): boolean
  openModelPicker(): void
  unmount(): void
} {
  const { composer, submitBtn, stopBtn } = createChatComposer()
  const actions = el('div', { class: 'submit-row' }, stopBtn, submitBtn)
  const row = el('div', { class: 'input-row' }, composer.el, actions)
  const error = el('p', { class: 'remote-send-error', role: 'alert', hidden: true })
  const accept = el('button', { class: 'remote-next-step', type: 'button', hidden: true })
  root.replaceChildren(accept, error, row)
  const drafts = new Map<string, string>()
  let activeId: string | null = null
  let busy = false
  let disposed = false
  const hint = mountNextStepHint(store, api, refreshHint)

  function refreshHint(): void {
    const text = hint.current()
    composer.setPlaceholder(text ?? 'Message…')
    composer.el.toggleAttribute('data-next-step', text !== null)
    accept.hidden = text === null || Boolean(composer.value.trim())
    accept.textContent = text === null ? '' : `Use suggested next prompt: ${text}`
  }

  function sync(): void {
    const thread = getActiveThread(store)
    if (thread?.id !== activeId) {
      if (activeId) drafts.set(activeId, composer.draftValue())
      activeId = thread?.id ?? null
      composer.value = activeId ? (drafts.get(activeId) ?? '') : ''
    }
    const connected = transport.connected()
    submitBtn.disabled = busy || !activeId || !connected
    submitBtn.textContent = busy ? 'Sending…' : thread?.status === 'running' ? 'Queue' : 'Send'
    stopBtn.hidden = thread?.status !== 'running'
    stopBtn.disabled = busy || !connected
    composer.el.setAttribute('aria-label', 'Message')
    refreshHint()
  }

  async function send(): Promise<void> {
    const threadId = activeId
    const projectId = store.getState().activeProjectId
    const text = composer.expandedValue().trim()
    if (busy || !threadId || !projectId || !text || !transport.connected()) return
    busy = true
    error.hidden = true
    sync()
    try {
      await transport.send(projectId, threadId, text)
      drafts.delete(threadId)
      if (activeId === threadId && composer.expandedValue().trim() === text) composer.clear()
      if (activeId === threadId) hint.clear()
    } catch (cause) {
      if (!disposed) {
        error.textContent =
          cause instanceof Error ? cause.message : 'Could not send. Your draft is kept.'
        error.hidden = false
      }
    } finally {
      busy = false
      if (!disposed) sync()
    }
  }
  async function stop(): Promise<void> {
    const projectId = store.getState().activeProjectId
    if (!projectId || !activeId || !transport.connected()) return
    try {
      await transport.stop(projectId, activeId)
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : 'Could not stop the run.'
      error.hidden = false
    }
  }
  function acceptHint(): void {
    const text = hint.current()
    if (!text || composer.value.trim()) return
    composer.value = text
    hint.clear()
    composer.focus()
    refreshHint()
  }
  accept.onclick = acceptHint
  submitBtn.onclick = (): void => {
    void send()
  }
  stopBtn.onclick = (): void => {
    void stop()
  }
  composer.el.addEventListener('input', refreshHint)
  composer.el.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (
      event.key === 'Tab' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      hint.current() &&
      !composer.value.trim()
    ) {
      event.preventDefault()
      acceptHint()
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  })
  const off = [store.on('threads_changed', sync), store.on('thread_status_changed', sync)]
  sync()
  return {
    handleStopShortcut: (): boolean => false,
    openModelPicker: (): void => {},
    unmount(): void {
      disposed = true
      hint.destroy()
      for (const unsubscribe of off) unsubscribe()
      root.replaceChildren()
    },
  }
}
