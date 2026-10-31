import { formatByteSize } from '@shared/file-bytes.ts'
import { el, clear } from '../dom/helpers.ts'
import {
  gitBranchIcon,
  gitPullRequestIcon,
  externalLinkIcon,
  plusIcon,
  closeIcon,
} from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { DecisionEvent } from '@shared/threads/decision-log.ts'
import type { ContextPermissionSnapshot } from '@shared/types/context-permissions.ts'
import type { GuardedYoloPhase } from '@shared/types/guarded-yolo.ts'
import type { GithubPrRef } from '@shared/git/github-pr-url.ts'
import type { DeferredApproval } from '@shared/threads/deferred-approval.ts'
import { reviewerInputAnswer, reviewerInputRequests } from '@shared/threads/reviewer-input.ts'
import {
  archiveThread,
  getActiveThread,
  restoreThread,
  switchThread,
} from '@shared/store/thread-helpers.ts'
import {
  openBrowserUrl,
  openPullRequest,
  openRightPanel,
  selectRightPanelMode,
  toggleFilesPane,
} from '../controller/panels.ts'
import { startSideChat } from '../controller/side-chat.ts'
import { paneMaximizeButton } from './pane-maximize-button.ts'
import { panePopoutButton } from './pane-popout-button.ts'
import { openActivityPanel } from './activity-panel.ts'
import type { AskUserRequests } from './ask-user-dialog.ts'
import { deriveThreadContext, type ThreadContextModel } from './thread-context-model.ts'
import { mountReviewerInput } from './reviewer-input.ts'
import { showErrorToast } from './toast.ts'
import { openSettingsDialog } from './settings-dialog.ts'

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
  jumpToReviewerInput: (messageId: string, requestId: string) => void
}

type ContextSection =
  | 'requests'
  | 'repos'
  | 'side-chats'
  | 'links'
  | 'subagents'
  | 'sources'
  | 'resolved-questions'

const SECTION_TITLES: Record<ContextSection, string> = {
  requests: 'Needs your input',
  repos: 'Access',
  'side-chats': 'Side chats',
  links: 'Links & references',
  subagents: 'Subagents',
  sources: 'Sources',
  'resolved-questions': 'Resolved questions',
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

function linksSection(model: ThreadContextModel, handlers: ThreadContextHandlers): HTMLElement {
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
            el('span', { class: 'thread-context-title', title: link.label }, link.label),
            el('span', { class: 'thread-context-chip' }, link.kind === 'pr' ? 'PR' : 'Thread'),
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

function resolvedQuestionsSection(
  model: ThreadContextModel,
  handlers: ThreadContextHandlers,
): HTMLElement | null {
  if (model.resolvedQuestions.length === 0) return null
  return section(
    'resolved-questions',
    ...model.resolvedQuestions.map(({ request, answer }) => {
      const jump = el(
        'button',
        { type: 'button', class: 'reviewer-input-origin' },
        'Show in conversation',
      )
      jump.addEventListener('click', () => {
        handlers.jumpToReviewerInput(request.messageId, request.id)
      })
      return el(
        'details',
        { class: 'thread-context-question', 'data-reviewer-input-id': request.id },
        el('summary', {}, request.question),
        el('p', { class: 'reviewer-input-context' }, request.context),
        el('p', { class: 'reviewer-input-answer' }, `Your answer: ${answer.text}`),
        jump,
      )
    }),
  )
}

/** Pure render of one thread's context. */
export function renderThreadContext(
  model: ThreadContextModel,
  handlers: ThreadContextHandlers,
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
  const resolvedQuestions = resolvedQuestionsSection(model, handlers)
  host.append(
    subagentsSection(model),
    ...(resolvedQuestions ? [resolvedQuestions] : []),
    reposSection(model),
    linksSection(model, handlers),
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
  liveQuestions?: AskUserRequests,
): () => void {
  const reviewerInput = mountReviewerInput(store, api)
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
  let storageCheckedAt = 0
  let storagePending = false
  let changesToken = 0
  let changesKey = ''
  let changesText = 'Calculating…'
  let changeStats: { additions: number; deletions: number } | null = null
  let approvals: DeferredApproval[] = []
  let approvalsKey = ''
  let approvalsToken = 0
  let approvalsError = false
  let changesCheckedAt = 0
  let changesPending = false
  let renderedKey = ''
  let disposed = false
  let accessToken = 0
  let accessFor: string | null = null
  let accessGrants: {
    read: boolean
    send: boolean
    orchestrate: boolean
    context: ContextPermissionSnapshot
    guardedYolo: GuardedYoloPhase
    workspaceTrusted: boolean
    savedWebOrigins: number
    toolOverrides: number
    decisions: DecisionEvent[]
  } | null = null
  let accessStatus = 'Checking…'

  function permissionRow(label: string, value: string, detail?: string): HTMLElement {
    return el(
      'div',
      { class: 'thread-context-row' },
      el(
        'span',
        { class: 'thread-context-main' },
        el('span', { class: 'thread-context-title' }, label),
        ...(detail ? [el('span', { class: 'thread-context-sub', title: detail }, detail)] : []),
      ),
      el('span', { class: 'thread-context-chip' }, value),
    )
  }

  function accessSection(threadId: string): HTMLElement {
    const result = el(
      'section',
      { class: 'thread-context-section', 'data-context-section': 'permissions' },
      el('h5', {}, 'Permissions'),
    )
    if (accessFor !== threadId || !accessGrants) {
      result.append(emptyNote(accessStatus))
      return result
    }
    const currentGrants = accessGrants
    result.append(el('p', { class: 'thread-context-permission-label' }, 'This thread'))
    const grants = [
      { access: 'read' as const, label: 'Read other threads' },
      { access: 'send' as const, label: 'Send prompts to other threads' },
      { access: 'orchestrate' as const, label: 'Orchestrate own subthreads' },
    ].filter(({ access }) => currentGrants[access])
    if (grants.length === 0) {
      result.append(emptyNote('No saved conversation access.'))
    }
    for (const { access, label } of grants) {
      const revoke = el(
        'button',
        {
          type: 'button',
          class: 'thread-context-action thread-context-row-action',
          'data-action': `revoke-${access}-access`,
          'aria-label': `Revoke permission to ${label.toLowerCase()}`,
        },
        'Revoke',
      )
      revoke.addEventListener('click', () => {
        revoke.disabled = true
        void api.threadPrompts
          .revokeAccess(threadId, access)
          .then(() => refreshAccess())
          .catch((error: unknown) => {
            revoke.disabled = false
            showErrorToast('Could not revoke thread permission', error)
          })
      })
      result.append(
        el(
          'div',
          { class: 'thread-context-row-wrap' },
          el(
            'div',
            { class: 'thread-context-row', 'data-access': access },
            el('span', { class: 'thread-context-main' }, label),
            el('span', { class: 'thread-context-chip' }, 'Granted'),
          ),
          revoke,
        ),
      )
    }
    if (currentGrants.guardedYolo !== 'off') {
      const disable = el(
        'button',
        {
          type: 'button',
          class: 'thread-context-action thread-context-row-action',
          'data-action': 'disable-guarded-yolo',
        },
        'Disable',
      )
      disable.addEventListener('click', () => {
        disable.disabled = true
        void api.security
          .disableGuardedYolo(threadId)
          .then(() => refreshAccess())
          .catch((error: unknown) => {
            disable.disabled = false
            showErrorToast('Could not disable Guarded YOLO', error)
          })
      })
      result.append(
        el(
          'div',
          { class: 'thread-context-row-wrap' },
          permissionRow(
            'Guarded YOLO',
            currentGrants.guardedYolo === 'armed' ? 'Armed' : 'Active',
            'Until Copse closes',
          ),
          disable,
        ),
      )
    }
    const { outsideReadPaths, browserOrigins } = currentGrants.context
    if (outsideReadPaths.length) {
      result.append(
        permissionRow(
          'Outside-project reads',
          `${String(outsideReadPaths.length)} session`,
          outsideReadPaths.join(', '),
        ),
      )
    }
    if (browserOrigins.length) {
      result.append(
        permissionRow(
          'Browser origins',
          `${String(browserOrigins.length)} session`,
          browserOrigins.join(', '),
        ),
      )
    }
    result.append(el('p', { class: 'thread-context-permission-label' }, 'Project'))
    result.append(
      permissionRow('Workspace trust', currentGrants.workspaceTrusted ? 'Trusted' : 'Untrusted'),
    )
    if (currentGrants.context.portBindingAllowed) {
      result.append(permissionRow('Local port binding', 'Granted', 'Saved for this checkout'))
    }
    result.append(el('p', { class: 'thread-context-permission-label' }, 'App-wide'))
    result.append(
      permissionRow('Saved web origins', String(currentGrants.savedWebOrigins)),
      permissionRow('Tool overrides', String(currentGrants.toolOverrides)),
    )
    const settings = el(
      'button',
      { type: 'button', class: 'thread-context-action', 'data-action': 'open-permission-settings' },
      'Manage app permissions',
    )
    settings.addEventListener('click', () => {
      openSettingsDialog('permissions')
    })
    result.append(el('div', { class: 'thread-context-section-actions' }, settings))
    return result
  }

  function decisionsSection(threadId: string): HTMLElement {
    const result = el(
      'section',
      { class: 'thread-context-section', 'data-context-section': 'decisions' },
      el('h5', {}, 'Recent decisions'),
    )
    if (accessFor !== threadId || !accessGrants) {
      result.append(emptyNote(accessStatus))
      return result
    }
    const recent = accessGrants.decisions.slice(-4).reverse()
    if (!recent.length) {
      result.append(emptyNote('No recorded decisions for this thread.'))
      return result
    }
    for (const decision of recent) {
      result.append(
        permissionRow(
          decision.subject,
          decision.verdict,
          [decision.kind, decision.remembered ? 'remembered' : null].filter(Boolean).join(' · '),
        ),
      )
    }
    result.append(
      el(
        'p',
        { class: 'thread-context-note' },
        `Showing the latest ${String(recent.length)} of ${String(accessGrants.decisions.length)} recorded decisions. Current access is shown above.`,
      ),
    )
    return result
  }

  async function refreshAccess(): Promise<void> {
    const threadId = getActiveThread(store)?.id
    const projectId = store.getState().activeProjectId
    if (!threadId || !projectId) return
    const mine = ++accessToken
    if (accessFor !== threadId) {
      accessFor = threadId
      accessGrants = null
      accessStatus = 'Checking…'
    }
    try {
      const project = store.getState().projects.find((candidate) => candidate.id === projectId)
      // Port-binding grants are saved per project, even for a worktree thread.
      const projectRoot = project?.path
      if (!projectRoot) return
      const [
        read,
        send,
        orchestrate,
        context,
        guardedYolo,
        trusted,
        savedOrigins,
        overrides,
        decisions,
      ] = await Promise.all([
        api.settings.get('threadReadAccess'),
        api.settings.get('threadSendAccess'),
        api.settings.get('threadSubthreadAccess'),
        api.security.getContextPermissions(projectId, threadId, projectRoot),
        api.security.getGuardedYolo(threadId),
        api.workspace.isTrusted(),
        api.settings.get('webAllowedOrigins'),
        api.settings.get('toolPermissionOverrides'),
        api.decisions.listThread(projectId, threadId),
      ])
      if (disposed || mine !== accessToken || getActiveThread(store)?.id !== threadId) return
      accessGrants = {
        read: Array.isArray(read) && read.includes(threadId),
        send: Array.isArray(send) && send.includes(threadId),
        orchestrate: Array.isArray(orchestrate) && orchestrate.includes(threadId),
        context,
        guardedYolo: guardedYolo.phase,
        workspaceTrusted: trusted,
        savedWebOrigins: Array.isArray(savedOrigins) ? savedOrigins.length : 0,
        toolOverrides:
          typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)
            ? Object.keys(overrides).length
            : 0,
        decisions,
      }
    } catch (error) {
      if (disposed || mine !== accessToken || getActiveThread(store)?.id !== threadId) return
      console.error('[context] thread permission lookup failed:', error)
      accessGrants = null
      accessStatus = 'Permissions unavailable.'
    }
    if (contextModeActive(store)) render()
  }
  const STORAGE_FRESH_MS = 5 * 60_000
  const CHANGES_FRESH_MS = 60_000

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
    const key = activeStorageKey()
    if (key !== changesKey) {
      changesKey = key
      changesText = 'Calculating…'
      changeStats = null
      changesCheckedAt = 0
      changesPending = false
    } else if (
      changesPending ||
      (changesCheckedAt && Date.now() - changesCheckedAt < CHANGES_FRESH_MS)
    ) {
      return
    }
    const mine = ++changesToken
    changesPending = true
    const update = (): void => {
      const slot = viewerRoot.querySelector('[data-context-change-stats]')
      if (slot) slot.replaceChildren(...changesContent())
    }
    try {
      const stats = await api.git.changeStats(projectId, thread.id)
      if (disposed || mine !== changesToken || key !== activeStorageKey()) return
      const next = stats ?? { additions: 0, deletions: 0 }
      changesCheckedAt = Date.now()
      if (changeStats?.additions === next.additions && changeStats.deletions === next.deletions)
        return
      changeStats = next
    } catch (error) {
      if (disposed || mine !== changesToken || key !== activeStorageKey()) return
      console.error('[context] change totals lookup failed:', error)
      changesCheckedAt = Date.now()
      if (!changeStats && changesText === 'Unavailable') return
      changeStats = null
      changesText = 'Unavailable'
    } finally {
      if (mine === changesToken) changesPending = false
    }
    update()
  }

  async function refreshStorage(): Promise<void> {
    void refreshChanges()
    const thread = getActiveThread(store)
    const projectId = store.getState().activeProjectId
    if (!thread || !projectId) return
    const key = activeStorageKey()
    if (key !== storageKey) {
      storageKey = key
      storageText = 'Calculating…'
      storageCheckedAt = 0
      storagePending = false
    } else if (
      storagePending ||
      (storageCheckedAt && Date.now() - storageCheckedAt < STORAGE_FRESH_MS)
    ) {
      return
    }
    const mine = ++storageToken
    storagePending = true
    const update = (): void => {
      const slot = viewerRoot.querySelector('[data-context-storage-size]')
      if (slot && slot.textContent !== storageText) slot.textContent = storageText
    }
    try {
      const [saved, checkout] = await Promise.all([
        api.threads.storageSize(projectId, thread.id),
        thread.worktree && thread.worktree.retiredAt === undefined
          ? api.worktrees.size(projectId, thread.worktree.path)
          : Promise.resolve({ bytes: 0, truncated: false }),
      ])
      if (disposed || mine !== storageToken || key !== activeStorageKey()) return
      storageCheckedAt = Date.now()
      const next = `${saved.truncated || checkout.truncated ? 'At least ' : ''}${formatByteSize(saved.bytes + checkout.bytes)}`
      if (storageText === next) return
      storageText = next
    } catch (error) {
      if (disposed || mine !== storageToken || key !== activeStorageKey()) return
      console.error('[context] storage lookup failed:', error)
      storageCheckedAt = Date.now()
      if (storageText === 'Unavailable') return
      storageText = 'Unavailable'
    } finally {
      if (mine === storageToken) storagePending = false
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
    jumpToReviewerInput: (messageId, requestId) => {
      store.emit('reviewer_input_jump', messageId, requestId)
    },
  }

  function render(): void {
    const state = store.getState()
    const thread = getActiveThread(store)
    if (!thread) {
      if (renderedKey === 'empty') return
      renderedKey = 'empty'
      clear(viewerRoot)
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
    const questions = reviewerInputRequests(thread).filter(
      (request) => !reviewerInputAnswer(thread.reviewerInputAnswers, request.id),
    )
    const agentQuestions =
      liveQuestions?.pending().filter((request) => request.threadId === thread.id) ?? []
    const approvalsLoaded = approvalsKey === activeStorageKey()
    const pending = approvalsLoaded ? approvals : []
    const key = JSON.stringify([
      state.activeProjectId,
      model,
      thread.archivedAt,
      questions,
      agentQuestions,
      pending,
      approvalsLoaded,
      approvalsError,
      accessFor,
      accessGrants,
      accessStatus,
    ])
    if (key === renderedKey) return
    renderedKey = key
    clear(viewerRoot)
    const content = renderThreadContext(model, handlers)
    reviewerInput.sync()
    const requestRows: HTMLElement[] = agentQuestions.map((request) => {
      const button = rowButton(
        { 'data-agent-question-id': request.id },
        el(
          'span',
          { class: 'thread-context-main' },
          el(
            'span',
            { class: 'thread-context-title', title: request.questions.join(' · ') },
            request.questions.join(' · '),
          ),
          el('span', { class: 'thread-context-sub' }, 'Agent question · Answer in Activity'),
        ),
      )
      button.addEventListener('click', openActivityPanel)
      return button
    })
    requestRows.push(
      ...pending.map((request) =>
        el(
          'div',
          { class: 'thread-context-row', 'data-deferred-approval-id': request.id },
          el(
            'span',
            { class: 'thread-context-main' },
            el('span', { class: 'thread-context-title', title: request.title }, request.title),
            el(
              'span',
              { class: 'thread-context-sub' },
              `Approval needed · Not run · ${request.subject}`,
            ),
          ),
        ),
      ),
    )
    const requestSection = section(
      'requests',
      ...(questions.length > 0 ? [reviewerInput.toggle, reviewerInput.panel] : []),
      ...(requestRows.length > 0
        ? [el('div', { class: 'thread-context-rows' }, ...requestRows)]
        : questions.length > 0
          ? []
          : [
              emptyNote(
                approvalsError && approvalsLoaded
                  ? 'Approval requests unavailable.'
                  : approvalsLoaded
                    ? 'Nothing waiting.'
                    : 'Checking requests…',
              ),
            ]),
    )
    content.querySelector('[data-context-section="subagents"]')?.before(requestSection)
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
      accessSection(thread.id),
      decisionsSection(thread.id),
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
    void refreshApprovals()
    void refreshAccess()
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

  async function refreshApprovals(): Promise<void> {
    const thread = getActiveThread(store)
    const projectId = store.getState().activeProjectId
    if (!thread || !projectId) return
    const mine = ++approvalsToken
    const key = activeStorageKey()
    // Keep showing this thread's last answer while the refresh is in flight, so
    // a routine update does not re-render Context.
    try {
      const rows = await api.threads.pendingApprovals(projectId, thread.id)
      if (disposed || mine !== approvalsToken || key !== activeStorageKey()) return
      approvals = rows
      approvalsError = false
    } catch (error) {
      if (disposed || mine !== approvalsToken || key !== activeStorageKey()) return
      console.error('[context] pending approvals lookup failed:', error)
      approvals = []
      approvalsError = true
    }
    approvalsKey = key
    if (contextModeActive(store)) render()
  }

  const offs = [
    store.on('reviewer_input_open', (requestId) => {
      openRightPanel(store, 'context')
      reviewerInput.open(requestId)
    }),
    store.on('tool_call_started', () => {
      if (contextModeActive(store)) reviewerInput.sync()
    }),
    store.on('tool_call_updated', () => {
      if (contextModeActive(store)) reviewerInput.sync()
    }),
    ...(liveQuestions
      ? [
          liveQuestions.onChange(() => {
            if (contextModeActive(store)) render()
          }),
        ]
      : []),
    api.security.onGuardedYoloChanged((state) => {
      if (contextModeActive(store) && getActiveThread(store)?.id === state.threadId) {
        void refreshAccess()
      }
    }),
    selectRightPanelMode(store, 'context', (active) => {
      if (!active) return
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
      approvalsKey = ''
      approvalsToken++
      storageKey = ''
      changesKey = ''
      changesToken++
      accessToken++
      accessFor = null
      accessGrants = null
      token++
      storageToken++
      if (contextModeActive(store)) {
        render()
        void refreshMentions()
      }
    }),
  ]
  if (contextModeActive(store)) {
    render()
    void refreshMentions()
  }
  return () => {
    disposed = true
    token++
    storageToken++
    changesToken++
    approvalsToken++
    accessToken++
    for (const off of offs) off()
  }
}
