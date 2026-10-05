import { el, clear } from '../dom/helpers.ts'
import { gitBranchIcon, gitPullRequestIcon, externalLinkIcon, plusIcon } from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import {
  archiveThread,
  getActiveThread,
  restoreThread,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import { openBrowserUrl, openPullRequest } from '../controller/panels.ts'
import { startSideChat } from '../controller/side-chat.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { deriveThreadContext, type ThreadContextModel } from './thread-context-model.ts'

/**
 * The per-thread Context panel (prototype #3538): repos, side chats, links and
 * references, and subagents for the open thread. The list column is a section
 * index with counts; the viewer column holds the content.
 */

export interface ThreadContextHandlers {
  openThread: (threadId: string) => void
  /** Show a side chat beside the main thread (the Side chat panel). */
  openSideChat: (threadId: string) => void
  openPr: (ref: GithubPrRef) => void
  openUrl: (url: string) => void
  startSideChat: () => void
  archiveSideChat: (threadId: string) => void
  restoreSideChat: (threadId: string) => void
}

export const CONTEXT_SECTIONS = ['repos', 'side-chats', 'links', 'subagents'] as const
type ContextSection = (typeof CONTEXT_SECTIONS)[number]

const SECTION_TITLES: Record<ContextSection, string> = {
  repos: 'Repos',
  'side-chats': 'Side chats',
  links: 'Links and references',
  subagents: 'Subagents',
}

function sectionCount(model: ThreadContextModel, section: ContextSection): number {
  switch (section) {
    case 'repos':
      return model.repos.length
    case 'side-chats':
      return model.sideChats.filter((row) => !row.archived).length
    case 'links':
      return model.links.length + model.mentionedIn.length
    case 'subagents':
      return model.subagents.length
  }
}

function section(kind: ContextSection, ...children: Array<Node | string>): HTMLElement {
  return el(
    'section',
    { class: 'thread-context-section', 'data-context-section': kind },
    el('h5', {}, SECTION_TITLES[kind]),
    ...children,
  )
}

function emptyNote(text: string): HTMLElement {
  return el('p', { class: 'thread-context-empty' }, text)
}

function rowButton(
  attrs: Record<string, string | boolean | undefined>,
  ...children: Array<Node | string>
): HTMLButtonElement {
  return el('button', { type: 'button', class: 'thread-context-row', ...attrs }, ...children)
}

function reposSection(model: ThreadContextModel): HTMLElement {
  if (model.repos.length === 0) return section('repos', emptyNote('No repository for this thread.'))
  return section(
    'repos',
    ...model.repos.map((repo) =>
      el(
        'div',
        { class: 'thread-context-row thread-context-repo', 'data-repo-path': repo.path },
        gitBranchIcon('ui-icon ui-icon-sm'),
        el(
          'span',
          { class: 'thread-context-main' },
          el('span', { class: 'thread-context-title' }, repo.name),
          el('span', { class: 'thread-context-sub' }, repo.path),
        ),
        repo.branch !== undefined
          ? el(
              'span',
              { class: 'thread-context-chip', 'data-checkout': repo.checkout },
              repo.branch,
            )
          : '',
      ),
    ),
  )
}

function sideChatsSection(model: ThreadContextModel, handlers: ThreadContextHandlers): HTMLElement {
  // Side chats branch from main threads only, so a side chat cannot start another.
  const canStart = model.sideOf === undefined
  const header = el(
    'div',
    { class: 'thread-context-section-actions' },
    el(
      'button',
      {
        type: 'button',
        class: 'thread-context-action',
        'data-action': 'new-side-chat',
        disabled: !canStart,
      },
      plusIcon('ui-icon ui-icon-sm'),
      'New side chat',
    ),
  )
  header.querySelector('button')?.addEventListener('click', handlers.startSideChat)
  const rows = model.sideChats.map((chat) => {
    const open = rowButton(
      {
        'data-side-chat-id': chat.id,
        'data-archived': chat.archived ? 'true' : undefined,
        'data-unread': chat.unread ? 'true' : undefined,
      },
      chat.unread
        ? el('span', {
            class: 'chat-unread-dot',
            role: 'img',
            'aria-label': 'Unread reply',
          })
        : '',
      el(
        'span',
        { class: 'thread-context-main' },
        el('span', { class: 'thread-context-title' }, chat.title || 'Side chat'),
        chat.model !== undefined ? el('span', { class: 'thread-context-sub' }, chat.model) : '',
      ),
      chat.archived ? el('span', { class: 'thread-context-chip' }, 'Archived') : '',
    )
    open.addEventListener('click', () => {
      handlers.openSideChat(chat.id)
    })
    const toggle = el(
      'button',
      {
        type: 'button',
        class: 'thread-context-action thread-context-row-action',
        'data-action': chat.archived ? 'restore-side-chat' : 'archive-side-chat',
        'data-side-chat-id': chat.id,
        'aria-label': `${chat.archived ? 'Restore' : 'Archive'} side chat ${chat.title}`,
      },
      chat.archived ? 'Restore' : 'Archive',
    )
    toggle.addEventListener('click', () => {
      if (chat.archived) handlers.restoreSideChat(chat.id)
      else handlers.archiveSideChat(chat.id)
    })
    return el('div', { class: 'thread-context-row-wrap' }, open, toggle)
  })
  return section(
    'side-chats',
    header,
    rows.length > 0
      ? el('div', { class: 'thread-context-rows' }, ...rows)
      : emptyNote(
          canStart
            ? 'None yet. Ask a side question without touching this thread.'
            : 'Side chats do not nest.',
        ),
  )
}

function linksSection(model: ThreadContextModel, handlers: ThreadContextHandlers): HTMLElement {
  const groups: Array<{ label: string; kind: 'pr' | 'thread' | 'url' }> = [
    { label: 'Pull requests', kind: 'pr' },
    { label: 'Threads', kind: 'thread' },
    { label: 'Web', kind: 'url' },
  ]
  const children: HTMLElement[] = []
  for (const group of groups) {
    const rows = model.links.filter((link) => link.kind === group.kind)
    if (rows.length === 0) continue
    children.push(
      el(
        'div',
        { class: 'thread-context-group', 'data-link-group': group.kind },
        el('h6', {}, group.label),
        ...rows.map((link) => {
          const button = rowButton(
            {
              'data-link-key': link.key,
              'data-unresolved': link.unresolved ? 'true' : undefined,
            },
            link.kind === 'pr'
              ? gitPullRequestIcon('ui-icon ui-icon-sm')
              : link.kind === 'url'
                ? externalLinkIcon('ui-icon ui-icon-sm')
                : '',
            el('span', { class: 'thread-context-title' }, link.label),
          )
          button.addEventListener('click', () => {
            if (link.kind === 'pr' && link.pr) handlers.openPr(link.pr)
            else if (link.kind === 'thread' && !link.unresolved) handlers.openThread(link.target)
            else if (link.kind === 'url') handlers.openUrl(link.target)
          })
          if (link.unresolved) button.disabled = true
          return button
        }),
      ),
    )
  }
  if (model.mentionedIn.length > 0) {
    children.push(
      el(
        'div',
        { class: 'thread-context-group', 'data-link-group': 'mentioned-in' },
        el('h6', {}, 'Mentioned in'),
        ...model.mentionedIn.map((row) => {
          const button = rowButton(
            { 'data-thread-id': row.threadId },
            el('span', { class: 'thread-context-title' }, row.title || 'Untitled thread'),
          )
          button.addEventListener('click', () => {
            handlers.openThread(row.threadId)
          })
          return button
        }),
      ),
    )
  }
  return section(
    'links',
    ...(children.length > 0 ? children : [emptyNote('No links or references yet.')]),
  )
}

function subagentsSection(model: ThreadContextModel): HTMLElement {
  if (model.subagents.length === 0) return section('subagents', emptyNote('No subagents.'))
  return section(
    'subagents',
    ...model.subagents.map((agent) =>
      el(
        'div',
        { class: 'thread-context-row', 'data-subagent-id': agent.id, 'data-status': agent.status },
        el(
          'span',
          { class: 'thread-context-main' },
          el('span', { class: 'thread-context-title' }, agent.prompt || agent.kind),
          el(
            'span',
            { class: 'thread-context-sub' },
            [agent.kind, agent.model].filter(Boolean).join(' · '),
          ),
        ),
        el('span', { class: 'thread-context-chip', 'data-status': agent.status }, agent.status),
      ),
    ),
  )
}

/** Pure render: the whole viewer column for one thread's context. */
export function renderThreadContext(
  model: ThreadContextModel,
  handlers: ThreadContextHandlers,
): HTMLElement {
  const host = el('div', { class: 'thread-context', 'aria-label': 'Thread context' })
  if (model.sideOf) {
    const back = el(
      'button',
      { type: 'button', class: 'thread-context-link', 'data-action': 'back-to-parent' },
      model.sideOf.parentTitle,
    )
    back.addEventListener('click', () => {
      if (model.sideOf) handlers.openThread(model.sideOf.parentThreadId)
    })
    host.append(
      el(
        'div',
        { class: 'thread-context-side-banner', 'data-context': 'side-of' },
        el('span', { class: 'thread-context-kicker' }, 'Side chat'),
        el('span', {}, ' of '),
        back,
        el(
          'p',
          { class: 'thread-context-note' },
          model.sideOf.anchorExcerpt !== undefined
            ? `Reads the main thread up to “${model.sideOf.anchorExcerpt}”. Read-only.`
            : 'Reads the main thread up to where it branched. Read-only.',
        ),
      ),
    )
  }
  host.append(
    reposSection(model),
    sideChatsSection(model, handlers),
    linksSection(model, handlers),
    subagentsSection(model),
  )
  return host
}

function contextModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'context'
}

/** Mount the Context pane: list column = section index, viewer column = content. */
export function mountThreadContextPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  listRoot.append(
    el(
      'div',
      { class: 'pane-header' },
      el('span', { class: 'pane-header-title' }, 'Context'),
      panePopoutButton(store, api, 'context', 'context'),
      paneMaximizeButton(store, 'context'),
    ),
  )
  const index = el('div', { class: 'git-changes-list thread-context-index' })
  listRoot.append(index)

  let mentionedIn: ThreadContextModel['mentionedIn'] = []
  let mentionedFor: string | null = null
  let token = 0

  const handlers: ThreadContextHandlers = {
    openThread: (threadId) => {
      switchThread(store, threadId)
    },
    openSideChat: (threadId) => {
      store.emit('side_chat_open_requested', threadId)
    },
    openPr: (ref) => {
      openPullRequest(store, ref)
    },
    openUrl: (url) => {
      openBrowserUrl(store, url)
    },
    startSideChat: () => {
      const thread = getActiveThread(store)
      if (thread) void startSideChat(store, api, thread.id)
    },
    archiveSideChat: (threadId) => {
      archiveThread(store, threadId)
    },
    restoreSideChat: (threadId) => {
      restoreThread(store, threadId)
    },
  }

  function render(): void {
    const state = store.getState()
    const thread = getActiveThread(store)
    clear(viewerRoot)
    clear(index)
    if (!thread) {
      viewerRoot.append(emptyNote('Open a thread to see its context.'))
      return
    }
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId)
    const model = deriveThreadContext({
      thread,
      project,
      threads: state.threads,
      mentionedIn: mentionedFor === thread.id ? mentionedIn : [],
    })
    viewerRoot.append(renderThreadContext(model, handlers))
    for (const kind of CONTEXT_SECTIONS) {
      const jump = el(
        'button',
        { type: 'button', class: 'git-change-row thread-context-index-row', 'data-index': kind },
        el('span', { class: 'thread-context-title' }, SECTION_TITLES[kind]),
        el('span', { class: 'thread-context-count' }, String(sectionCount(model, kind))),
      )
      jump.addEventListener('click', () => {
        viewerRoot
          .querySelector(`[data-context-section="${kind}"]`)
          ?.scrollIntoView({ block: 'start' })
      })
      index.append(jump)
    }
  }

  /** Backlinks come from the index; ignore an answer for a thread since closed. */
  async function refreshMentions(): Promise<void> {
    const thread = getActiveThread(store)
    const projectId = store.getState().activeProjectId
    if (!thread || !projectId) return
    const mine = ++token
    let rows: ThreadContextModel['mentionedIn'] = []
    try {
      rows = await api.threads.backlinks(projectId, 'thread', thread.id)
    } catch (error) {
      console.error('[context] backlink lookup failed:', error)
    }
    if (mine !== token || getActiveThread(store)?.id !== thread.id) return
    mentionedIn = rows
    mentionedFor = thread.id
    if (contextModeActive(store)) render()
  }

  const offs = [
    store.on('right_panel_mode_changed', () => {
      if (!contextModeActive(store)) return
      render()
      void refreshMentions()
    }),
    store.on('files_pane_changed', () => {
      if (!contextModeActive(store)) return
      render()
      void refreshMentions()
    }),
    store.on('threads_changed', () => {
      if (!contextModeActive(store)) return
      const active = getActiveThread(store)?.id ?? null
      render()
      if (active !== mentionedFor) void refreshMentions()
    }),
    store.on('message_done', () => {
      if (!contextModeActive(store)) return
      render()
      void refreshMentions()
    }),
    store.on('workspace_changed', () => {
      mentionedFor = null
      if (contextModeActive(store)) render()
    }),
  ]
  if (contextModeActive(store)) {
    render()
    void refreshMentions()
  }
  return () => {
    for (const off of offs) off()
  }
}
