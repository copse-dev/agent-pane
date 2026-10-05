// The new-thread screen host: placement before the composer, unique ids beside
// the overlay, drawing only while shown, leaving focus with the composer, folding
// groups, and filtering by project from the strip.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { BackgroundThread, Thread } from '@shared/types'
import { createPendingApi } from '../fake-api.test-support.ts'
import { mountActivityHome } from './activity-home.ts'
import { mountActivityPanel } from './activity-panel.ts'
import type { ApprovalRequests, PendingApprovalSummary } from './approval-dialog.ts'
import type { AskUserRequests } from './ask-user-dialog.ts'

const noApprovals: ApprovalRequests = {
  pending: () => [],
  answerOnce: () => false,
  onChange: () => () => {},
}
const noQuestions: AskUserRequests = { pending: () => [], onChange: () => () => {} }

function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function approval(id: string, threadId: string): PendingApprovalSummary {
  return {
    id,
    threadId,
    title: 'Run shell command?',
    body: 'pnpm test',
    bodyAdvice: undefined,
    bodyFooter: undefined,
    type: 'shell',
    receivedAt: 1_000_000,
  }
}

interface MountOptions {
  background?: BackgroundThread[]
  approvals?: PendingApprovalSummary[]
}

interface Mounted {
  store: AppStore
  pane: HTMLElement
  composer: HTMLElement
  home: ReturnType<typeof mountActivityHome>
  flush: () => void
  /** Replace the pending approvals and tell the view, as the approval dialog does. */
  setApprovals: (next: PendingApprovalSummary[]) => void
}

function mount(threads: Thread[], options: MountOptions = {}): Mounted {
  const pane = document.createElement('main')
  pane.id = 'pane-chat'
  const input = document.createElement('div')
  input.id = 'input-bar'
  const composer = document.createElement('textarea')
  composer.className = 'prompt-input'
  input.append(composer)
  pane.append(input)
  document.body.append(pane)

  const store = createStore({
    projects: [
      { id: 'p1', path: '/work', name: 'workspace' },
      { id: 'p2', path: '/docs', name: 'docs-site' },
    ],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    workspaceRoot: '/work',
    threads,
    backgroundThreads: options.background ?? [],
    activeThreadId: threads[0]?.id ?? null,
  })
  // Queued, never self-running: a view that re-arms its age tick would loop.
  const queued: Array<() => void> = []
  const deps = {
    now: (): number => 1_000_000,
    setTimer: (fn: () => void): (() => void) => {
      queued.push(fn)
      return (): void => {}
    },
  }
  let pending = options.approvals ?? []
  const listeners: Array<() => void> = []
  const approvals: ApprovalRequests = {
    pending: () => pending,
    answerOnce: () => false,
    onChange: (listener) => {
      listeners.push(listener)
      return (): void => {}
    },
  }
  const home = mountActivityHome(
    pane,
    createPendingApi({}),
    store,
    { approvals, questions: noQuestions },
    deps,
  )
  const flush = (): void => {
    for (const fn of queued.splice(0)) fn()
  }
  return {
    store,
    pane,
    composer,
    home,
    flush,
    setApprovals: (next): void => {
      pending = next
      for (const listener of listeners) listener()
      flush()
    },
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

function rows(pane: HTMLElement): string[] {
  return [...pane.querySelectorAll('#activity-home .activity-row .activity-thread')].map(
    (node) => node.textContent,
  )
}

function toggle(pane: HTMLElement, group: string): HTMLButtonElement {
  const found = pane.querySelector<HTMLButtonElement>(
    `#activity-home [data-group-toggle="${group}"]`,
  )
  assert.ok(found, `expected the ${group} header`)
  return found
}

function card(pane: HTMLElement, project: string): HTMLButtonElement {
  const found = pane.querySelector<HTMLButtonElement>(
    `#activity-home .activity-strip-card[data-project="${project}"]`,
  )
  assert.ok(found, `expected the ${project} tile`)
  return found
}

describe('activity home', () => {
  it('mounts hidden, before the composer', () => {
    const { pane } = mount([thread('t1', { status: 'running' })])
    const root = pane.querySelector<HTMLElement>('#activity-home')
    assert.ok(root)
    assert.equal(root.hidden, true)
    assert.ok(root.nextElementSibling?.id === 'input-bar', 'the home must sit before #input-bar')
    assert.equal(root.querySelectorAll('.activity-row').length, 0, 'nothing is drawn while hidden')
  })

  it('draws on show without taking focus from the composer', () => {
    const { pane, composer, home } = mount([thread('t1', { status: 'running' })])
    composer.focus()
    home.setShown(true)

    assert.equal(pane.querySelector<HTMLElement>('#activity-home')?.hidden, false)
    assert.ok(toggle(pane, 'working'), 'the Working header is drawn')
    assert.ok(document.activeElement === composer, 'the composer keeps focus')
  })

  it('steps aside for the composer while nothing is running or waiting', () => {
    const { store, pane, home, flush } = mount([thread('t1')])
    home.setShown(true)
    const root = pane.querySelector<HTMLElement>('#activity-home')
    assert.equal(root?.dataset['idle'], 'true')
    assert.ok(pane.classList.contains('is-activity-idle'))

    store.setState({ threads: [thread('t1'), thread('t2', { status: 'running' })] })
    store.emit('thread_status_changed', 't2', 'running')
    flush()
    assert.equal(root.dataset['idle'], 'false', 'a run arriving brings the screen back')
    assert.equal(pane.classList.contains('is-activity-idle'), false)

    home.setShown(false)
    assert.equal(pane.classList.contains('is-activity-idle'), false, 'hiding clears the class')
  })

  it('stops drawing once hidden', () => {
    const { store, pane, home, flush } = mount([thread('t1', { status: 'running' })])
    home.setShown(true)
    assert.equal(toggle(pane, 'working').querySelector('.activity-group-count')?.textContent, '1')
    home.setShown(false)
    assert.equal(pane.querySelector<HTMLElement>('#activity-home')?.hidden, true)

    store.setState({ threads: [thread('t1', { status: 'running' }), thread('t2')] })
    store.emit('thread_status_changed', 't2', 'running')
    flush()
    assert.equal(
      pane.querySelector('#activity-home [data-group-toggle="working"] .activity-group-count')
        ?.textContent,
      '1',
      'a hidden home must not redraw',
    )
  })

  it('shares no element id with the overlay once both are drawn', () => {
    const opened = function (this: HTMLDialogElement): void {
      this.open = true
    }
    Object.defineProperties(window.HTMLDialogElement.prototype, {
      show: { configurable: true, value: opened },
      showModal: { configurable: true, value: opened },
    })
    const { store, home } = mount([thread('t1', { status: 'running' })])
    const deps = { now: (): number => 1_000_000, setTimer: (): (() => void) => () => {} }
    const panel = mountActivityPanel(
      createPendingApi({}),
      store,
      { approvals: noApprovals, questions: noQuestions },
      deps,
    )
    home.setShown(true)
    panel.open()

    // A group title exists in both hosts now.
    assert.ok(document.querySelector('#activity-home .activity-group-title'))
    assert.ok(document.querySelector('#activity-panel .activity-group-title'))
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id)
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
    assert.deepEqual(duplicates, [])
  })
})

describe('activity home groups', () => {
  it('starts with Working folded, naming how many it holds, and unfolds on a click', () => {
    const { pane, home } = mount([
      thread('t1', { status: 'running' }),
      thread('t2', { status: 'running' }),
    ])
    home.setShown(true)

    const header = toggle(pane, 'working')
    assert.equal(header.getAttribute('aria-expanded'), 'false')
    assert.equal(header.querySelector<HTMLElement>('.activity-group-count')?.hidden, false)
    assert.equal(header.querySelector('.activity-group-count')?.textContent, '2')
    assert.deepEqual(rows(pane), [], 'a folded group draws no rows')

    header.click()
    assert.equal(toggle(pane, 'working').getAttribute('aria-expanded'), 'true')
    assert.deepEqual(rows(pane).sort(), ['t1', 't2'])
    assert.equal(
      toggle(pane, 'working').querySelector<HTMLElement>('.activity-group-count')?.hidden,
      true,
      'an open group shows its rows instead of a count',
    )

    toggle(pane, 'working').click()
    assert.deepEqual(rows(pane), [])
  })

  it('keeps focus on the header it was used from', () => {
    const { pane, home } = mount([thread('t1', { status: 'running' })])
    home.setShown(true)
    const header = toggle(pane, 'working')
    header.focus()
    header.click()
    assert.ok(
      document.activeElement === toggle(pane, 'working'),
      'a redraw must not pull focus off the header',
    )
  })

  it('unfolds Needs you when a new request arrives, but leaves a request already seen folded', () => {
    const { pane, home, setApprovals } = mount([thread('t1'), thread('t2')], {
      approvals: [approval('a1', 't1')],
    })
    home.setShown(true)
    assert.deepEqual(rows(pane), ['t1'], 'a waiting request is drawn')

    toggle(pane, 'needs-you').click()
    assert.deepEqual(rows(pane), [], 'the user folded it')

    // The same request again: it was already seen, so the group stays folded.
    setApprovals([approval('a1', 't1')])
    assert.deepEqual(rows(pane), [])

    // A new request unfolds it, so it cannot hide behind a header.
    setApprovals([approval('a1', 't1'), approval('a2', 't2')])
    assert.deepEqual(rows(pane).sort(), ['t1', 't2'])
  })

  it('moves the selection off a row whose group is folded', () => {
    const { pane, home } = mount([thread('t1', { status: 'running' }), thread('t2')], {
      approvals: [approval('a1', 't2')],
    })
    home.setShown(true)
    toggle(pane, 'working').click()
    pane
      .querySelector<HTMLButtonElement>('#activity-home .activity-row[data-state="working"] button')
      ?.click()
    assert.equal(
      pane.querySelector('#activity-home .activity-row[data-selected]')?.getAttribute('data-state'),
      'working',
    )

    toggle(pane, 'working').click()
    assert.equal(
      pane.querySelector('#activity-home .activity-row[data-selected]')?.getAttribute('data-state'),
      'needs-approval',
      'selection falls to the nearest visible row',
    )
  })
})

describe('activity home selection', () => {
  const selectedTitle = (pane: HTMLElement): string | null | undefined =>
    pane.querySelector('#activity-home .activity-row[data-selected] .activity-thread')?.textContent

  it('follows the most urgent row until the user chooses one', () => {
    // t2 finished while the user was elsewhere; t1 and t3 are idle until a request lands.
    const { pane, home, setApprovals } = mount([
      thread('t1'),
      thread('t2', { unreadAt: 900_000 }),
      thread('t3'),
    ])
    home.setShown(true)
    assert.equal(selectedTitle(pane), 't2', 'only the finished row exists')

    setApprovals([approval('a1', 't1')])
    assert.equal(selectedTitle(pane), 't1', 'a request that arrives is shown without a click')

    pane
      .querySelector<HTMLButtonElement>('#activity-home .activity-row[data-thread-id="t2"] button')
      ?.click()
    assert.equal(selectedTitle(pane), 't2')

    setApprovals([approval('a1', 't1'), approval('a2', 't3')])
    assert.equal(selectedTitle(pane), 't2', 'a row the user chose never moves under them')
  })

  it('starts the next visit on the most urgent row again', () => {
    const { pane, home } = mount([thread('t1'), thread('t2', { unreadAt: 900_000 })], {
      approvals: [approval('a1', 't1')],
    })
    home.setShown(true)
    pane
      .querySelector<HTMLButtonElement>('#activity-home .activity-row[data-thread-id="t2"] button')
      ?.click()
    assert.equal(selectedTitle(pane), 't2')

    home.setShown(false)
    home.setShown(true)
    assert.equal(selectedTitle(pane), 't1')
  })
})

describe('activity home project strip', () => {
  const background: BackgroundThread[] = [
    { projectId: 'p2', thread: thread('d1', { status: 'running' }) },
  ]

  it('lists All projects first, then the projects that need you', () => {
    const { pane, home } = mount([thread('t1', { status: 'running' }), thread('t2')], {
      background,
      approvals: [approval('a1', 't2')],
    })
    home.setShown(true)

    const names = [...pane.querySelectorAll('#activity-home .activity-strip-name')].map(
      (node) => node.textContent,
    )
    assert.deepEqual(names, ['All projects', 'workspace'], 'docs-site has nothing waiting')
    assert.match(card(pane, 'all').textContent, /1 need you/)
    assert.match(card(pane, 'all').textContent, /2 working/)
    assert.equal(card(pane, 'all').getAttribute('aria-pressed'), 'true')
  })

  it('restores project-card focus for supported ids containing selector syntax', () => {
    const projectId = 'workspace"[]\\copse'
    const { store, pane, home, setApprovals } = mount([thread('t1'), thread('t2')], {
      approvals: [approval('a1', 't1')],
    })
    store.setState({
      projects: [{ id: projectId, path: '/work', name: 'workspace' }],
      activeProjectId: projectId,
      expandedProjectId: projectId,
    })
    home.setShown(true)
    const projectCard = (): HTMLButtonElement | undefined =>
      [...pane.querySelectorAll<HTMLButtonElement>('.activity-strip-card')].find(
        (node) => node.dataset['project'] === projectId,
      )
    const before = projectCard()
    assert.ok(before)
    before.focus()
    setApprovals([approval('a1', 't1'), approval('a2', 't2')])
    const after = projectCard()
    assert.ok(after)
    assert.notEqual(after, before, 'the changed count replaces the cached card')
    assert.equal(document.activeElement, after, 'focus follows the exact project id')
  })

  it('distinguishes a supported project id of all from the aggregate filter', () => {
    const { store, pane, home } = mount([thread('t1')], {
      background: [{ projectId: 'p2', thread: thread('t2') }],
      approvals: [approval('a1', 't1'), approval('a2', 't2')],
    })
    store.setState({
      projects: [
        { id: 'all', path: '/work', name: 'All workspace' },
        { id: 'p2', path: '/docs', name: 'docs-site' },
      ],
      activeProjectId: 'all',
      expandedProjectId: 'all',
    })
    home.setShown(true)
    const cards = [...pane.querySelectorAll<HTMLButtonElement>('.activity-strip-card')]
    const aggregate = cards.find((node) => node.textContent.startsWith('All projects'))
    const project = cards.find((node) => node.textContent.startsWith('All workspace'))
    assert.ok(aggregate)
    assert.ok(project)
    assert.notEqual(aggregate, project)
    project.click()
    assert.deepEqual(rows(pane), ['t1'], 'the real all project filters out another project')
    const updatedCards = [...pane.querySelectorAll<HTMLButtonElement>('.activity-strip-card')]
    const updatedProject = updatedCards.find(
      (node) => node.dataset['projectKey'] === JSON.stringify('all'),
    )
    const updatedAggregate = updatedCards.find((node) => node.dataset['projectKey'] === 'null')
    assert.ok(updatedProject)
    assert.ok(updatedAggregate)
    assert.equal(updatedProject.getAttribute('aria-pressed'), 'true')
    assert.equal(updatedAggregate.getAttribute('aria-pressed'), 'false')
    updatedAggregate.click()
    assert.deepEqual(rows(pane).sort(), ['t1', 't2'])
  })

  it('counts orphan approvals in All projects even without a project association', () => {
    const { pane, home } = mount([], {
      approvals: [{ ...approval('orphan', 'missing'), threadId: undefined }],
    })
    home.setShown(true)
    assert.equal(pane.querySelectorAll('.activity-row[data-state="needs-approval"]').length, 1)
    assert.match(card(pane, 'all').textContent, /1 need you/)
    assert.doesNotMatch(card(pane, 'all').textContent, /All clear/)
  })

  it('narrows the list to a project and back', () => {
    const { pane, home } = mount([thread('t1', { status: 'running' }), thread('t2')], {
      background,
      approvals: [approval('a1', 't2')],
    })
    home.setShown(true)
    toggle(pane, 'working').click()
    assert.deepEqual(rows(pane).sort(), ['d1', 't1', 't2'])

    card(pane, 'p1').click()
    assert.deepEqual(rows(pane).sort(), ['t1', 't2'], 'docs-site is filtered out')
    assert.equal(card(pane, 'p1').getAttribute('aria-pressed'), 'true')

    card(pane, 'all').click()
    assert.deepEqual(rows(pane).sort(), ['d1', 't1', 't2'])
  })

  it('keeps the chosen project visible after its last pending request settles', () => {
    const { pane, home, setApprovals } = mount([thread('t1')], {
      background,
      approvals: [approval('a1', 't1')],
    })
    home.setShown(true)
    card(pane, 'p1').click()
    setApprovals([])

    assert.equal(card(pane, 'p1').getAttribute('aria-pressed'), 'true')
    assert.match(card(pane, 'p1').textContent, /All clear/)
    assert.equal(card(pane, 'all').getAttribute('aria-pressed'), 'false')
    card(pane, 'all').click()
    toggle(pane, 'working').click()
    assert.deepEqual(rows(pane), ['d1'], 'the user can leave the empty project filter')
  })
})
