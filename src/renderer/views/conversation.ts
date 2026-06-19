import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import { renderMarkdown } from '../markdown/renderer.ts'
import type { ToolCall } from '@shared/types'

export function mountConversation(root: HTMLElement, store: AppStore): () => void {
  const list = el('div', { class: 'messages-list', role: 'log', 'aria-live': 'polite' })
  root.append(list)

  function scrollToBottom() {
    // The scrollable element is the messages list, not the mount root.
    list.scrollTop = list.scrollHeight
  }

  function appendMessageEl(threadId: string, msgId: string) {
    if (threadId !== store.getState().activeThreadId) return
    const thread = store.getState().threads.find((t) => t.id === threadId)
    const msg = thread?.messages.find((m) => m.id === msgId)
    if (!msg) return

    const msgEl = el('div', { class: `msg msg-${msg.role}`, 'data-message-id': msgId })
    const textEl = el('p', { class: 'message-text' })
    // Assistant text that already has content (e.g. restored from disk) is
    // rendered as markdown immediately. Live-streamed messages start empty and
    // get markdown-rendered on the message_done event instead.
    if (msg.role === 'assistant' && msg.content) {
      textEl.innerHTML = renderMarkdown(msg.content)
    } else {
      textEl.textContent = msg.content
    }
    msgEl.append(textEl)

    // Copy button for assistant replies — copies the raw text.
    if (msg.role === 'assistant') {
      const copyBtn = el('button', { class: 'msg-copy', 'aria-label': 'Copy response' }, 'Copy')
      copyBtn.addEventListener('click', () => {
        const current = store
          .getState()
          .threads.flatMap((t) => t.messages)
          .find((m) => m.id === msgId)
        void navigator.clipboard.writeText(current?.content ?? '').then(() => {
          copyBtn.textContent = 'Copied'
          setTimeout(() => (copyBtn.textContent = 'Copy'), 1200)
        })
      })
      msgEl.append(copyBtn)
    }

    list.append(msgEl)
    // Re-render any tool cards this message already carries (restored threads).
    msg.toolCalls.forEach((tc) => appendToolCard(msgId, tc))
    scrollToBottom()
  }

  function rebuildForThread() {
    clear(list)
    const thread = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
    thread?.messages.forEach((m) => appendMessageEl(store.getState().activeThreadId!, m.id))
  }

  const unsubs = [
    store.on('message_added', (tid, mid) => appendMessageEl(tid, mid)),
    store.on('message_token', (mid, text) => {
      const el = list.querySelector(`[data-message-id="${mid}"] .message-text`)
      if (el) {
        el.textContent = (el.textContent ?? '') + text
        scrollToBottom()
      }
    }),
    store.on('message_done', (mid) => {
      const textEl = list.querySelector(`[data-message-id="${mid}"] .message-text`)
      if (textEl) textEl.innerHTML = renderMarkdown(textEl.textContent ?? '')
    }),
    store.on('tool_call_started', (mid, tc) => appendToolCard(mid, tc)),
    store.on('tool_call_updated', (mid, tcId) => updateToolCard(mid, tcId)),
    store.on('threads_changed', () => rebuildForThread()),
  ]

  function appendToolCard(msgId: string, tc: ToolCall) {
    const msgEl = list.querySelector(`[data-message-id="${msgId}"]`)
    if (!msgEl) return
    const icon = tc.status === 'done' ? '✓' : tc.status === 'error' ? '✕' : '⋯'
    // The whole card is a <details>, collapsed by default, so a turn full of
    // tool calls stays compact and the final answer is easy to reach.
    const card = el('details', {
      class: 'tool-card',
      'data-tool-id': tc.id,
      'data-status': tc.status,
    })
    card.innerHTML = `
      <summary class="tool-card-header">
        <span class="tool-name">${tc.name}</span>
        <span class="tool-status-icon" aria-label="${tc.status}">${icon}</span>
      </summary>
      <details class="tool-args">
        <summary>Arguments</summary>
        <pre>${JSON.stringify(tc.args, null, 2)}</pre>
      </details>
      <div class="tool-result"></div>
    `
    if (tc.result) {
      const resultEl = card.querySelector('.tool-result')
      if (resultEl) resultEl.textContent = tc.result
    }
    msgEl.append(card)
    scrollToBottom()
  }

  function updateToolCard(msgId: string, tcId: string) {
    const msg = store
      .getState()
      .threads.flatMap((t) => t.messages)
      .find((m) => m.id === msgId)
    const tc = msg?.toolCalls.find((c) => c.id === tcId)
    if (!tc) return
    const card = list.querySelector(`[data-tool-id="${tcId}"]`) as HTMLElement | null
    if (!card) return
    card.dataset.status = tc.status
    const icon = card.querySelector('.tool-status-icon')
    if (icon) icon.textContent = tc.status === 'done' ? '✓' : tc.status === 'error' ? '✕' : '⋯'
    const resultEl = card.querySelector('.tool-result')
    if (resultEl && tc.result) resultEl.textContent = tc.result
  }

  rebuildForThread()
  return () => unsubs.forEach((u) => u())
}
