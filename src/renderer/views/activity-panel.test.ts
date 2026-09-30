// The Activity panel mounted over the real approval and ask dialogs: grouping,
// answering an approval without switching threads (through the dialog's own
// queue), idempotency, the settle guard, throttled re-rendering, and keyboard
// operation.
import '../../../tests/setup-dom.ts'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore, type AppStore } from '@shared/store/store.ts'
import { setThreadStatus } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import { qsRequired } from '../dom/helpers.ts'
import { createPendingApi } from '../fake-api.test-support.ts'
import { resetAttention } from '../controller/attention.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { mountSettingsDialog } from './settings-dialog.ts'
import { APPROVAL_SETTLE_MS, mountApprovalDialog, type ApprovalTimer } from './approval-dialog.ts'
import { mountAskUserDialog } from './ask-user-dialog.ts'
import {
  ACTIVITY_RENDER_INTERVAL_MS,
  mountActivityPanel,
  openActivityPanel,
  type ActivityPanel,
} from './activity-panel.ts'

interface ApprovalEvent {
  id: string
  threadId?: string | undefined
  title: string
  body: string
  bodyAdvice?: string
  bodyFooter?: string
  type: string
}

interface AskEvent {
  id: string
  threadId?: string | undefined
  questions: { question: string; options?: string[] }[]
}

interface Responded {
  id: string
  approved: boolean
  remember: boolean | undefined
  grantScope: string | undefined
}

function patchDialogs(): void {
  const opened = function (this: HTMLDialogElement): void {
    this.open = true
  }
  Object.defineProperties(window.HTMLDialogElement.prototype, {
    show: { configurable: true, value: opened },
    showModal: { configurable: true, value: opened },
    close: {
      configurable: true,
      value(this: HTMLDialogElement): void {
        if (!this.open) return
        this.open = false
        this.dispatchEvent(new window.Event('close'))
      },
    },
  })
}

/** Deterministic clock + timer queue shared by the panel and the approval dialog. */
function manualTime(): {
  now: () => number
  setTimer: ApprovalTimer
  advance: (ms: number) => void
} {
  let clock = 1_000_000
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = seq++
      pending.set(id, { at: clock + ms, fn })
      return () => {
        pending.delete(id)
      }
    },
    advance: (ms): void => {
      const until = clock + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        pending.delete(due[0])
        clock = Math.max(clock, due[1].at)
        due[1].fn()
      }
      clock = until
    },
  }
}

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

/** A thread whose transcript throws if anything reads it. */
function metadataOnly(id: string, patch: Partial<Thread> = {}): Thread {
  const value = thread(id, { messagesLoaded: false, ...patch })
  Object.defineProperty(value, 'messages', {
    get(): never {
      throw new Error(`transcript of ${id} was read`)
    },
  })
  return value
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#activity-panel .activity-row')]
}

function rowKeys(group: string): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      `#activity-panel .activity-group[data-group="${group}"] .activity-row`,
    ),
  ].map((row) => row.dataset['rowKey'] ?? '')
}

function rowFor(key: string): HTMLElement {
  const found = rows().find((row) => row.dataset['rowKey'] === key)
  assert.ok(found, `expected row ${key}`)
  return found
}

function key(target: HTMLElement, name: string): void {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }))
}

function detail(): HTMLElement {
  return qsRequired(document, '#activity-panel .activity-detail')
}

function openers(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('#activity-panel .activity-row-open')]
}

function selectedKey(): string | undefined {
  return document.querySelector<HTMLElement>('#activity-panel .activity-row[data-selected]')
    ?.dataset['rowKey']
}

describe('activity panel', () => {
  let store: AppStore
  let panel: ActivityPanel
  let time: ReturnType<typeof manualTime>
  let emitApproval: (req: ApprovalEvent) => void
  let cancelApproval: (id: string) => void
  let emitAsk: (req: AskEvent) => void
  let responses: Responded[]
  let askResponses: string[]
  let renders: number

  function mount(threads: Thread[]): void {
    store = createStore({
      projects: [{ id: 'p1', path: '/work', name: 'workspace' }],
      activeProjectId: 'p1',
      expandedProjectId: 'p1',
      workspaceRoot: '/work',
      threads,
      activeThreadId: threads[0]?.id ?? null,
    })
    let onApproval: (req: ApprovalEvent) => void = () => {}
    let onApprovalCancelled: (p: { id: string }) => void = () => {}
    let onAsk: (req: AskEvent) => void = () => {}
    const api = createPendingApi({
      'agent.onApprovalRequest': (handler: (req: ApprovalEvent) => void): (() => void) => {
        onApproval = handler
        return () => {}
      },
      'agent.onApprovalCancelled': (handler: (p: { id: string }) => void): (() => void) => {
        onApprovalCancelled = handler
        return () => {}
      },
      'agent.onAskUserRequest': (handler: (req: AskEvent) => void): (() => void) => {
        onAsk = handler
        return () => {}
      },
      'approval.respond': (
        id: string,
        approved: boolean,
        remember?: boolean,
        grantScope?: string,
      ): Promise<void> => {
        responses.push({ id, approved, remember, grantScope })
        return Promise.resolve()
      },
      'ask.respond': (id: string): Promise<void> => {
        askResponses.push(id)
        return Promise.resolve()
      },
    })
    emitApproval = (req): void => {
      onApproval(req)
    }
    cancelApproval = (id): void => {
      onApprovalCancelled({ id })
    }
    emitAsk = (req): void => {
      onAsk(req)
    }
    mountSettingsDialog(store, api)
    const approvals = mountApprovalDialog(api, store, { setTimer: time.setTimer })
    const questions = mountAskUserDialog(api, store)
    panel = mountActivityPanel(
      api,
      store,
      {
        approvals: {
          ...approvals,
          pending: () => {
            renders++
            return approvals.pending()
          },
        },
        questions,
      },
      { now: time.now, setTimer: time.setTimer },
    )
  }

  /** Select a row, then let its settle window pass so Approve is live. */
  function review(rowKey: string): HTMLButtonElement {
    qsRequired<HTMLButtonElement>(rowFor(rowKey), '.activity-row-open').click()
    time.advance(APPROVAL_SETTLE_MS)
    return qsRequired<HTMLButtonElement>(detail(), '.activity-approve')
  }

  const shell = (id: string, threadId: string, command = `printf ${id}`): ApprovalEvent => ({
    id,
    threadId,
    title: 'Run shell command?',
    body: command,
    type: 'shell',
  })

  beforeEach(() => {
    document.body.innerHTML = ''
    patchDialogs()
    resetAttention()
    time = manualTime()
    responses = []
    askResponses = []
    renders = 0
  })

  afterEach(() => {
    panel.close()
    resetProjectSwitchStateForTest()
  })

  it('explains itself when nothing is running or waiting', () => {
    mount([thread('only')])
    openActivityPanel()
    assert.equal(panel.isOpen(), true)
    const empty = qsRequired(document, '#activity-panel .activity-empty')
    assert.match(empty.textContent, /Nothing is running or waiting on you/)
    assert.match(empty.textContent, /answer an approval without leaving the thread/)
  })

  it('groups a background approval above a running thread, with labelled state', () => {
    mount([
      thread('focused', { title: 'Release notes' }),
      thread('auth', { title: 'Refactor auth' }),
      thread('deps', { title: 'Dependency audit' }),
    ])
    setThreadStatus(store, 'deps', 'running')
    store.emit('agent_activity', 'deps', 'Running shell…')
    emitApproval(shell('req-auth', 'auth', 'printf auth-approved'))
    panel.open()

    const groups = [...document.querySelectorAll<HTMLElement>('#activity-panel .activity-group')]
    assert.deepEqual(
      groups.map((group) => group.dataset['group']),
      ['needs-you', 'working'],
    )
    assert.deepEqual(rowKeys('needs-you'), ['approval:req-auth'])
    assert.deepEqual(rowKeys('working'), ['thread:deps'])
    assert.equal(
      qsRequired(document, '#activity-panel .activity-panel-summary').textContent,
      '1 needs you · 1 working',
    )

    // Each list is named by its group heading, so a screen reader hears the group.
    const needsList = qsRequired(groups[0] ?? document, '.activity-rows')
    const heading = document.getElementById(needsList.getAttribute('aria-labelledby') ?? '')
    assert.match(heading?.textContent ?? '', /^Needs you/)
    assert.equal(needsList.getAttribute('role'), 'list')

    // Two lines: the thread leads, then the state word and what it wants.
    const approvalRow = rowFor('approval:req-auth')
    const opener = qsRequired(approvalRow, '.activity-row-open')
    assert.equal(qsRequired(approvalRow, '.activity-thread').textContent, 'Refactor auth')
    assert.equal(qsRequired(approvalRow, '.activity-state').textContent, 'Approval')
    assert.equal(qsRequired(approvalRow, '.activity-want-code').textContent, 'printf auth-approved')
    assert.equal(qsRequired(approvalRow, '.activity-project').textContent, 'workspace')
    assert.equal(qsRequired(approvalRow, '.activity-age').textContent, 'now')
    assert.equal(
      opener.getAttribute('aria-label'),
      'Needs approval: Run shell command? — printf auth-approved. Refactor auth, workspace. waiting just now',
    )
    const workingRow = rowFor('thread:deps')
    assert.equal(qsRequired(workingRow, '.activity-state').textContent, 'Running')
    assert.equal(qsRequired(workingRow, '.activity-want-text').textContent, 'Running shell…')
    // The glyph is decorative; the state is carried in text.
    assert.equal(qsRequired(workingRow, '.activity-glyph').getAttribute('aria-hidden'), 'true')
  })

  it('draws rows from metadata only, without reading any transcript', () => {
    mount([
      metadataOnly('focused'),
      metadataOnly('auth', { title: 'Refactor auth' }),
      metadataOnly('deps', { status: 'running' }),
    ])
    emitApproval(shell('req', 'auth'))
    panel.open()
    assert.deepEqual(rowKeys('needs-you'), ['approval:req'])
    assert.deepEqual(rowKeys('working'), ['thread:deps'])
    // Selecting the running thread shows its state without its transcript.
    qsRequired<HTMLButtonElement>(rowFor('thread:deps'), '.activity-row-open').click()
    assert.equal(detail().dataset['rowKey'], 'thread:deps')
  })

  it('opens on the most urgent row and shows it in full beside the list', () => {
    mount([thread('focused'), thread('auth', { title: 'Refactor auth' }), thread('deps')])
    setThreadStatus(store, 'deps', 'running')
    store.emit('agent_activity', 'deps', 'Reasoning…')
    emitApproval(shell('req-auth', 'auth', 'printf auth-approved'))
    panel.open()

    assert.equal(selectedKey(), 'approval:req-auth')
    assert.equal(
      qsRequired(rowFor('approval:req-auth'), '.activity-row-open').getAttribute('aria-current'),
      'true',
    )
    assert.equal(qsRequired(detail(), '.activity-detail-title').textContent, 'Refactor auth')
    assert.equal(qsRequired(detail(), '.activity-detail-state').textContent, 'Needs approval')
    assert.equal(qsRequired(detail(), '.approval-body').textContent, 'printf auth-approved')
    // One action bar: open the thread on one side, the answers on the other.
    assert.deepEqual(
      [...detail().querySelectorAll<HTMLElement>('.activity-detail-actions [data-control]')].map(
        (control) => control.dataset['control'],
      ),
      ['open-thread', 'reject', 'approve'],
    )

    qsRequired<HTMLButtonElement>(rowFor('thread:deps'), '.activity-row-open').click()
    assert.equal(selectedKey(), 'thread:deps')
    assert.equal(qsRequired(detail(), '.activity-detail-state').textContent, 'Running')
    assert.equal(qsRequired(detail(), '.activity-detail-text').textContent, 'Reasoning…')
    assert.equal(detail().querySelector('.activity-approve'), null)
    assert.equal(detail().querySelector('.activity-reject'), null)
    qsRequired<HTMLButtonElement>(detail(), '.activity-open-thread').click()
    assert.equal(panel.isOpen(), false)
    assert.equal(store.getState().activeThreadId, 'deps')
  })

  it('approves a background thread once, routed to its own request id, without switching', () => {
    mount([thread('focused'), thread('auth'), thread('other'), thread('deps')])
    setThreadStatus(store, 'deps', 'running')
    emitApproval(shell('req-auth', 'auth'))
    emitApproval(shell('req-other', 'other'))
    panel.open()

    review('approval:req-auth').click()
    assert.deepEqual(responses, [
      { id: 'req-auth', approved: true, remember: false, grantScope: 'once' },
    ])
    assert.equal(store.getState().activeThreadId, 'focused', 'the user stays where they were')
    assert.match(qsRequired(document, '.activity-panel-status').textContent, /Approved once/)

    // The answered row leaves; the next request takes its place in the detail.
    time.advance(ACTIVITY_RENDER_INTERVAL_MS)
    assert.deepEqual(rowKeys('needs-you'), ['approval:req-other'])
    assert.equal(selectedKey(), 'approval:req-other')
    // A request that just arrived in the detail pane is not approvable yet;
    // Reject only narrows, so it is live at once.
    assert.equal(qsRequired<HTMLButtonElement>(detail(), '.activity-approve').disabled, true)
    const reject = qsRequired<HTMLButtonElement>(detail(), '.activity-reject')
    assert.equal(reject.disabled, false)
    reject.click()
    assert.deepEqual(responses.at(-1), {
      id: 'req-other',
      approved: false,
      remember: false,
      grantScope: 'once',
    })
    time.advance(ACTIVITY_RENDER_INTERVAL_MS)
    assert.deepEqual(rowKeys('needs-you'), [])
    assert.match(qsRequired(document, '.activity-quiet').textContent, /Nothing needs you/)
    assert.equal(
      qsRequired(document, '#activity-panel .activity-panel-summary').textContent,
      'Nothing needs you · 1 working',
    )
    assert.equal(selectedKey(), 'thread:deps')
  })

  it('never answers twice, and says so when the request was settled elsewhere', () => {
    mount([thread('focused'), thread('auth'), thread('other')])
    emitApproval(shell('req-auth', 'auth'))
    emitApproval(shell('req-other', 'other'))
    panel.open()

    const approve = review('approval:req-auth')
    approve.click()
    approve.click()
    assert.equal(responses.length, 1)
    assert.equal(approve.disabled, true)
    assert.equal(qsRequired<HTMLButtonElement>(detail(), '.activity-reject').disabled, true)

    // Main cancelled the other request (its turn was stopped) before a render.
    time.advance(ACTIVITY_RENDER_INTERVAL_MS)
    assert.equal(selectedKey(), 'approval:req-other')
    cancelApproval('req-other')
    qsRequired<HTMLButtonElement>(detail(), '.activity-reject').click()
    assert.equal(responses.length, 1)
    assert.match(qsRequired(document, '.activity-panel-status').textContent, /already answered/)
    time.advance(ACTIVITY_RENDER_INTERVAL_MS)
    assert.deepEqual(rowKeys('needs-you'), [])
  })

  it('pauses Approve when a new request lands while the list is open', () => {
    mount([thread('focused'), thread('a'), thread('b')])
    emitApproval(shell('first', 'a'))
    panel.open()
    // The request opened in the detail pane: Approve waits for the settle window.
    assert.equal(qsRequired<HTMLButtonElement>(detail(), '.activity-approve').disabled, true)
    time.advance(APPROVAL_SETTLE_MS)
    assert.equal(
      qsRequired<HTMLButtonElement>(detail(), '.activity-approve').disabled,
      false,
      'live once the request has been on screen for the settle window',
    )

    emitApproval(shell('second', 'b'))
    time.advance(ACTIVITY_RENDER_INTERVAL_MS)
    assert.equal(selectedKey(), 'approval:first', 'the selection stays put')
    assert.equal(qsRequired<HTMLButtonElement>(detail(), '.activity-approve').disabled, true)
    time.advance(APPROVAL_SETTLE_MS)
    assert.equal(qsRequired<HTMLButtonElement>(detail(), '.activity-approve').disabled, false)

    // Moving to another request re-arms the window: it has not been read yet.
    qsRequired<HTMLButtonElement>(rowFor('approval:second'), '.activity-row-open').click()
    assert.equal(qsRequired<HTMLButtonElement>(detail(), '.activity-approve').disabled, true)
    time.advance(APPROVAL_SETTLE_MS)
    assert.equal(qsRequired<HTMLButtonElement>(detail(), '.activity-approve').disabled, false)
  })

  it('coalesces a burst of changes into one re-render per interval', () => {
    mount([thread('focused'), ...Array.from({ length: 12 }, (_, i) => thread(`t${String(i)}`))])
    panel.open()
    const afterOpen = renders
    for (let i = 0; i < 12; i++) {
      setThreadStatus(store, `t${String(i)}`, 'running')
      emitApproval(shell(`r${String(i)}`, `t${String(i)}`))
    }
    time.advance(ACTIVITY_RENDER_INTERVAL_MS - 1)
    assert.equal(renders, afterOpen, 'nothing redraws inside the interval')
    time.advance(1)
    assert.equal(renders, afterOpen + 1)
    assert.equal(rowKeys('needs-you').length, 12)
  })

  it('keeps the activity list scroll position when a new action arrives', () => {
    mount([thread('focused'), ...Array.from({ length: 12 }, (_, i) => thread(`t${String(i)}`))])
    for (let i = 0; i < 12; i++) setThreadStatus(store, `t${String(i)}`, 'running')
    panel.open()

    const list = qsRequired(document, '#activity-panel .activity-list')
    list.scrollTop = 240
    const replaceChildren = list.replaceChildren.bind(list)
    list.replaceChildren = (...nodes): void => {
      replaceChildren(...nodes)
      list.scrollTop = 0
    }
    emitApproval(shell('new-action', 'focused'))
    time.advance(ACTIVITY_RENDER_INTERVAL_MS)

    assert.equal(list.scrollTop, 240, 'a live update must not reset the reader position')
  })

  it('is keyboard operable: arrows choose a row, Tab reaches its actions', () => {
    mount([thread('focused'), thread('auth', { title: 'Refactor auth' }), thread('deps')])
    setThreadStatus(store, 'deps', 'running')
    emitApproval(shell('req-auth', 'auth'))
    panel.open()

    assert.equal(document.activeElement, openers()[0], 'opening focuses the most urgent row')
    assert.deepEqual(
      openers().map((opener) => opener.tabIndex),
      [0, -1],
    )
    key(openers()[0] ?? document.body, 'ArrowDown')
    assert.equal(document.activeElement, openers()[1])
    assert.equal(selectedKey(), 'thread:deps', 'the detail follows the arrow keys')
    assert.deepEqual(
      openers().map((opener) => opener.tabIndex),
      [-1, 0],
    )
    key(openers()[1] ?? document.body, 'ArrowDown')
    assert.equal(document.activeElement, openers()[1], 'the last row holds')
    key(openers()[1] ?? document.body, 'Home')
    assert.equal(document.activeElement, openers()[0])
    assert.equal(selectedKey(), 'approval:req-auth')
    key(openers()[0] ?? document.body, 'End')
    assert.equal(document.activeElement, openers()[1])

    // Enter on a row only selects it; the thread opens from the detail's action bar.
    openers()[1]?.click()
    assert.equal(panel.isOpen(), true)
    qsRequired<HTMLButtonElement>(detail(), '.activity-open-thread').click()
    assert.equal(panel.isOpen(), false)
    assert.equal(store.getState().activeThreadId, 'deps')
  })

  it('keeps focus in place when the focused request is answered', () => {
    mount([thread('focused'), thread('a'), thread('b')])
    emitApproval(shell('first', 'a'))
    emitApproval(shell('second', 'b'))
    panel.open()
    const list = qsRequired<HTMLElement>(document, '#activity-panel .activity-list')
    list.scrollTop = 240
    const replaceChildren = list.replaceChildren.bind(list)
    list.replaceChildren = (...nodes): void => {
      replaceChildren(...nodes)
      list.scrollTop = 0
    }
    const focus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (options?: FocusOptions): void {
      focus.call(this, options)
      if (this.classList.contains('activity-row-open') && options?.preventScroll !== true) {
        list.scrollTop = 0
      }
    }
    const approve = review('approval:first')
    try {
      approve.focus()
      approve.click()
      time.advance(ACTIVITY_RENDER_INTERVAL_MS)
    } finally {
      HTMLElement.prototype.focus = focus
    }
    const opener = qsRequired(rowFor('approval:second'), '.activity-row-open')
    assert.equal(document.activeElement, opener)
    assert.equal(list.scrollTop, 240, 'focus restoration must not undo scroll restoration')
  })

  it('offers Approve only beside the whole command, including its tail', () => {
    const tail = '; rm -rf ./build'
    const command = `printf '${'x'.repeat(400 - tail.length - 9)}'${tail}`
    assert.equal(command.length, 400)
    mount([thread('focused'), thread('auth', { title: 'Refactor auth' })])
    emitApproval(shell('long', 'auth', command))
    panel.open()

    // The list row is for scanning: truncated, and never answerable.
    const row = rowFor('approval:long')
    assert.ok(!row.textContent.includes(tail), 'the list row hides the tail')
    assert.equal(
      document.querySelector(
        '#activity-panel .activity-list .activity-approve, #activity-panel .activity-list .activity-reject',
      ),
      null,
    )
    // The detail pane holds the request verbatim, and Approve sits only there.
    const body = qsRequired(detail(), '.activity-review .approval-body')
    assert.equal(body.textContent, command, 'the full command, verbatim')
    assert.ok(body.classList.contains('approval-body-code'), 'shell is monospaced')
    const approves = [
      ...document.querySelectorAll<HTMLButtonElement>('#activity-panel .activity-approve'),
    ]
    assert.equal(approves.length, 1)
    const approve = qsRequired<HTMLButtonElement>(detail(), '.activity-approve')
    assert.equal(approves[0], approve)
    assert.equal(approve.disabled, true, 'and it waits out the settle window')
    time.advance(APPROVAL_SETTLE_MS)
    assert.equal(qsRequired<HTMLButtonElement>(detail(), '.activity-approve').disabled, false)
  })

  it('shows the advice and footer the prompt would show, in the detail', () => {
    mount([thread('focused'), thread('auth')])
    const advice =
      'The project sandbox would block this command:\n• Installs or updates packages, which downloads and runs code from the internet'
    emitApproval({
      id: 'install',
      threadId: 'auth',
      title: 'Run package install?',
      body: 'npm install',
      bodyAdvice: advice,
      bodyFooter: 'Allow this install?',
      type: 'shell',
    })
    panel.open()
    const view = qsRequired(detail(), '.activity-review')
    assert.equal(qsRequired(view, '.activity-review-title').textContent, 'Run package install?')
    // The prompt's own rendering: the lead line as text, each reason a list item.
    const adviceView = qsRequired(view, '.approval-advice')
    assert.equal(
      adviceView.firstChild?.textContent,
      'The project sandbox would block this command:',
    )
    assert.deepEqual(
      [...adviceView.querySelectorAll('.approval-reasons li')].map((item) => item.textContent),
      ['Installs or updates packages, which downloads and runs code from the internet'],
    )
    assert.equal(qsRequired(view, '.approval-body').textContent, 'npm install')
    assert.equal(qsRequired(view, '.approval-footer').textContent, 'Allow this install?')
  })

  it('sends a question to its thread rather than answering it in the panel', () => {
    mount([thread('focused'), thread('schema', { title: 'Schema bump' })])
    emitAsk({
      id: 'ask-1',
      threadId: 'schema',
      questions: [{ question: 'Which migration order?' }, { question: 'Keep the old column?' }],
    })
    panel.open()
    const row = rowFor('question:ask-1')
    assert.equal(qsRequired(row, '.activity-state').textContent, 'Question')
    assert.equal(
      qsRequired(row, '.activity-want-text').textContent,
      'Which migration order? (+1 more)',
    )
    // The detail lists every question; answering happens in the thread.
    assert.deepEqual(
      [...detail().querySelectorAll('.activity-questions li')].map((item) => item.textContent),
      ['Which migration order?', 'Keep the old column?'],
    )
    assert.equal(detail().querySelector('.activity-approve'), null)
    qsRequired<HTMLButtonElement>(detail(), '.activity-answer').click()
    assert.equal(panel.isOpen(), false)
    assert.equal(store.getState().activeThreadId, 'schema')
    assert.deepEqual(askResponses, [], 'the ask dialog, not the panel, owns the answer')
  })

  it('lists recently finished and failed runs it watched end', () => {
    mount([thread('focused'), thread('done'), thread('broken')])
    setThreadStatus(store, 'done', 'running')
    setThreadStatus(store, 'broken', 'running')
    time.advance(5 * 60_000)
    setThreadStatus(store, 'done', 'idle')
    setThreadStatus(store, 'broken', 'error')
    panel.open()
    assert.deepEqual(rowKeys('recent'), ['thread:broken', 'thread:done'])
    assert.equal(qsRequired(rowFor('thread:broken'), '.activity-state').textContent, 'Failed')
    assert.equal(qsRequired(rowFor('thread:done'), '.activity-state').textContent, 'Done')
    assert.equal(qsRequired(detail(), '.activity-detail-state').textContent, 'Failed')
    assert.equal(qsRequired(detail(), '.activity-detail-text').textContent, 'Ended with an error')
  })
})
