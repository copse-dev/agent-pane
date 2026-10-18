import { formatByteSize } from '@shared/file-bytes.ts'
import { el, clear } from '../dom/helpers.ts'
import {
  gitBranchIcon,
  gitMergeIcon,
  gitPullRequestIcon,
  externalLinkIcon,
  plusIcon,
  closeIcon,
} from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import { githubPrKey } from '@shared/git/github-pr-url.ts'
import { normalizePrLifecycleState, type PrLifecycleState } from '@shared/git/thread-pr-status.ts'
import type { GhPrChecksState } from '@shared/types/git.ts'
import { prHasMergeConflicts } from '../dom/pr-status.ts'
import {
  archiveThread,
  getActiveThread,
  restoreThread,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import { openBrowserUrl, openPullRequest, toggleFilesPane } from '../controller/panels.ts'
import { startSideChat } from '../controller/side-chat.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { deriveThreadContext, type ThreadContextModel } from './thread-context-model.ts'

/** A compact, single-column overview of the active thread. */

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

type ContextSection = 'repos' | 'side-chats' | 'links' | 'subagents' | 'sources'

interface ContextPrStatus {
  state: PrLifecycleState
  checks?: GhPrChecksState
  conflicts?: boolean
  fetchedAt: number
}

const PR_STATUS_CACHE_TTL_MS = 60_000

const SECTION_TITLES: Record<ContextSection, string> = {
  repos: 'Access',
  'side-chats': 'Side chats',
  links: 'Links & references',
  subagents: 'Subagents',
  sources: 'Sources',
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
    el('div', { class: 'thread-context-label' }, 'Folders'),
    ...model.repos.map((repo) =>
      el(
        'div',
        {
          class: 'thread-context-row thread-context-repo',
          'data-repo-path': repo.path,
          title: [repo.path, repo.branch].filter(Boolean).join(' · '),
        },
        gitBranchIcon('ui-icon ui-icon-sm'),
        el(
          'span',
          { class: 'thread-context-main' },
          el('span', { class: 'thread-context-title' }, repo.name),
        ),
        el(
          'span',
          { class: 'thread-context-meta' },
          [repo.checkout === 'worktree' ? 'Worktree' : 'Primary', repo.branch]
            .filter(Boolean)
            .join(' · '),
        ),
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

function linksSection(
  model: ThreadContextModel,
  handlers: ThreadContextHandlers,
  prStatuses: ReadonlyMap<string, ContextPrStatus>,
): HTMLElement {
  const groups: Array<'pr' | 'thread'> = ['pr', 'thread']
  const children: HTMLElement[] = []
  for (const group of groups) {
    const rows = model.links.filter((link) => link.kind === group)
    if (rows.length === 0) continue
    children.push(
      el(
        'div',
        { class: 'thread-context-group', 'data-link-group': group },
        ...rows.map((link) => {
          const status = link.pr ? prStatuses.get(githubPrKey(link.pr)) : undefined
          const knownStatus = status?.state === 'unknown' ? undefined : status
          const conflicts = knownStatus?.state === 'open' && knownStatus.conflicts === true
          const failing = knownStatus?.state === 'open' && knownStatus.checks === 'failure'
          const statusLabel = knownStatus
            ? `Pull request #${String(link.pr?.number)} is ${knownStatus.state}${failing ? '; checks are failing' : ''}${conflicts ? '; merge conflicts' : ''}`
            : undefined
          const prIcon =
            knownStatus?.state === 'merged'
              ? gitMergeIcon('ui-icon ui-icon-sm')
              : gitPullRequestIcon('ui-icon ui-icon-sm', conflicts)
          prIcon.setAttribute('aria-hidden', 'true')
          const button = rowButton(
            {
              'data-link-key': link.key,
              'data-unresolved': link.unresolved ? 'true' : undefined,
              'aria-label': statusLabel ? `${link.label}; ${statusLabel}` : undefined,
            },
            link.kind === 'pr'
              ? knownStatus
                ? el(
                    'span',
                    {
                      class: `chat-pr-status thread-context-pr-status is-${knownStatus.state}${conflicts ? ' has-conflicts' : failing ? ' has-ci-failure' : ''}`,
                      role: 'img',
                      'aria-label': statusLabel,
                      'data-tooltip': statusLabel,
                    },
                    prIcon,
                  )
                : prIcon
              : link.kind === 'url'
                ? externalLinkIcon('ui-icon ui-icon-sm')
                : '',
            el('span', { class: 'thread-context-title', title: link.label }, link.label),
            el(
              'span',
              { class: 'thread-context-chip' },
              link.kind === 'pr'
                ? knownStatus
                  ? knownStatus.state.charAt(0).toUpperCase() + knownStatus.state.slice(1)
                  : 'PR'
                : 'Thread',
            ),
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
  const result = section(
    'subagents',
    ...model.subagents.map((agent) =>
      el(
        'div',
        { class: 'thread-context-row', 'data-subagent-id': agent.id, 'data-status': agent.status },
        el('span', { class: 'thread-context-status-dot', 'aria-hidden': 'true' }),
        el(
          'span',
          { class: 'thread-context-main' },
          el('span', { class: 'thread-context-title' }, agent.kind),
          el('span', { class: 'thread-context-sub' }, agent.prompt),
        ),
        el(
          'span',
          { class: 'thread-context-meta', title: agent.model ?? agent.status },
          [agent.status, agent.model].filter(Boolean).join(' · '),
        ),
      ),
    ),
  )
  const summary = ['running', 'done', 'error']
    .flatMap((status) => {
      const count = model.subagents.filter((agent) => agent.status === status).length
      return count ? [`${String(count)} ${status}`] : []
    })
    .join(' · ')
  result.querySelector('h5')?.append(el('span', { class: 'thread-context-count' }, summary))
  return result
}

function sourcesSection(model: ThreadContextModel, handlers: ThreadContextHandlers): HTMLElement {
  const sources = model.links.filter((link) => link.kind === 'url')
  return section(
    'sources',
    ...(sources.length
      ? sources.map((link) => {
          const row = rowButton(
            { 'data-link-key': link.key, title: link.target },
            externalLinkIcon('ui-icon ui-icon-sm'),
            el('span', { class: 'thread-context-title' }, link.label),
          )
          row.addEventListener('click', () => {
            handlers.openUrl(link.target)
          })
          return row
        })
      : [emptyNote('No sources yet.')]),
  )
}

/** Pure render of one thread's context. */
export function renderThreadContext(
  model: ThreadContextModel,
  handlers: ThreadContextHandlers,
  prStatuses: ReadonlyMap<string, ContextPrStatus> = new Map(),
): HTMLElement {
  const host = el('div', { class: 'thread-context', 'aria-label': 'Thread context' })
  if (model.title) host.append(el('div', { class: 'thread-context-thread-title' }, model.title))
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
    subagentsSection(model),
    reposSection(model),
    linksSection(model, handlers, prStatuses),
    sourcesSection(model, handlers),
    sideChatsSection(model, handlers),
  )
  return host
}

function contextModeActive(store: AppStore): boolean {
  const { filesPaneOpen, rightPanelMode } = store.getState()
  return filesPaneOpen && rightPanelMode === 'context'
}

/** Mount the fixed header and scrolling content in one pane. */
export function mountThreadContextPane(
  listRoot: HTMLElement,
  viewerRoot: HTMLElement,
  store: AppStore,
  api: ApiClient,
): () => void {
  const close = el(
    'button',
    { type: 'button', class: 'thread-context-close', 'aria-label': 'Close context' },
    closeIcon('ui-icon ui-icon-sm'),
  )
  close.addEventListener('click', () => {
    toggleFilesPane(store)
  })
  listRoot.append(
    el(
      'div',
      { class: 'pane-header' },
      el('span', { class: 'pane-header-title' }, 'Context'),
      panePopoutButton(store, api, 'context', 'context'),
      paneMaximizeButton(store, 'context'),
      close,
    ),
  )

  let mentionedIn: ThreadContextModel['mentionedIn'] = []
  let mentionedFor: string | null = null
  let token = 0
  let storageToken = 0
  let storageKey = ''
  let storageText = 'Calculating…'
  let changesToken = 0
  let changesKey = ''
  let changesText = 'Calculating…'
  let changeStats: { additions: number; deletions: number } | null = null
  let disposed = false
  const prStatuses = new Map<string, ContextPrStatus>()
  const prFetchInFlight = new Set<string>()

  function ensurePrStatuses(links: ThreadContextModel['links']): void {
    for (const link of links) {
      if (!link.pr) continue
      const ref = link.pr
      const key = githubPrKey(ref)
      const cached = prStatuses.get(key)
      if (
        prFetchInFlight.has(key) ||
        (cached && Date.now() - cached.fetchedAt <= PR_STATUS_CACHE_TTL_MS)
      )
        continue
      prFetchInFlight.add(key)
      void api.gh
        .prDetails(ref.owner, ref.repo, ref.number)
        .then(async (details) => {
          const state = details ? normalizePrLifecycleState(details.state) : 'unknown'
          const conflicts = state === 'open' && details !== null && prHasMergeConflicts(details)
          let checks: GhPrChecksState | undefined
          if (state === 'open') {
            try {
              checks = await api.gh.prChecks(ref.owner, ref.repo, ref.number)
            } catch {
              checks = undefined
            }
          }
          prStatuses.set(key, {
            state,
            conflicts,
            ...(checks ? { checks } : {}),
            fetchedAt: Date.now(),
          })
        })
        .catch(() => {
          prStatuses.set(key, { ...(cached ?? { state: 'unknown' }), fetchedAt: Date.now() })
        })
        .finally(() => {
          prFetchInFlight.delete(key)
          if (!disposed && contextModeActive(store)) render()
        })
    }
  }

  function activeStorageKey(): string {
    const state = store.getState()
    const thread = getActiveThread(store)
    return JSON.stringify([
      state.activeProjectId,
      thread?.id,
      thread?.worktree?.path,
      thread?.worktree?.retiredAt,
    ])
  }

  function changesContent(): Array<Node | string> {
    if (changesKey !== activeStorageKey()) return ['Calculating…']
    if (!changeStats) return [changesText]
    return [
      el('span', { class: 'git-change-status-added' }, `+${String(changeStats.additions)}`),
      ' ',
      el('span', { class: 'git-change-status-deleted' }, `−${String(changeStats.deletions)}`),
    ]
  }

  async function refreshChanges(): Promise<void> {
    const thread = getActiveThread(store)
    const projectId = store.getState().activeProjectId
    if (!thread || !projectId) return
    const mine = ++changesToken
    const key = activeStorageKey()
    changesKey = key
    changesText = 'Calculating…'
    changeStats = null
    const update = (): void => {
      const slot = viewerRoot.querySelector('[data-context-change-stats]')
      if (slot) slot.replaceChildren(...changesContent())
    }
    update()
    try {
      const stats = await api.git.changeStats(projectId, thread.id)
      if (disposed || mine !== changesToken || key !== activeStorageKey()) return
      changeStats = stats ?? { additions: 0, deletions: 0 }
    } catch (error) {
      if (disposed || mine !== changesToken || key !== activeStorageKey()) return
      console.error('[context] change totals lookup failed:', error)
      changesText = 'Unavailable'
    }
    update()
  }

  async function refreshStorage(): Promise<void> {
    void refreshChanges()
    const thread = getActiveThread(store)
    const projectId = store.getState().activeProjectId
    if (!thread || !projectId) return
    const mine = ++storageToken
    const key = activeStorageKey()
    storageKey = key
    storageText = 'Calculating…'
    const update = (): void => {
      const slot = viewerRoot.querySelector('[data-context-storage-size]')
      if (slot) slot.textContent = storageText
    }
    update()
    try {
      const [saved, checkout] = await Promise.all([
        api.threads.storageSize(projectId, thread.id),
        thread.worktree && thread.worktree.retiredAt === undefined
          ? api.worktrees.size(projectId, thread.worktree.path)
          : Promise.resolve({ bytes: 0, truncated: false }),
      ])
      if (disposed || mine !== storageToken || key !== activeStorageKey()) return
      storageText = `${saved.truncated || checkout.truncated ? 'At least ' : ''}${formatByteSize(saved.bytes + checkout.bytes)}`
    } catch (error) {
      if (disposed || mine !== storageToken || key !== activeStorageKey()) return
      console.error('[context] storage lookup failed:', error)
      storageText = 'Unavailable'
    }
    update()
  }

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
    ensurePrStatuses(model.links)
    const content = renderThreadContext(model, handlers, prStatuses)
    const archive = el(
      'button',
      {
        type: 'button',
        class: 'thread-context-action',
        'data-action': 'archive-thread',
        disabled: thread.archivedAt !== undefined,
      },
      'Archive thread',
    )
    archive.addEventListener('click', () => {
      if (project) store.emit('thread_archive_requested', project.id, thread.id)
    })
    content.querySelector('[data-context-section="repos"]')?.after(
      el(
        'section',
        { class: 'thread-context-section', 'data-context-section': 'storage' },
        el('h5', {}, 'Storage'),
        el(
          'div',
          { class: 'thread-context-row' },
          el('span', { class: 'thread-context-main' }, 'Retained on disk'),
          el(
            'span',
            { 'data-context-storage-size': '' },
            storageKey === activeStorageKey() ? storageText : 'Calculating…',
          ),
        ),
        el(
          'div',
          { class: 'thread-context-row' },
          el('span', { class: 'thread-context-main' }, 'Changes'),
          el(
            'span',
            {
              'data-context-change-stats': '',
              title: 'Lines added and removed in this checkout',
            },
            ...changesContent(),
          ),
        ),
        el(
          'p',
          { class: 'thread-context-empty' },
          'Saved thread files and its dedicated worktree. Shared project files are excluded.',
        ),
        el('div', { class: 'thread-context-section-actions' }, archive),
      ),
    )
    viewerRoot.append(content)
  }

  /** Backlinks come from the index; ignore an answer for a thread since closed. */
  async function refreshMentions(): Promise<void> {
    void refreshStorage()
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
    if (disposed || mine !== token || getActiveThread(store)?.id !== thread.id) return
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
      else if (storageKey !== activeStorageKey()) void refreshStorage()
    }),
    store.on('message_done', () => {
      if (!contextModeActive(store)) return
      render()
      void refreshMentions()
    }),
    store.on('workspace_changed', () => {
      mentionedFor = null
      storageKey = ''
      changesKey = ''
      changesToken++
      token++
      storageToken++
      if (contextModeActive(store)) {
        render()
        void refreshMentions()
      }
    }),
  ]
  const onFocus = (): void => {
    if (contextModeActive(store)) render()
  }
  window.addEventListener('focus', onFocus)
  if (contextModeActive(store)) {
    render()
    void refreshMentions()
  }
  return () => {
    disposed = true
    token++
    storageToken++
    changesToken++
    window.removeEventListener('focus', onFocus)
    for (const off of offs) off()
  }
}
