import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import { getThreadById, getActiveThread, setQueuePaused } from '@shared/store/thread-helpers.ts'
import { attachCodeBlockCopyButtons } from '../markdown/code-block-copy.ts'
import { renderMarkdown } from '../markdown/renderer.ts'
import { sanitizeRenderedMarkdown } from '../markdown/sanitize.ts'
import { renderMermaidIn } from '../markdown/mermaid.ts'
import { StreamingMarkdownRenderer } from '../markdown/streaming.ts'
import { annotateFileReferences, bindFileReferenceClicks } from '../markdown/file-links.ts'
import { bindBrowserLinkClicks } from '../markdown/browser-links.ts'
import { hydrateRemoteArtifactImages } from '../markdown/remote-artifact-images.ts'
import { stripTextToolCallBlocks } from '@shared/agent/parse-text-tool-calls.ts'
import type { Message, ToolCall } from '@shared/types'
import type { ApiClient } from '../../preload/api.d.ts'
import { agentActivityLabel } from '../agent-activity.ts'
import {
  aggregateToolStatus,
  buildToolCallDisplayItems,
  getToolCallLabel,
  type ToolCallDisplayItem,
} from '@shared/tools/tool-display.ts'
import { createTodoListEl } from './todo-panel.ts'
import { renderToolArgs } from './tool-args-format.ts'
import {
  drainMessageQueue,
  queuedMessageIds,
  queuedPayloadText,
  sendQueuedMessageNow,
  updateQueuedMessageText,
} from '../controller/message-queue.ts'

function statusIcon(status: ToolCall['status']): string {
  return status === 'done' ? '✓' : status === 'error' ? '✕' : '⋯'
}

function createToolArgsSection(args: unknown): HTMLDetailsElement {
  return el(
    'details',
    { class: 'tool-args' },
    el('summary', {}, 'Arguments'),
    el('pre', {}, renderToolArgs(args)),
  )
}

function createToolResultSection(result: string | null): HTMLElement {
  if (!result) return el('div', { class: 'tool-result' })
  return el('div', { class: 'tool-result' }, el('pre', {}, renderToolArgs(result)))
}

function createToolHeader(
  label: string,
  status: ToolCall['status'],
  summaryClass: string,
  count?: number,
  editStats?: ToolCall['editStats'],
): HTMLElement {
  const children: (Node | string)[] = [el('span', { class: 'tool-name' }, label)]
  if (editStats) {
    children.push(
      el('span', { class: 'tool-stat tool-stat-add' }, `+${editStats.additions}`),
      el('span', { class: 'tool-stat tool-stat-del' }, `-${editStats.deletions}`),
    )
  }
  if (count !== undefined && count > 1) {
    children.push(el('span', { class: 'tool-count' }, `×${count}`))
  }
  children.push(el('span', { class: 'tool-status-icon', 'aria-label': status }, statusIcon(status)))
  return el('summary', { class: summaryClass }, ...children)
}

function appendStandardToolSections(
  card: HTMLElement,
  tc: ToolCall,
  label: string,
  summaryClass: string,
  count?: number,
): void {
  card.append(
    createToolHeader(label, tc.status, summaryClass, count, tc.editStats),
    createToolArgsSection(tc.args),
    createToolResultSection(tc.result),
  )
}

function createIndividualToolCard(tc: ToolCall, label: string, api: ApiClient): HTMLElement {
  if (tc.subagent) return createSubagentToolCard(tc, label, api)

  const card = el('details', {
    class: 'tool-card',
    'data-tool-id': tc.id,
    'data-status': tc.status,
  })
  appendStandardToolSections(card, tc, label, 'tool-card-header')
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
  appendStandardToolSections(entry, tc, getToolCallLabel(tc), 'tool-group-item-header')
  return entry
}

// Per-message incremental renderers for the active streaming pass. Keyed by the
// `.message-text` element so re-entrant token events reuse the same DOM regions
// instead of rebuilding the whole message innerHTML each token (O(n²)).
const streamingRenderers = new WeakMap<HTMLElement, StreamingMarkdownRenderer>()

function setAssistantMarkdown(
  el: HTMLElement,
  content: string,
  streaming: boolean,
  api: ApiClient,
): void {
  const display = assistantDisplayText(content)
  if (streaming) {
    el.classList.add('is-streaming')
    let renderer = streamingRenderers.get(el)
    if (!renderer) {
      renderer = new StreamingMarkdownRenderer(el)
      streamingRenderers.set(el, renderer)
    }
    renderer.update(display)
    attachCodeBlockCopyButtons(el)
    return
  }
  // Final render: replace the incremental scaffold with the finished markdown.
  el.classList.remove('is-streaming')
  streamingRenderers.delete(el)
  el.innerHTML = sanitizeRenderedMarkdown(renderMarkdown(display))
  attachCodeBlockCopyButtons(el)
  void annotateFileReferences(el, api)
  hydrateRemoteArtifactImages(el, api)
  void renderMermaidIn(el)
}

function createSubagentMessageEl(content: string, streaming: boolean, api: ApiClient): HTMLElement {
  const textEl = el('div', { class: 'subagent-message subagent-message-assistant message-text' })
  setAssistantMarkdown(textEl, content, streaming, api)
  return textEl
}

function createSubagentToolCard(tc: ToolCall, label: string, api: ApiClient): HTMLElement {
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
    const previewEl = el('div', { class: 'subagent-summary-preview message-text' })
    setAssistantMarkdown(previewEl, summaryPreview(preview), false, api)
    card.append(previewEl)
  }

  card.append(createToolArgsSection(tc.args))

  const timeline = el('div', { class: 'subagent-timeline' })
  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i]
    if (!msg) continue
    if (msg.content.trim()) {
      const isLast = i === session.messages.length - 1
      timeline.append(createSubagentMessageEl(msg.content, status === 'running' && isLast, api))
    }
    if ((msg.toolCalls ?? []).length > 0) {
      const toolsWrap = el('div', { class: 'subagent-inner-tools' })
      for (const inner of msg.toolCalls ?? []) {
        toolsWrap.append(createInnerToolCard(inner))
      }
      timeline.append(toolsWrap)
    }
  }
  card.append(timeline)

  if (tc.result && status === 'done') {
    const resultEl = el('div', {
      class: 'subagent-parent-result subagent-message subagent-message-assistant message-text',
    })
    setAssistantMarkdown(resultEl, tc.result, false, api)
    card.append(resultEl)
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
      createToolHeader(
        getToolCallLabel(tc),
        tc.status,
        'tool-group-item-header',
        undefined,
        tc.editStats,
      ),
      createToolArgsSection(tc.args),
      createToolResultSection(tc.result),
    )
    groupItems.append(entry)
  }

  return card
}

function createToolCard(item: ToolCallDisplayItem, api: ApiClient): HTMLElement {
  if (item.type === 'group') return createGroupToolCard(item)
  return createIndividualToolCard(item.toolCall, item.label, api)
}

function createMessageImages(images: string[]): HTMLElement {
  const wrap = el('div', { class: 'message-images' })
  for (const dataUrl of images) {
    wrap.append(
      el('img', {
        class: 'message-image',
        src: dataUrl,
        alt: 'Attached image',
        loading: 'lazy',
      }),
    )
  }
  return wrap
}

function appendMessageContent(
  body: HTMLElement,
  msg: { role: string; content: string; images?: string[] },
  api: ApiClient,
) {
  if (msg.role === 'user' && msg.images?.length) {
    body.append(createMessageImages(msg.images))
  }
  const textEl = el('div', { class: 'message-text' })
  if (msg.role === 'assistant' && msg.content) {
    setAssistantMarkdown(textEl, msg.content, false, api)
  } else {
    textEl.textContent = msg.content
  }
  body.append(textEl)
}

const SCROLL_PIN_THRESHOLD_PX = 48
/** Ignore auto-scroll briefly after the user scrolls up during streaming. */
const USER_SCROLL_UP_DEBOUNCE_MS = 150

export function mountConversation(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  const scrollArea = el('div', { class: 'conversation-scroll' })
  const todoHost = el('div', { class: 'conversation-todos-host' })
  const list = el('div', { class: 'messages-list', role: 'log', 'aria-live': 'polite' })
  const scrollToBottomBtn = el(
    'button',
    {
      class: 'scroll-to-bottom',
      type: 'button',
      'aria-label': 'Scroll to bottom',
      hidden: true,
    },
    '↓',
  )
  scrollArea.append(todoHost, list, scrollToBottomBtn)

  const activityBar = el('div', { class: 'agent-activity', role: 'status', 'aria-live': 'polite' })
  const activityLabel = el('span', { class: 'agent-activity-label' })
  activityBar.append(
    el('span', { class: 'agent-activity-pulse', 'aria-hidden': 'true' }),
    activityLabel,
  )
  // Queued follow-ups live in a pinned panel below the scroll area so they stay
  // visible at the bottom of the screen instead of getting buried under the
  // streaming response inside the scrollable message list.
  const queuedHost = el('div', { class: 'conversation-queued', hidden: true })
  root.append(scrollArea, queuedHost, activityBar)

  // Inline-edit state for a queued message. Preserved across re-renders so a
  // store-driven rebuild (e.g. pause toggle) keeps the editor and its draft.
  let editingMessageId: string | null = null
  let editingDraft = ''

  function startEditing(messageId: string) {
    const threadId = store.getState().activeThreadId
    if (!threadId) return
    const thread = store.getState().threads.find((t) => t.id === threadId)
    const item = thread?.pendingMessages?.find((p) => p.messageId === messageId)
    if (!item) return
    editingMessageId = messageId
    editingDraft = queuedPayloadText(item.payload)
    // Pausing emits threads_changed, which re-renders this message in edit mode.
    setQueuePaused(store, threadId, true)
  }

  function stopEditing() {
    editingMessageId = null
    editingDraft = ''
  }

  function cancelEditing() {
    const threadId = store.getState().activeThreadId
    stopEditing()
    if (!threadId) return
    setQueuePaused(store, threadId, false)
    drainMessageQueue(store, api, threadId)
  }

  function saveEditing(messageId: string, sendNow: boolean) {
    const threadId = store.getState().activeThreadId
    if (!threadId) return
    const text = editingDraft.trim()
    stopEditing()
    if (text) updateQueuedMessageText(store, threadId, messageId, text)
    setQueuePaused(store, threadId, false)
    if (sendNow) sendQueuedMessageNow(store, api, threadId, messageId)
    else drainMessageQueue(store, api, threadId)
  }

  function buildQueuedActions(messageId: string): HTMLElement {
    const editBtn = el('button', { class: 'queued-action queued-edit', type: 'button' }, 'Edit')
    editBtn.addEventListener('click', () => startEditing(messageId))
    const sendNowBtn = el(
      'button',
      { class: 'queued-action queued-send-now', type: 'button' },
      'Send now',
    )
    sendNowBtn.addEventListener('click', () => {
      const threadId = store.getState().activeThreadId
      if (threadId) sendQueuedMessageNow(store, api, threadId, messageId)
    })
    return el(
      'div',
      { class: 'message-queued-ui' },
      el('div', { class: 'message-queued-actions' }, editBtn, sendNowBtn),
    )
  }

  function buildQueuedEditor(messageId: string): HTMLElement {
    const input = el('textarea', {
      class: 'message-edit-input',
      rows: '3',
      'aria-label': 'Edit queued message',
    })
    input.value = editingDraft
    input.addEventListener('input', () => {
      editingDraft = input.value
    })
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelEditing()
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        saveEditing(messageId, false)
      }
    })
    const sendBtn = el('button', { class: 'queued-action queued-send', type: 'button' }, 'Send')
    sendBtn.addEventListener('click', () => saveEditing(messageId, false))
    const sendNowBtn = el(
      'button',
      { class: 'queued-action queued-send-now', type: 'button' },
      'Send now',
    )
    sendNowBtn.addEventListener('click', () => saveEditing(messageId, true))
    const cancelBtn = el(
      'button',
      { class: 'queued-action queued-cancel', type: 'button' },
      'Cancel',
    )
    cancelBtn.addEventListener('click', () => cancelEditing())
    const wrap = el(
      'div',
      { class: 'message-queued-ui' },
      input,
      el('div', { class: 'message-queued-actions' }, sendBtn, sendNowBtn, cancelBtn),
    )
    requestAnimationFrame(() => {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    })
    return wrap
  }

  function createQueuedItem(msg: Message): HTMLElement {
    const editing = editingMessageId === msg.id
    const item = el('div', {
      class: editing ? 'msg msg-user msg-queued msg-editing' : 'msg msg-user msg-queued',
      'data-message-id': msg.id,
    })
    const body = el('div', { class: 'message-body' })
    body.append(el('span', { class: 'message-queued-badge' }, editing ? 'Editing' : 'Queued'))
    if (editing) {
      body.append(buildQueuedEditor(msg.id))
    } else {
      appendMessageContent(body, msg, api)
      body.append(buildQueuedActions(msg.id))
    }
    item.append(body)
    return item
  }

  function renderQueuedPanel(threadId: string) {
    if (threadId !== store.getState().activeThreadId) return
    const thread = store.getState().threads.find((t) => t.id === threadId)
    const pending = thread?.pendingMessages ?? []
    // Drop stale edit state if the edited message is no longer queued.
    if (editingMessageId && !pending.some((p) => p.messageId === editingMessageId)) {
      stopEditing()
    }
    queuedHost.replaceChildren()
    if (!thread || pending.length === 0) {
      queuedHost.hidden = true
      return
    }
    const messagesById = new Map(thread.messages.map((m) => [m.id, m]))
    for (const item of pending) {
      const msg = messagesById.get(item.messageId)
      if (!msg || msg.role !== 'user') continue
      queuedHost.append(createQueuedItem(msg))
    }
    queuedHost.hidden = queuedHost.childElementCount === 0
  }

  let pinnedToBottom = true
  let lastScrollTop = 0
  let suppressScrollPinUpdate = false
  let userScrolledUpAt = 0

  function isNearBottom(): boolean {
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight
    return distance <= SCROLL_PIN_THRESHOLD_PX
  }

  function shouldAutoScroll(): boolean {
    return pinnedToBottom && Date.now() - userScrolledUpAt > USER_SCROLL_UP_DEBOUNCE_MS
  }

  function updateScrollButton() {
    scrollToBottomBtn.hidden = isNearBottom()
  }

  function handleUserScroll() {
    if (suppressScrollPinUpdate) return

    const scrollTop = list.scrollTop
    if (scrollTop < lastScrollTop - 1) {
      userScrolledUpAt = Date.now()
      pinnedToBottom = false
    } else if (isNearBottom()) {
      pinnedToBottom = true
    }
    lastScrollTop = scrollTop
    updateScrollButton()
  }

  list.addEventListener('scroll', handleUserScroll, { passive: true })
  list.addEventListener(
    'wheel',
    (event) => {
      if (event.deltaY < 0) {
        userScrolledUpAt = Date.now()
        pinnedToBottom = false
        updateScrollButton()
      }
    },
    { passive: true },
  )
  scrollToBottomBtn.addEventListener('click', () => {
    userScrolledUpAt = 0
    scrollToBottom(true)
  })

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
    const thread = getThreadById(store, tid)
    // Writing state lives in the agent controller; agent_activity events carry the label.
    setActivity(agentActivityLabel(thread, false))
  }

  function scrollToBottom(force = false) {
    if (!force && !shouldAutoScroll()) return
    // The scrollable element is the messages list, not the mount root.
    suppressScrollPinUpdate = true
    list.scrollTop = list.scrollHeight
    lastScrollTop = list.scrollTop
    requestAnimationFrame(() => {
      suppressScrollPinUpdate = false
    })
    if (force) {
      userScrolledUpAt = 0
      pinnedToBottom = true
    }
    updateScrollButton()
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
      const card = createToolCard(item, api) as HTMLDetailsElement
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
    const thread = getThreadById(store, threadId)
    const msg = thread?.messages.find((m) => m.id === msgId)
    if (!msg) return

    // Queued user follow-ups render in the pinned panel, not inline.
    if (msg.role === 'user' && thread && queuedMessageIds(thread).has(msgId)) {
      renderQueuedPanel(threadId)
      return
    }

    const msgEl = el('div', { class: `msg msg-${msg.role}`, 'data-message-id': msgId })
    const body = el('div', { class: 'message-body' })
    appendMessageContent(body, msg, api)
    msgEl.append(body)

    // Copy only when there is reply text — tool-only bubbles stay compact.
    if (msg.role === 'assistant' && msg.content.trim()) {
      attachCopyButton(body, msgId, store)
    }

    list.append(msgEl)
    hydrateRemoteArtifactImages(list, api)
    // Re-render any tool cards this message already carries (restored threads).
    renderToolCards(msgEl, msg.toolCalls ?? [])
    scrollToBottom(msg.role === 'user')
  }

  function syncTodoPanel() {
    todoHost.replaceChildren()
    const thread = getActiveThread(store)
    if (thread?.todos?.length) {
      todoHost.append(createTodoListEl(thread.todos, { compact: true }))
    }
  }

  function rebuildForThread() {
    pinnedToBottom = true
    userScrolledUpAt = 0
    lastScrollTop = 0
    clear(list)
    const thread = getActiveThread(store)
    thread?.messages.forEach((m) => appendMessageEl(store.getState().activeThreadId!, m.id))
    syncTodoPanel()
    renderQueuedPanel(store.getState().activeThreadId!)
    updateScrollButton()
  }

  function refreshToolCards(msgId: string) {
    const msg = store
      .getState()
      .threads.flatMap((t) => t.messages)
      .find((m) => m.id === msgId)
    const msgEl = list.querySelector(`[data-message-id="${msgId}"]`)
    if (!msg || !msgEl) return
    renderToolCards(msgEl as HTMLElement, msg.toolCalls ?? [])
    scrollToBottom()
  }

  const unsubs = [
    store.on('message_added', (tid, mid) => appendMessageEl(tid, mid)),
    store.on('message_queued', (tid) => renderQueuedPanel(tid)),
    store.on('message_token', (mid) => {
      const thread = getActiveThread(store)
      const msg = thread?.messages.find((m) => m.id === mid)
      const textEl = list.querySelector(`[data-message-id="${mid}"] .message-text`)
      if (textEl && msg?.role === 'assistant') {
        setAssistantMarkdown(textEl as HTMLElement, msg.content, true, api)
        scrollToBottom()
      }
    }),
    store.on('message_done', (mid) => {
      const msgEl = list.querySelector(`[data-message-id="${mid}"]`)
      const textEl = msgEl?.querySelector('.message-text')
      const thread = getActiveThread(store)
      const msg = thread?.messages.find((m) => m.id === mid)
      if (textEl && msg?.role === 'assistant') {
        setAssistantMarkdown(textEl as HTMLElement, msg.content, false, api)
        hydrateRemoteArtifactImages(list, api)
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
    store.on('todos_changed', () => {
      syncTodoPanel()
      syncFromStore()
      scrollToBottom()
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

  const unbindFileLinks = bindFileReferenceClicks(root, store, api)
  const unbindBrowserLinks = bindBrowserLinkClicks(root, store, api)
  rebuildForThread()
  syncFromStore()
  return () => {
    unbindFileLinks()
    unbindBrowserLinks()
    unsubs.forEach((u) => u())
  }
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
