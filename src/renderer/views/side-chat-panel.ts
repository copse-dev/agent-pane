import { renderMarkdown } from '@copse/streaming-markdown'
import { el, clear } from '../dom/helpers.ts'
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
import { sideChatsOf, type SideChatRow } from '@shared/threads/side-chat.ts'
import { openRightPanel } from '../controller/panels.ts'
import { promoteSideChat, sendSideChatMessage, startSideChat } from '../controller/side-chat.ts'
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

function excerpt(text: string): string {
  const line = text.trim().split('\n', 1)[0] ?? ''
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`
}

function messageEl(message: Thread['messages'][number]): HTMLElement {
  if (message.role === 'user') {
    return el('div', { class: 'side-chat-msg is-user', 'data-role': 'user' }, message.content)
  }
  if (message.role === 'error') {
    return el('div', { class: 'side-chat-msg is-error', 'data-role': 'error' }, message.content)
  }
  const bubble = el('div', {
    class: 'side-chat-msg is-assistant message-text',
    'data-role': 'assistant',
  })
  if (message.content.trim() !== '') bubble.innerHTML = renderMarkdown(message.content)
  for (const call of message.toolCalls) {
    bubble.append(el('div', { class: 'side-chat-tool', 'data-tool': call.name }, call.name))
  }
  return bubble
}

/** Pure render of one side chat's header, context line and transcript. */
export function renderSideChat(input: {
  side: Thread
  parent: Thread | undefined
  onSuggestion: (text: string) => void
  onArchive: (archived: boolean) => void
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
        ? `Reads the main thread up to “${excerpt(anchor.content)}”. Read-only.`
        : 'Reads the main thread up to where it branched. Read-only.',
    ),
  )
  header.querySelector('button')?.addEventListener('click', () => {
    if (!archiveBlocked) input.onArchive(archived)
  })

  const body = el('div', { class: 'side-chat-body' })
  if (side.messages.length === 0) {
    // An archived side chat takes no new questions until it is restored, so it
    // offers no suggestions either (the composer is disabled for the same reason).
    body.append(
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
    for (const message of side.messages) body.append(messageEl(message))
  }
  if (side.status === 'running') {
    body.append(el('div', { class: 'side-chat-typing', role: 'status' }, 'Copse is thinking…'))
  }
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

  let selectedId: string | null = null
  let frame = 0

  function paneVisible(): boolean {
    const { filesPaneOpen, rightPanelMode } = store.getState()
    return filesPaneOpen && rightPanelMode === 'side-chat'
  }

  function ask(text: string): void {
    if (selectedId === null) return
    sendSideChatMessage(store, api, selectedId, text)
  }

  function render(): void {
    frame = 0
    if (!paneVisible()) return
    const { threads, activeThreadId } = store.getState()
    const selection = resolveSideChatSelection(threads, activeThreadId, remembered)
    selectedId = selection.selectedId
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
    clear(bodyHost)
    emptyState.hidden = side !== undefined
    form.hidden = side === undefined
    headerHost.hidden = side === undefined
    bodyHost.hidden = side === undefined
    if (!side) {
      emptyState.textContent =
        selection.mainId === null
          ? 'Open a thread to start a side chat.'
          : 'Branch a question off any message without touching this thread.'
      return
    }
    const parent = threads.find((thread) => thread.id === side.sideChat?.parentThreadId)
    const view = renderSideChat({
      side,
      parent,
      onSuggestion: ask,
      onArchive: (archived) => {
        if (archived) restoreThread(store, side.id)
        else archiveThread(store, side.id)
      },
    })
    headerHost.append(view.header)
    bodyHost.append(...Array.from(view.body.childNodes))
    if (atBottom) bodyHost.scrollTop = bodyHost.scrollHeight
    input.disabled = side.archivedAt != null
    send.disabled = side.archivedAt != null || side.status === 'running'
    // A run's later output lands on the side chat's own id, so promote once it settles.
    promote.disabled = side.status === 'running'
    promote.title = promote.disabled ? 'Wait for the side chat to finish before promoting' : ''
    // Visible and selected means seen: a reply landing now is not "unread".
    if (side.unreadAt !== undefined) markThreadRead(store, side.id)
  }

  /** Token streams arrive per chunk; coalesce redraws to one per frame. */
  function schedule(): void {
    if (!paneVisible() || frame !== 0) return
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
    store.on('right_panel_mode_changed', schedule),
    store.on('files_pane_changed', schedule),
    store.on('threads_changed', schedule),
    store.on('message_added', schedule),
    store.on('message_token', schedule),
    store.on('message_done', schedule),
    store.on('tool_call_started', schedule),
    store.on('thread_status_changed', schedule),
  ]
  schedule()
  return () => {
    for (const off of offs) off()
    if (frame !== 0) cancelAnimationFrame(frame)
  }
}
