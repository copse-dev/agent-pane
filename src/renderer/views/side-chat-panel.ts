import { el, clear } from '../dom/helpers.ts'
import { patchChildren } from '../dom/patch-children.ts'
import { plusIcon } from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Thread } from '@shared/types'
import {
  archiveThread,
  getActiveThread,
  markThreadRead,
  restoreThread,
} from '@shared/store/thread-helpers.ts'
import { excerptText, sideChatsOf, type SideChatRow } from '@shared/threads/side-chat.ts'
import { openRightPanel, selectRightPanelMode } from '../controller/panels.ts'
import { promoteSideChat, sendSideChatMessage, startSideChat } from '../controller/side-chat.ts'
import {
  ensureThreadMessages,
  hydrationFailed,
  showSideChatTranscript,
  needsHydration,
} from '../controller/thread-hydration.ts'
import { desktopMessageHost } from '../markdown/desktop-message-host.ts'
import { bindBrowserLinkClicks } from '../markdown/browser-links.ts'
import { bindFileReferenceClicks } from '../markdown/file-links.ts'
import {
  paintAssistantMarkdown,
  renderUserPromptMarkdown,
  type MessageMarkdownHost,
} from '../markdown/message-markdown.ts'
import { bindWorkspaceLinkClicks } from '../markdown/workspace-links.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { showToast } from './toast.ts'

/**
 * The Side chat panel (prototype #3538): a side conversation shown beside the main
 * thread, without touching it. The list column holds the thread's side chats (the
 * prototype's chips); the viewer shows one with its read-only context line, its own
 * composer, and "Promote to thread". The main thread stays the active thread: the
 * panel drives the side chat through its own id.
 */

export const SIDE_CHAT_SUGGESTIONS: readonly string[] = [
  'Explain this in simpler terms',
  'What alternatives did you consider?',
  'Is this safe to merge?',
]

export interface SideChatSelection {
  /** The thread the side chats hang off (the open thread, or its parent). */
  mainId: string | null
  /** Active side chats first, archived after. */
  rows: SideChatRow[]
  /** The chat to show, or null when there is none. */
  selectedId: string | null
}

/**
 * Which side chat the panel shows. A remembered choice wins while it still exists
 * and is not archived; otherwise the first live side chat, then the first archived
 * one so an archived chat can still be read and restored.
 */
export function resolveSideChatSelection(
  threads: readonly Thread[],
  activeThreadId: string | null,
  remembered: ReadonlyMap<string, string>,
): SideChatSelection {
  const active = threads.find((thread) => thread.id === activeThreadId)
  const mainId = active ? (active.sideChat?.parentThreadId ?? active.id) : null
  if (mainId === null) return { mainId, rows: [], selectedId: null }
  const rows = sideChatsOf(threads, mainId, true).sort(
    (a, b) => Number(a.archived) - Number(b.archived),
  )
  const choice = remembered.get(mainId)
  const chosen = rows.find((row) => row.id === choice && !row.archived)
  const selected =
    chosen ?? rows.find((row) => !row.archived) ?? rows.find((row) => row.id === choice)
  // An active side chat (opened as the thread) is always the one shown.
  const own = active?.sideChat ? rows.find((row) => row.id === active.id) : undefined
  return { mainId, rows, selectedId: (own ?? selected ?? rows[0])?.id ?? null }
}

type ChatMessage = Thread['messages'][number]

/** A message's rendered node and the inputs it was painted from. */
interface RenderedMessage {
  node: HTMLElement
  role: ChatMessage['role']
  content: string
  streaming: boolean
  tools: string
}

/**
 * Rendered messages by id, kept by the pane across redraws. The pane redraws every
 * frame while a reply streams; reusing a node whose inputs have not changed keeps a
 * settled reply — its Mermaid frames, copy buttons and file links — painted once.
 */
export type SideChatMessageNodes = Map<string, RenderedMessage>

/**
 * One message, rendered exactly as the main conversation renders it: user prompts
 * and replies go through the shared message markdown (`message-markdown.ts`).
 */
function messageEl(
  message: ChatMessage,
  streaming: boolean,
  host: MessageMarkdownHost,
  nodes: SideChatMessageNodes | undefined,
): HTMLElement {
  const tools = message.toolCalls.map((call) => call.name).join('\n')
  const cached = nodes?.get(message.id)
  if (
    cached &&
    cached.role === message.role &&
    cached.content === message.content &&
    cached.streaming === streaming &&
    cached.tools === tools
  )
    return cached.node
  let node: HTMLElement
  if (message.role === 'user') {
    node = el('div', { class: 'side-chat-msg is-user message-text', 'data-role': 'user' })
    renderUserPromptMarkdown(node, message.content)
  } else if (message.role === 'error') {
    node = el('div', { class: 'side-chat-msg is-error', 'data-role': 'error' }, message.content)
  } else {
    // Keep the bubble across a stream's frames: the incremental renderer and its
    // pacing are keyed by this element, as in the main conversation.
    const reused = cached?.role === message.role ? cached.node : undefined
    node =
      reused ??
      el(
        'div',
        { class: 'side-chat-msg is-assistant', 'data-role': 'assistant' },
        el('div', { class: 'side-chat-msg-text message-text streaming-markdown' }),
        el('div', { class: 'side-chat-tools' }),
      )
    const text = node.querySelector<HTMLElement>('.side-chat-msg-text')
    const changed = cached?.content !== message.content || cached.streaming !== streaming
    if (text && (reused === undefined || changed))
      paintAssistantMarkdown(text, message.content, streaming, host)
    node
      .querySelector('.side-chat-tools')
      ?.replaceChildren(
        ...message.toolCalls.map((call) =>
          el('div', { class: 'side-chat-tool', 'data-tool': call.name }, call.name),
        ),
      )
  }
  nodes?.set(message.id, { node, role: message.role, content: message.content, streaming, tools })
  return node
}

/** Pure render of one side chat's header, context line and transcript. */
export function renderSideChat(input: {
  side: Thread
  parent: Thread | undefined
  onSuggestion: (text: string) => void
  onArchive: (archived: boolean) => void
  /** The transcript read failed; shown instead of a loading line that would never finish. */
  loadFailed?: boolean
  /** What only this surface can add to a message (the pane passes the desktop host). */
  host?: MessageMarkdownHost
  /** The pane's mounted transcript, patched in place so unchanged messages stay mounted. */
  body?: HTMLElement
  /** The pane's rendered messages, reused across redraws (see {@link SideChatMessageNodes}). */
  messageNodes?: SideChatMessageNodes
}): { header: HTMLElement; body: HTMLElement } {
  const { side, parent } = input
  const archived = side.archivedAt != null
  // Archiving only hides a side chat; it would not stop a run in progress, so a
  // running one is archived once it settles (as the thread archive refuses one).
  const archiveBlocked = !archived && side.status === 'running'
  const anchor = parent?.messages.find((m) => m.id === side.sideChat?.anchorMessageId)
  const header = el(
    'div',
    { class: 'side-chat-head' },
    el(
      'div',
      { class: 'side-chat-head-row' },
      el('span', { class: 'side-chat-title' }, side.title || 'Side chat'),
      side.model !== undefined
        ? el('span', { class: 'side-chat-chip side-chat-model' }, side.model)
        : '',
      el(
        'button',
        {
          type: 'button',
          class: 'side-chat-action',
          'data-action': archived ? 'restore-side-chat' : 'archive-side-chat',
          disabled: archiveBlocked ? true : undefined,
          title: archiveBlocked ? 'Wait for the side chat to finish before archiving' : undefined,
        },
        archived ? 'Restore' : 'Archive',
      ),
    ),
    el(
      'p',
      { class: 'side-chat-context', 'data-side-chat-context': '' },
      anchor
        ? `Reads the main thread up to “${excerptText(anchor.content)}”. Read-only.`
        : 'Reads the main thread up to where it branched. Read-only.',
    ),
  )
  header.querySelector('button')?.addEventListener('click', () => {
    if (!archiveBlocked) input.onArchive(archived)
  })

  const body = input.body ?? el('div', { class: 'side-chat-body' })
  const children: HTMLElement[] = []
  if (needsHydration(side)) {
    // After a restart the transcript is still on disk, so an empty `messages` here
    // means "not read yet", not "nothing was said"; suggestions would mislead.
    children.push(
      el(
        'div',
        { class: 'side-chat-empty', 'data-side-chat-loading': '' },
        el(
          'p',
          { role: 'status' },
          input.loadFailed === true ? 'Couldn’t load this side chat.' : 'Loading conversation…',
        ),
      ),
    )
  } else if (side.messages.length === 0) {
    // An archived side chat takes no new questions until it is restored, so it
    // offers no suggestions either (the composer is disabled for the same reason).
    children.push(
      el(
        'div',
        { class: 'side-chat-empty' },
        el(
          'p',
          {},
          archived
            ? 'This side chat is archived. Restore it to ask a question.'
            : 'Ask anything about this message without touching the main thread.',
        ),
        ...(archived ? [] : SIDE_CHAT_SUGGESTIONS).map((text) => {
          const button = el(
            'button',
            { type: 'button', class: 'side-chat-suggestion', 'data-suggestion': '' },
            text,
          )
          button.addEventListener('click', () => {
            input.onSuggestion(text)
          })
          return button
        }),
      ),
    )
  } else {
    const host = input.host ?? {}
    const last = side.messages.at(-1)
    for (const message of side.messages) {
      // Only the newest reply of a running chat is still arriving.
      const streaming =
        side.status === 'running' && message === last && message.role === 'assistant'
      children.push(messageEl(message, streaming, host, input.messageNodes))
    }
    // Drop nodes for messages this chat no longer has (or another chat's).
    const kept = new Set(side.messages.map((message) => message.id))
    for (const id of input.messageNodes?.keys() ?? []) {
      if (!kept.has(id)) input.messageNodes?.delete(id)
    }
  }
  if (side.status === 'running') {
    children.push(el('div', { class: 'side-chat-typing', role: 'status' }, 'Copse is thinking…'))
  }
  patchChildren(body, children)
  return { header, body }
}

/** Mount the Side chat pane: list column = this thread's side chats, viewer = one chat. */
export function mountSideChatPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const remembered = new Map<string, string>()

  const newButton = el(
    'button',
    {
      type: 'button',
      class: 'git-changes-refresh-btn side-chat-new-btn',
      'aria-label': 'New side chat',
      'data-tooltip': 'New side chat',
    },
    plusIcon('ui-icon ui-icon-sm'),
  )
  listRoot.append(
    el(
      'div',
      { class: 'pane-header' },
      el('span', { class: 'pane-header-title' }, 'Side chats'),
      panePopoutButton(store, api, 'side-chat', 'side chat'),
      paneMaximizeButton(store, 'side-chat'),
      newButton,
    ),
  )
  const list = el('div', { class: 'git-changes-list side-chat-list' })
  listRoot.append(list)

  // The viewer is built once so the composer keeps its text and focus across redraws.
  const headerHost = el('div', { class: 'side-chat-head-host' })
  const bodyHost = el('div', { class: 'side-chat-body-host' })
  const emptyState = el('div', { class: 'panel-empty side-chat-none' })
  const input = el('input', {
    type: 'text',
    class: 'side-chat-input',
    placeholder: 'Ask a side question…',
    autocomplete: 'off',
    'aria-label': 'Ask a side question',
  })
  const send = el(
    'button',
    { type: 'submit', class: 'ui-btn ui-btn-primary side-chat-send' },
    'Send',
  )
  const promote = el(
    'button',
    { type: 'button', class: 'side-chat-action', 'data-action': 'promote-side-chat' },
    'Promote to thread',
  )
  const form = el(
    'form',
    { class: 'side-chat-form' },
    el('div', { class: 'side-chat-form-row' }, input, send),
    el('div', { class: 'side-chat-foot' }, promote),
  )
  viewerRoot.append(headerHost, bodyHost, emptyState, form)
  const messageHost = desktopMessageHost(api)
  const messageNodes: SideChatMessageNodes = new Map()
  // Rendered replies carry the same workspace, file and browser links as the main
  // conversation, so they open the same way.
  const unbindLinks = [
    bindFileReferenceClicks(bodyHost, store, api),
    bindWorkspaceLinkClicks(bodyHost, store, api),
    bindBrowserLinkClicks(bodyHost, store, api),
  ]

  let selectedId: string | null = null
  let frame = 0

  function paneVisible(): boolean {
    const { filesPaneOpen, rightPanelMode } = store.getState()
    return filesPaneOpen && rightPanelMode === 'side-chat'
  }

  function ask(text: string): void {
    if (selectedId === null) return
    const side = store.getState().threads.find((thread) => thread.id === selectedId)
    if (!side || needsHydration(side)) return
    sendSideChatMessage(store, api, selectedId, text)
  }

  function hydrate(threadId: string): void {
    const { activeProjectId, threads } = store.getState()
    const thread = threads.find((t) => t.id === threadId)
    if (activeProjectId && thread && needsHydration(thread)) {
      void ensureThreadMessages(activeProjectId, threadId)
    }
  }

  function render(): void {
    frame = 0
    if (!paneVisible()) {
      showSideChatTranscript(null)
      return
    }
    const { threads, activeThreadId } = store.getState()
    const selection = resolveSideChatSelection(threads, activeThreadId, remembered)
    selectedId = selection.selectedId
    showSideChatTranscript(selectedId)
    if (selection.mainId !== null && selectedId !== null)
      remembered.set(selection.mainId, selectedId)

    clear(list)
    for (const row of selection.rows) {
      const item = el(
        'button',
        {
          type: 'button',
          class: `git-change-row side-chat-row${row.id === selectedId ? ' is-selected' : ''}`,
          'data-side-chat-id': row.id,
          'data-archived': row.archived ? 'true' : undefined,
          'data-unread': row.unread ? 'true' : undefined,
          'aria-pressed': String(row.id === selectedId),
        },
        row.unread
          ? el('span', { class: 'chat-unread-dot', role: 'img', 'aria-label': 'Unread reply' })
          : '',
        el(
          'span',
          { class: 'side-chat-row-main' },
          el('span', { class: 'side-chat-row-title' }, row.title || 'Side chat'),
          row.model !== undefined ? el('span', { class: 'side-chat-row-sub' }, row.model) : '',
        ),
        row.archived ? el('span', { class: 'side-chat-chip' }, 'Archived') : '',
      )
      item.addEventListener('click', () => {
        if (selection.mainId !== null) remembered.set(selection.mainId, row.id)
        // A failed read is not retried by render() (it would loop on its own
        // failure announcement); choosing the chat again is the retry.
        showSideChatTranscript(row.id)
        hydrate(row.id)
        render()
      })
      list.append(item)
    }
    if (selection.rows.length === 0) {
      list.append(el('p', { class: 'side-chat-list-empty' }, 'No side chats yet.'))
    }

    const side = threads.find((thread) => thread.id === selectedId)
    clear(headerHost)
    const bodyScroll = bodyHost
    const atBottom =
      bodyScroll.scrollHeight - bodyScroll.scrollTop - bodyScroll.clientHeight < 32 ||
      bodyScroll.childElementCount === 0
    emptyState.hidden = side !== undefined
    form.hidden = side === undefined
    headerHost.hidden = side === undefined
    bodyHost.hidden = side === undefined
    if (!side) {
      bodyHost.replaceChildren()
      messageNodes.clear()
      emptyState.textContent =
        selection.mainId === null
          ? 'Open a thread to start a side chat.'
          : 'Branch a question off any message without touching this thread.'
      return
    }
    const parent = threads.find((thread) => thread.id === side.sideChat?.parentThreadId)
    const loadFailed = needsHydration(side) && hydrationFailed(side.id)
    if (needsHydration(side) && !loadFailed) hydrate(side.id)
    const view = renderSideChat({
      side,
      parent,
      loadFailed,
      host: messageHost,
      body: bodyHost,
      messageNodes,
      onSuggestion: ask,
      onArchive: (archived) => {
        if (archived) restoreThread(store, side.id)
        else archiveThread(store, side.id)
      },
    })
    headerHost.append(view.header)
    if (atBottom) bodyHost.scrollTop = bodyHost.scrollHeight
    const unloaded = needsHydration(side)
    input.disabled = side.archivedAt != null || unloaded
    send.disabled = side.archivedAt != null || side.status === 'running' || unloaded
    // A run's later output lands on the side chat's own id, so promote once it settles.
    promote.disabled = side.status === 'running'
    promote.title = promote.disabled ? 'Wait for the side chat to finish before promoting' : ''
    // Visible and selected means seen: a reply landing now is not "unread".
    if (side.unreadAt !== undefined) markThreadRead(store, side.id)
  }

  /** Token streams arrive per chunk; coalesce redraws to one per frame. */
  function schedule(): void {
    if (!paneVisible()) {
      showSideChatTranscript(null)
      return
    }
    if (frame !== 0) return
    frame = requestAnimationFrame(render)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const text = input.value
    if (text.trim() === '') return
    input.value = ''
    ask(text)
  })
  newButton.addEventListener('click', () => {
    const thread = getActiveThread(store)
    const mainId = thread?.sideChat?.parentThreadId ?? thread?.id
    if (mainId === undefined) return
    void startSideChat(store, api, mainId).then((id) => {
      if (id === null) showToast('Send a message first: a side chat branches from one.')
    })
  })
  promote.addEventListener('click', () => {
    if (selectedId === null) return
    void promoteSideChat(store, api, selectedId)
  })

  const offs = [
    store.on('side_chat_open_requested', (threadId) => {
      const side = store.getState().threads.find((thread) => thread.id === threadId)
      if (side?.sideChat) remembered.set(side.sideChat.parentThreadId, threadId)
      openRightPanel(store, 'side-chat')
      render()
    }),
    selectRightPanelMode(store, 'side-chat', schedule),
    store.on('threads_changed', schedule),
    store.on('message_added', schedule),
    store.on('message_token', schedule),
    store.on('message_done', schedule),
    store.on('tool_call_started', schedule),
    store.on('thread_status_changed', schedule),
  ]
  schedule()
  return () => {
    showSideChatTranscript(null)
    for (const off of offs) off()
    for (const unbind of unbindLinks) unbind()
    if (frame !== 0) cancelAnimationFrame(frame)
  }
}
