// The Activity view on its own, behind a fake host: it draws only while the host
// says it is shown, reports the needs-you count, hands focus to the host when no
// row can hold it, and forgets everything on hide(). The overlay's behaviour
// around it is covered by activity-panel.test.ts.
import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { createPendingApi } from '../fake-api.test-support.ts'
import type { ApprovalRequests } from './approval-dialog.ts'
import type { AskUserRequests, PendingQuestionSummary } from './ask-user-dialog.ts'
import {
  createActivityView,
  ACTIVITY_AGE_REFRESH_MS as VIEW_AGE_REFRESH_MS,
  type ActivityView,
  type ActivityViewHost,
} from './activity-view.ts'
import {
  ACTIVITY_AGE_REFRESH_MS,
  type ActivityPanelDeps,
  type ActivitySources,
} from './activity-panel.ts'

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

const noApprovals: ApprovalRequests = {
  pending: () => [],
  answerOnce: () => false,
  onChange: () => () => {},
}

const noQuestions: AskUserRequests = {
  pending: () => [],
  answer: () => false,
  onChange: () => () => {},
}

interface HostState {
  shown: boolean
  fallbackFocus: number
  needsYou: number[]
  clock: number
}

interface Harness {
  store: AppStore
  view: ActivityView
  state: HostState
  flush: () => void
}

function setup(threads: Thread[], questions: AskUserRequests = noQuestions): Harness {
  const store = createStore({
    projects: [{ id: 'p1', path: '/work', name: 'workspace' }],
    activeProjectId: 'p1',
    expandedProjectId: 'p1',
    workspaceRoot: '/work',
    threads,
    activeThreadId: threads[0]?.id ?? null,
  })
  // Timers are queued, never run on their own: a view that re-arms its age tick
  // would otherwise loop forever. flush() runs what is due once.
  const queued: Array<() => void> = []
  const needsYou: number[] = []
  const state: HostState = { shown: false, fallbackFocus: 0, needsYou, clock: 1_000_000 }
  const host: ActivityViewHost = {
    idPrefix: 'test',
    close: () => {},
    isShown: () => state.shown,
    fallbackFocus: () => {
      state.fallbackFocus += 1
    },
    onNeedsYou: (count) => {
      state.needsYou.push(count)
    },
  }
  // Existing panel callers retain these named type imports after extraction.
  const sources: ActivitySources = { approvals: noApprovals, questions }
  const deps: ActivityPanelDeps = {
    now: () => state.clock,
    setTimer: (fn) => {
      queued.push(fn)
      return (): void => {}
    },
  }
  const view = createActivityView(createPendingApi({}), store, sources, deps, host)
  const flush = (): void => {
    for (const fn of queued.splice(0)) fn()
  }
  return { store, view, state, flush }
}

function rowCount(view: { body: HTMLElement }): number {
  return view.body.querySelectorAll('.activity-row').length
}

describe('activity view', () => {
  it('preserves the age refresh constant at the original panel module path', () => {
    assert.equal(ACTIVITY_AGE_REFRESH_MS, VIEW_AGE_REFRESH_MS)
  })
  it('draws nothing for a store change while the host has it hidden', () => {
    const { store, view, state, flush } = setup([thread('t1', { status: 'running' })])
    store.emit('thread_status_changed', 't1', 'running')
    flush()
    assert.equal(rowCount(view), 0)
    assert.deepEqual(state.needsYou, [])
  })

  it('draws on show(), reports the needs-you count and keeps focus with a row', () => {
    const { view, state } = setup([thread('t1', { status: 'running' })])
    state.shown = true
    view.show()
    assert.equal(rowCount(view), 1)
    assert.deepEqual(state.needsYou, [0])
    assert.equal(state.fallbackFocus, 0)
    assert.equal(view.body.querySelector('.activity-row')?.getAttribute('data-state'), 'working')
  })

  it('hands focus to the host when there is no row to hold it', () => {
    const { view, state } = setup([thread('t1')])
    state.shown = true
    view.show()
    assert.equal(rowCount(view), 0)
    assert.equal(state.fallbackFocus, 1)
    assert.ok(view.body.querySelector('.activity-empty'))
  })

  it('redraws on a store change while shown, and stops once hidden', () => {
    const { store, view, state, flush } = setup([thread('t1')])
    state.shown = true
    view.show()
    assert.equal(rowCount(view), 0)

    store.setState({ threads: [thread('t1', { status: 'running' })] })
    store.emit('thread_status_changed', 't1', 'running')
    flush()
    assert.equal(rowCount(view), 1)

    state.shown = false
    view.hide()
    store.setState({ threads: [thread('t1'), thread('t2', { status: 'running' })] })
    store.emit('thread_status_changed', 't2', 'running')
    flush()
    assert.equal(rowCount(view), 0, 'a hidden view must release rows and not redraw')
    assert.equal(view.status.textContent, '')
  })

  it('selects the most urgent row afresh on every show()', () => {
    const { view, state } = setup([thread('t1', { status: 'running' })])
    state.shown = true
    view.show()
    const first = view.body.querySelector('.activity-row')?.getAttribute('data-row-key')
    assert.ok(first)
    state.shown = false
    view.hide()
    state.shown = true
    view.show()
    assert.equal(
      view.body.querySelector('.activity-row[data-selected]')?.getAttribute('data-row-key'),
      first,
    )
  })
  describe('redraws', () => {
    function rowNode(view: ActivityView, key: string): HTMLElement {
      const found = view.body.querySelector<HTMLElement>(`.activity-row[data-row-key="${key}"]`)
      assert.ok(found, `expected row ${key}`)
      return found
    }

    /** Two running threads; t2 started later, so it sorts first. */
    function twoRunning(): Harness {
      const harness = setup([thread('t1', { status: 'running' }), thread('t2')])
      const { store, state, view, flush } = harness
      // Attached, so focus() behaves as it does on screen.
      document.body.replaceChildren(view.body)
      state.shown = true
      state.clock = 1_000_000
      store.emit('thread_status_changed', 't1', 'running')
      state.clock = 1_001_000
      store.setState({
        threads: [thread('t1', { status: 'running' }), thread('t2', { status: 'running' })],
      })
      store.emit('thread_status_changed', 't2', 'running')
      view.show()
      flush()
      return harness
    }

    it('keeps an untouched row and its group as the same nodes', () => {
      const { store, view, flush } = twoRunning()
      const t2 = rowNode(view, 'thread:t2')
      const section = view.body.querySelector('.activity-group[data-group="working"]')
      assert.ok(section)

      store.emit('agent_activity', 't1', 'Running tests…')
      flush()

      assert.ok(rowNode(view, 'thread:t2') === t2, 'an unchanged row must not be rebuilt')
      assert.ok(
        view.body.querySelector('.activity-group[data-group="working"]') === section,
        'the group must keep its section',
      )
      assert.match(rowNode(view, 'thread:t1').textContent, /Running tests/)
    })

    it('keeps focus on an untouched row while another row changes', () => {
      const { store, view, flush } = twoRunning()
      const opener = rowNode(view, 'thread:t2').querySelector<HTMLButtonElement>(
        '.activity-row-open',
      )
      assert.ok(opener)
      opener.focus()
      assert.ok(document.activeElement === opener, 'focus must stay on the untouched row')

      store.emit('agent_activity', 't1', 'Reading files…')
      flush()

      assert.ok(document.activeElement === opener, 'focus must stay on the untouched row')
    })

    it('rebuilds a row when its selection changes', () => {
      const { view } = twoRunning()
      const t1 = rowNode(view, 'thread:t1')
      const before = t1.hasAttribute('data-selected')
      t1.querySelector<HTMLButtonElement>('.activity-row-open')?.click()
      const after = rowNode(view, 'thread:t1')
      assert.notEqual(before, after.hasAttribute('data-selected'))
    })

    it('clears cached row descendants when a group empties but another remains', () => {
      const { store, view, state, flush } = twoRunning()
      const working = view.body.querySelector('.activity-group[data-group="working"]')
      assert.ok(working)
      state.clock = 1_002_000
      store.setState({ threads: [thread('t1'), thread('t2')] })
      store.emit('thread_status_changed', 't1', 'idle')
      store.emit('thread_status_changed', 't2', 'idle')
      flush()
      assert.equal(view.body.contains(working), false)
      assert.equal(working.querySelectorAll('.activity-row').length, 0)
      assert.equal(rowCount(view), 2, 'finished runs remain in the recent group')
    })

    it('clears cached row descendants when every group empties', () => {
      const { store, view, flush } = twoRunning()
      const working = view.body.querySelector('.activity-group[data-group="working"]')
      assert.ok(working)
      store.setState({ threads: [] })
      store.emit('threads_changed')
      flush()
      assert.equal(rowCount(view), 0)
      assert.equal(working.querySelectorAll('.activity-row').length, 0)
      assert.ok(view.body.querySelector('.activity-empty'))
    })

    it('clears cached row descendants on hide and rebuilds them on show', () => {
      const { view, state } = twoRunning()
      const working = view.body.querySelector('.activity-group[data-group="working"]')
      assert.ok(working)
      state.shown = false
      view.hide()
      assert.equal(working.querySelectorAll('.activity-row').length, 0)
      state.shown = true
      view.show()
      assert.equal(rowCount(view), 2)
      assert.equal(working.querySelectorAll('.activity-row').length, 2)
    })

    it('drops a row that leaves the list and forgets it', () => {
      const { store, view, state, flush } = twoRunning()
      state.clock = 1_002_000
      store.setState({ threads: [thread('t1', { status: 'running' }), thread('t2')] })
      store.emit('thread_status_changed', 't2', 'idle')
      flush()
      assert.equal(
        view.body.querySelector('.activity-group[data-group="working"] [data-row-key="thread:t2"]'),
        null,
      )
      assert.ok(
        view.body.querySelector('.activity-group[data-group="recent"] [data-row-key="thread:t2"]'),
        'the finished run is listed under Recently finished',
      )
    })
  })
})

/** A question source the test can drive: pending questions, and every answer sent. */
function fakeQuestions(initial: PendingQuestionSummary[]): {
  source: AskUserRequests
  answers: Array<{ id: string; answers: readonly string[] }>
  settle: (id: string) => void
  accept: { value: boolean }
} {
  let pending = initial
  const listeners = new Set<() => void>()
  const answers: Array<{ id: string; answers: readonly string[] }> = []
  const accept = { value: true }
  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }
  return {
    answers,
    accept,
    settle: (id): void => {
      pending = pending.filter((request) => request.id !== id)
      notify()
    },
    source: {
      pending: () => pending,
      answer: (id, given): boolean => {
        answers.push({ id, answers: given })
        if (!accept.value) return false
        pending = pending.filter((request) => request.id !== id)
        notify()
        return true
      },
      onChange: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
}

const ASKED: PendingQuestionSummary = {
  id: 'ask1',
  threadId: 't1',
  questions: ['Which database?', 'Why?'],
  options: [['Postgres', 'SQLite'], []],
  receivedAt: 1,
}

function showAsked(asked: PendingQuestionSummary[] = [ASKED]): {
  harness: Harness
  fake: ReturnType<typeof fakeQuestions>
} {
  const fake = fakeQuestions(asked)
  const harness = setup([thread('t1')], fake.source)
  document.body.append(harness.view.body, harness.view.status)
  harness.state.shown = true
  harness.view.show()
  // A question new to the pane waits out its settle window, as an approval does.
  harness.flush()
  return { harness, fake }
}

function field(harness: Harness, index: number): HTMLTextAreaElement {
  const found = harness.view.body.querySelector<HTMLTextAreaElement>(
    `[data-control="answer-${String(index)}"]`,
  )
  if (!found) throw new Error(`no answer field ${String(index)}`)
  return found
}

function typeInto(input: HTMLTextAreaElement, text: string): void {
  input.value = text
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function sendButton(harness: Harness): HTMLButtonElement {
  const found = harness.view.body.querySelector<HTMLButtonElement>('.activity-answer')
  if (!found) throw new Error('no Send answer button')
  return found
}

describe('activity view answering a question in place', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('shows each question with its quick answers and a field, Send answer off until typed', () => {
    const { harness } = showAsked()
    const body = harness.view.body
    assert.deepEqual(
      Array.from(body.querySelectorAll('.activity-question')).map((node) => node.textContent),
      ['Which database?', 'Why?'],
    )
    assert.deepEqual(
      Array.from(body.querySelectorAll('.activity-option')).map((node) => node.textContent),
      ['Postgres', 'SQLite'],
    )
    assert.equal(body.querySelectorAll('.activity-answer-input').length, 2)
    assert.equal(sendButton(harness).textContent, 'Send answer')
    assert.equal(sendButton(harness).disabled, true)
  })

  it('fills the field from a quick answer without sending it', () => {
    const { harness, fake } = showAsked()
    harness.view.body.querySelector<HTMLButtonElement>('.activity-option')?.click()

    assert.equal(field(harness, 0).value, 'Postgres')
    assert.equal(sendButton(harness).disabled, false)
    assert.deepEqual(fake.answers, [])
  })

  it('sends one answer per question, in order, and says so', () => {
    const { harness, fake } = showAsked()
    typeInto(field(harness, 0), 'Postgres')
    typeInto(field(harness, 1), 'It scales')
    sendButton(harness).click()

    assert.deepEqual(fake.answers, [{ id: 'ask1', answers: ['Postgres', 'It scales'] }])
    assert.equal(harness.view.status.textContent, 'Answered t1.')
  })

  it('sends an unanswered question as an empty answer rather than dropping it', () => {
    const { harness, fake } = showAsked()
    typeInto(field(harness, 1), 'Because')
    sendButton(harness).click()

    assert.deepEqual(fake.answers, [{ id: 'ask1', answers: ['', 'Because'] }])
  })

  it('sends on Cmd+Enter in a field', () => {
    const { harness, fake } = showAsked()
    const input = field(harness, 0)
    typeInto(input, 'SQLite')
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    )

    assert.deepEqual(fake.answers, [{ id: 'ask1', answers: ['SQLite', ''] }])
  })

  it('fills a field with the rendered label of a Markdown quick answer, and renders the question', () => {
    const { harness, fake } = showAsked([
      {
        ...ASKED,
        questions: ['Run `npm test` first?'],
        options: [['Run `npm test`', 'Skip it']],
      },
    ])
    assert.equal(
      harness.view.body.querySelector('.activity-question code')?.textContent,
      'npm test',
    )
    harness.view.body.querySelector<HTMLButtonElement>('.activity-option')?.click()

    assert.equal(field(harness, 0).value, 'Run npm test', 'no raw backticks go to the agent')
    sendButton(harness).click()
    assert.deepEqual(fake.answers, [{ id: 'ask1', answers: ['Run npm test'] }])
  })

  it('keeps the draft when the send did not go', () => {
    const { harness, fake } = showAsked([ASKED, { ...ASKED, id: 'ask2', receivedAt: 2 }])
    fake.accept.value = false
    typeInto(field(harness, 0), 'Postgres')
    sendButton(harness).click()
    // The question is still pending (the fake refused it), so a redraw brings the
    // form back with the text in it.
    harness.store.emit('thread_status_changed', 't1', 'idle')
    harness.flush()

    assert.equal(field(harness, 0).value, 'Postgres')
  })

  it('reports a question that was answered elsewhere first', () => {
    const { harness, fake } = showAsked()
    fake.accept.value = false
    typeInto(field(harness, 0), 'Postgres')
    sendButton(harness).click()

    assert.equal(harness.view.status.textContent, 'That question was already answered.')
  })

  it('keeps a half-written answer across a redraw', () => {
    const { harness, fake } = showAsked([
      ASKED,
      { ...ASKED, id: 'ask2', questions: ['Other?'], options: [[]], receivedAt: 2 },
    ])
    typeInto(field(harness, 0), 'Post')
    // Another question lands while the field is not focused: the pane redraws.
    harness.store.emit('thread_status_changed', 't1', 'idle')
    harness.flush()
    fake.settle('ask2')
    harness.flush()
    assert.equal(field(harness, 0).value, 'Post')
    // The list changed, so Send waits out the settle window before it is live again.
    harness.flush()

    assert.equal(sendButton(harness).disabled, false)
  })

  it('does not rebuild the pane under someone who is typing in it', () => {
    const { harness, fake } = showAsked([
      ASKED,
      { ...ASKED, id: 'ask2', questions: ['Other?'], options: [[]], receivedAt: 2 },
    ])
    const input = field(harness, 0)
    input.focus()
    typeInto(input, 'Post')
    fake.settle('ask2')
    harness.flush()

    assert.ok(field(harness, 0) === input, 'the same field node is still on screen')
    assert.ok(document.activeElement === input)
    assert.equal(input.value, 'Post')
  })

  it('holds Send answer off when another question takes the place of the one in view', () => {
    const { harness, fake } = showAsked([ASKED, { ...ASKED, id: 'ask2', receivedAt: 2 }])
    const open = (key: string): void => {
      harness.view.body
        .querySelector<HTMLElement>(`.activity-row[data-row-key="${key}"] .activity-row-open`)
        ?.click()
      harness.flush()
      harness.flush()
    }
    open('question:ask2')
    typeInto(field(harness, 0), 'for the second')
    open('question:ask1')
    typeInto(field(harness, 0), 'for the first')
    assert.equal(sendButton(harness).disabled, false)

    // The question in view is withdrawn; the other, with its draft, takes its place
    // under the pointer. A click aimed at the old button must not send that draft.
    fake.settle('ask1')
    harness.flush()
    assert.equal(field(harness, 0).value, 'for the second')
    assert.equal(sendButton(harness).disabled, true, 'Send waits for the pane to settle')

    harness.flush()
    assert.equal(sendButton(harness).disabled, false, 'and comes back once it has')
    assert.deepEqual(fake.answers, [])
  })

  it('does not send on Cmd+Enter while the pane is settling', () => {
    const { harness, fake } = showAsked([ASKED, { ...ASKED, id: 'ask2', receivedAt: 2 }])
    harness.view.body
      .querySelector<HTMLElement>('.activity-row[data-row-key="question:ask2"] .activity-row-open')
      ?.click()
    harness.flush()
    harness.flush()
    const input = field(harness, 0)
    typeInto(input, 'for the second')
    fake.settle('ask1')
    harness.flush()
    field(harness, 0).dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    )

    assert.deepEqual(fake.answers, [])
  })

  it('forgets a draft once its question is gone', () => {
    const { harness, fake } = showAsked()
    typeInto(field(harness, 0), 'Postgres')
    fake.settle('ask1')
    harness.flush()

    assert.equal(harness.view.body.querySelectorAll('.activity-answer-input').length, 0)
  })
})

describe('activity view folding an automation schedule', () => {
  const run = (id: string, patch: Partial<Thread> = {}): Thread =>
    thread(id, {
      unreadAt: 500,
      automation: { scheduleId: 'docs', scheduleName: 'Docs freshness', triggeredAt: 1 },
      ...patch,
    })
  const keys = (view: ActivityView): Array<string | undefined> =>
    Array.from(view.body.querySelectorAll<HTMLElement>('.activity-row')).map(
      (row) => row.dataset['rowKey'],
    )

  it("draws a schedule's settled runs as one row that opens out into them", () => {
    const { view, state } = setup([thread('chat'), run('a'), run('b'), run('c')])
    state.shown = true
    view.show()
    assert.equal(rowCount(view), 1)
    const toggle = view.body.querySelector<HTMLButtonElement>('.activity-fold-toggle')
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.match(view.body.querySelector('.activity-fold')?.textContent ?? '', /Docs freshness/)
    assert.match(toggle.textContent, /Done.*3 runs/)

    toggle.click()
    assert.equal(rowCount(view), 4)
    assert.equal(
      view.body.querySelector('.activity-fold-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(view.body.querySelectorAll('.activity-fold-run').length, 3)

    view.body.querySelector<HTMLButtonElement>('.activity-fold-toggle')?.click()
    assert.equal(rowCount(view), 1)
  })

  it('keeps the fold out of the arrow-key rows and never selects it', () => {
    const { view, state } = setup([thread('chat'), run('a'), run('b')])
    state.shown = true
    view.show()
    assert.equal(
      view.body.querySelector('.activity-fold-toggle')?.getAttribute('aria-current'),
      null,
    )
    assert.equal(keys(view).length, 1)
    // Nothing is selectable, so the detail pane stays out of the way.
    assert.equal(view.body.querySelector('.activity-detail')?.hasAttribute('hidden'), true)
  })

  it('forgets which folds were open on hide()', () => {
    const { view, state } = setup([thread('chat'), run('a'), run('b')])
    state.shown = true
    view.show()
    view.body.querySelector<HTMLButtonElement>('.activity-fold-toggle')?.click()
    assert.equal(rowCount(view), 3)
    view.hide()
    view.show()
    assert.equal(rowCount(view), 1)
  })
})
