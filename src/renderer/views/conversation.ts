import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import { renderMarkdown } from '../markdown/renderer.ts'
import { renderStreamingMarkdown } from '../markdown/streaming.ts'
import { stripTextToolCallBlocks } from '@shared/agent/parse-text-tool-calls.ts'
import type { ToolCall } from '@shared/types'
import { agentActivityLabel } from '../agent-activity.ts'
import {
  aggregateToolStatus,
  buildToolCallDisplayItems,
  getToolDisplayName,
  type ToolCallDisplayItem,
} from '@shared/tools/tool-display.ts'

function statusIcon(status: ToolCall['status']): string {
  return status === 'done' ? '✓' : status === 'error' ? '✕' : '⋯'
}

function renderToolArgs(args: unknown): string {
  return JSON.stringify(args, null, 2)
}

function createToolArgsSection(args: unknown): HTMLDetailsElement {
  return el(
    'details',
    { class: 'tool-args' },
    el('summary', {}, 'Arguments'),
    el('pre', {}, renderToolArgs(args)),
  )
}

function createToolHeader(
  label: string,
  status: ToolCall['status'],
  summaryClass: string,
  count?: number,
): HTMLElement {
  const children: (Node | string)[] = [el('span', { class: 'tool-name' }, label)]
  if (count !== undefined && count > 1) {
    children.push(el('span', { class: 'tool-count' }, `×${count}`))
  }
  children.push(el('span', { class: 'tool-status-icon', 'aria-label': status }, statusIcon(status)))
  return el('summary', { class: summaryClass }, ...children)
}

function createIndividualToolCard(tc: ToolCall, label: string): HTMLElement {
  if (tc.subagent) return createSubagentToolCard(tc, label)

  const card = el('details', {
    class: 'tool-card',
    'data-tool-id': tc.id,
    'data-status': tc.status,
  })
  card.append(
    createToolHeader(label, tc.status, 'tool-card-header'),
    createToolArgsSection(tc.args),
    el('div', { class: 'tool-result' }, ...(tc.result ? [tc.result] : [])),
  )
  return card
}

function assistantDisplayText(content: string): string {
  return stripTextToolCallBlocks(content)
}

function summaryPreview(text: string, max = 200): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

function createInnerToolCard(tc: ToolCall): HTMLElement {
  const entry = el('details', {
    class: 'tool-group-item subagent-inner-tool',
    'data-tool-id': tc.id,
    'data-status': tc.status,
  })
  entry.append(
    createToolHeader(getToolDisplayName(tc.name), tc.status, 'tool-group-item-header'),
    createToolArgsSection(tc.args),
    el('div', { class: 'tool-result' }, ...(tc.result ? [tc.result] : [])),
  )
  return entry
}

function createSubagentToolCard(tc: ToolCall, label: string): HTMLElement {
  const session = tc.subagent!
  const status =
    tc.status === 'running' || session.status === 'running'
      ? 'running'
      : session.status === 'error' || tc.status === 'error'
        ? 'error'
        : 'done'

  const card = el('details', {
    class: 'tool-card tool-card-subagent',
    'data-tool-id': tc.id,
    'data-status': status,
  })

  const preview = session.summary ?? tc.result ?? ''
  card.append(createToolHeader(label, status, 'tool-card-header'))

  if (preview && status !== 'running') {
    card.append(el('div', { class: 'subagent-summary-preview' }, summaryPreview(preview)))
  }

  card.append(createToolArgsSection(tc.args))

  const timeline = el('div', { class: 'subagent-timeline' })
  for (const msg of session.messages) {
    if (msg.content.trim()) {
      timeline.append(
        el('div', { class: 'subagent-message subagent-message-assistant' }, msg.content),
      )
    }
    if (msg.toolCalls.length > 0) {
      const toolsWrap = el('div', { class: 'subagent-inner-tools' })
      for (const inner of msg.toolCalls) {
        toolsWrap.append(createInnerToolCard(inner))
      }
      timeline.append(toolsWrap)
    }
  }
  card.append(timeline)

  if (tc.result && status === 'done') {
    card.append(el('div', { class: 'tool-result subagent-parent-result' }, tc.result))
  }

  return card
}

function createGroupToolCard(item: Extract<ToolCallDisplayItem, { type: 'group' }>): HTMLElement {
  const status = aggregateToolStatus(item.toolCalls)
  const card = el('details', {
    class: 'tool-card tool-card-group',
    'data-group-key': item.key,
    'data-status': status,
  })

  const count = item.toolCalls.length
  const groupItems = el('div', { class: 'tool-group-items' })
  card.append(createToolHeader(item.label, status, 'tool-card-header', count), groupItems)

  for (const tc of item.toolCalls) {
    const entry = el('details', {
      class: 'tool-group-item',
      'data-tool-id': tc.id,
      'data-status': tc.status,
    })
    entry.append(
      createToolHeader(getToolDisplayName(tc.name), tc.status, 'tool-group-item-header'),
      createToolArgsSection(tc.args),
      el('div', { class: 'tool-result' }, ...(tc.result ? [tc.result] : [])),
    )
    groupItems.append(entry)
  }

  return card
}

function createToolCard(item: ToolCallDisplayItem): HTMLElement {
  if (item.type === 'group') return createGroupToolCard(item)
  return createIndividualToolCard(item.toolCall, item.label)
}

export function mountConversation(root: HTMLElement, store: AppStore): () => void {
  const list = el('div', { class: 'messages-list', role: 'log', 'aria-live': 'polite' })
  const activityBar = el('div', { class: 'agent-activity', role: 'status', 'aria-live': 'polite' })
  const activityLabel = el('span', { class: 'agent-activity-label' })
  activityBar.append(
    el('span', { class: 'agent-activity-pulse', 'aria-hidden': 'true' }),
    activityLabel,
  )
  root.append(list, activityBar)

  function setActivity(label: string | null) {
    if (!label) {
      activityBar.hidden = true
      return
    }
    activityLabel.textContent = label
    activityBar.hidden = false
    scrollToBottom()
  }

  function syncFromStore() {
    const tid = store.getState().activeThreadId
    if (!tid) {
      setActivity(null)
      return
    }
    const thread = store.getState().threads.find((t) => t.id === tid)
    // Writing state lives in the agent controller; agent_activity events carry the label.
    setActivity(agentActivityLabel(thread, false))
  }

  function scrollToBottom() {
    // The scrollable element is the messages list, not the mount root.
    list.scrollTop = list.scrollHeight
  }

  function renderToolCards(msgEl: HTMLElement, toolCalls: ToolCall[]) {
    const userExpandedGroups = new Set<string>()
    msgEl.querySelectorAll('.tool-card-group[open]').forEach((node) => {
      const el = node as HTMLElement
      const key = el.dataset.groupKey
      // Running groups are auto-expanded; don't treat that as a user preference.
      if (key && el.dataset.status !== 'running') userExpandedGroups.add(key)
    })

    const userExpandedTools = new Set<string>()
    msgEl
      .querySelectorAll(
        '.tool-card[data-tool-id][open], .tool-group-item[open], .tool-card-subagent[open]',
      )
      .forEach((node) => {
        const id = (node as HTMLElement).dataset.toolId
        if (id) userExpandedTools.add(id)
      })

    msgEl.querySelectorAll('.tool-card').forEach((node) => node.remove())

    for (const item of buildToolCallDisplayItems(toolCalls)) {
      const card = createToolCard(item) as HTMLDetailsElement
      if (item.type === 'group') {
        const status = aggregateToolStatus(item.toolCalls)
        card.open = status === 'running' || userExpandedGroups.has(item.key)
      } else {
        const tc = item.toolCall
        const subStatus = tc.subagent?.status
        const running = tc.status === 'running' || subStatus === 'running'
        card.open = running || userExpandedTools.has(tc.id)
      }
      msgEl.append(card)
    }
  }

  function appendMessageEl(threadId: string, msgId: string) {
    if (threadId !== store.getState().activeThreadId) return
    const thread = store.getState().threads.find((t) => t.id === threadId)
    const msg = thread?.messages.find((m) => m.id === msgId)
    if (!msg) return

    const msgEl = el('div', { class: `msg msg-${msg.role}`, 'data-message-id': msgId })
    const textEl = el('div', { class: 'message-text' })
    // Assistant text that already has content (e.g. restored from disk) is
    // rendered as markdown immediately. Live-streamed messages start empty and
    // get markdown-rendered on the message_done event instead.
    if (msg.role === 'assistant' && msg.content) {
      textEl.innerHTML = renderMarkdown(assistantDisplayText(msg.content))
    } else {
      textEl.textContent = msg.content
    }

    const body = el('div', { class: 'message-body' })
    body.append(textEl)
    msgEl.append(body)

    // Copy only when there is reply text — tool-only bubbles stay compact.
    if (msg.role === 'assistant' && msg.content.trim()) {
      attachCopyButton(body, msgId, store)
    }

    list.append(msgEl)
    // Re-render any tool cards this message already carries (restored threads).
    renderToolCards(msgEl, msg.toolCalls)
    scrollToBottom()
  }

  function rebuildForThread() {
    clear(list)
    const thread = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
    thread?.messages.forEach((m) => appendMessageEl(store.getState().activeThreadId!, m.id))
  }

  function refreshToolCards(msgId: string) {
    const msg = store
      .getState()
      .threads.flatMap((t) => t.messages)
      .find((m) => m.id === msgId)
    const msgEl = list.querySelector(`[data-message-id="${msgId}"]`)
    if (!msg || !msgEl) return
    renderToolCards(msgEl as HTMLElement, msg.toolCalls)
    scrollToBottom()
  }

  const unsubs = [
    store.on('message_added', (tid, mid) => appendMessageEl(tid, mid)),
    store.on('message_token', (mid) => {
      const thread = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
      const msg = thread?.messages.find((m) => m.id === mid)
      const textEl = list.querySelector(`[data-message-id="${mid}"] .message-text`)
      if (textEl && msg?.role === 'assistant') {
        textEl.innerHTML = renderStreamingMarkdown(assistantDisplayText(msg.content))
        scrollToBottom()
      }
    }),
    store.on('message_done', (mid) => {
      const msgEl = list.querySelector(`[data-message-id="${mid}"]`)
      const textEl = msgEl?.querySelector('.message-text')
      const thread = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
      const msg = thread?.messages.find((m) => m.id === mid)
      if (textEl && msg?.role === 'assistant') {
        textEl.innerHTML = renderMarkdown(assistantDisplayText(msg.content))
      }
      if (msg?.role === 'assistant' && msg.content.trim()) {
        const body = msgEl?.querySelector('.message-body')
        if (body && !body.querySelector('.msg-copy'))
          attachCopyButton(body as HTMLElement, mid, store)
      }
    }),
    store.on('tool_call_started', (mid) => refreshToolCards(mid)),
    store.on('tool_call_updated', (mid) => refreshToolCards(mid)),
    store.on('threads_changed', () => {
      rebuildForThread()
      syncFromStore()
    }),
    store.on('thread_status_changed', (tid, status) => {
      if (tid !== store.getState().activeThreadId) return
      if (status !== 'running') setActivity(null)
    }),
    store.on('agent_activity', (tid, label) => {
      if (tid !== store.getState().activeThreadId) return
      setActivity(label)
    }),
  ]

  rebuildForThread()
  syncFromStore()
  return () => unsubs.forEach((u) => u())
}

function attachCopyButton(body: HTMLElement, msgId: string, store: AppStore) {
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
  body.append(copyBtn)
}
