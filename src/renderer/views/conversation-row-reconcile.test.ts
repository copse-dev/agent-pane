import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  markThreadRead,
  patchThreadAnywhere,
  setMessageTurnOutcome,
  setReviewerInputAnswer,
  setThreadProposalDecision,
  setThreadReviewReport,
  setThreadStatus,
  setThreadTitle,
} from '@shared/store/thread-helpers.ts'
import type { ThreadReviewReport, ToolCall } from '@shared/types'
import { resetArtefactPreviewsForTest, setArtefactPreview } from '../canvas/artefact-previews.ts'
import { createTranscriptReducer } from '@shared/store/transcript-reducer.ts'
import { ACP_CANCELLED_TOOL_CALL_RESULT } from '@shared/tools/tool-interruption.ts'
import {
  humanPrompt,
  recordedTurn,
  threadWith,
} from '@shared/store/transcript-stream.test-support.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountConversation } from './conversation.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { qsRequired } from '../dom/helpers.ts'

// The transcript reconciles its message rows by message id (transcript-rows.ts)
// when what it draws changes. A row whose message did not change must survive
// by identity, with everything that arrived after it was built: a resolved
// file-reference link (an async decoration) and the reader's open disclosure.
// Before the reconciler, any such change cleared the list and rebuilt every
// row, dropping both until they were resolved or reopened again.

function fakeApi(resolveCalls: { count: number }): ApiClient {
  const base = createFakeApi()
  return {
    ...base,
    agent: {
      ...base['agent'],
      run: () => Promise.resolve(),
      abort: () => Promise.resolve(),
    },
    index: {
      ...base['index'],
      resolveFileReferences: (
        candidates,
      ): ReturnType<ApiClient['index']['resolveFileReferences']> => {
        resolveCalls.count++
        return Promise.resolve(
          candidates.map((candidate) => ({ candidate, path: candidate, kind: 'file' as const })),
        )
      },
    },
  } satisfies ApiClient
}

const unmounts: (() => void)[] = []
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount()
  document.body.replaceChildren()
  resetArtefactPreviewsForTest()
})

/** A propose_thread call, a reviewer question and a canvas render, all finished. */
const PROPOSAL_CALL: ToolCall = {
  id: 'call-propose',
  name: 'propose_thread',
  args: {
    title: 'Split the palette',
    summary: 'Move palette ranking into its own module.',
    prompt: 'Move the ranking out of command-palette.ts.',
  },
  status: 'done',
  result: 'Offered to the user.',
}
const QUESTION_CALL: ToolCall = {
  id: 'call-ask',
  name: 'request_review_input',
  args: { question: 'Keep the old ranking?', context: 'Two callers use it.', options: ['Yes'] },
  status: 'done',
  result: 'Asked.',
}
const CANVAS_CALL: ToolCall = {
  id: 'call-canvas',
  name: 'canvas_render',
  args: { title: 'Sales' },
  status: 'done',
  result: 'Rendered ui://canvas/Sales',
}

/** Rows whose cards draw thread-wide facts: a proposal, a question and a canvas. */
function addThreadWideRows(store: ReturnType<typeof createStore>, threadId: string): string[] {
  return [PROPOSAL_CALL, QUESTION_CALL, CANVAS_CALL].map((call) => {
    const id = addMessage(store, threadId, 'assistant', `Reply with ${call.name}.`)
    addToolCall(store, id, call)
    return id
  })
}

/** Each thread-wide input a row draws, changed the way the app changes it. */
function threadWideChanges(
  store: ReturnType<typeof createStore>,
  threadId: string,
  startedThreadId: string,
): { name: string; change: () => void }[] {
  return [
    {
      name: 'a proposal is started',
      change: (): void => {
        setThreadProposalDecision(store, threadId, {
          id: PROPOSAL_CALL.id,
          status: 'started',
          decidedAt: 1,
          threadId: startedThreadId,
        })
      },
    },
    {
      name: 'the started thread is deleted',
      change: (): void => {
        store.setState({
          threads: store.getState().threads.filter((thread) => thread.id !== startedThreadId),
        })
        store.emit('threads_changed')
      },
    },
    {
      name: 'a reviewer question is answered',
      change: (): void => {
        setReviewerInputAnswer(store, threadId, {
          id: QUESTION_CALL.id,
          text: 'Yes',
          answeredAt: 2,
          messageId: 'answer-message',
        })
      },
    },
    {
      name: 'a canvas thumbnail lands',
      change: (): void => {
        setArtefactPreview(threadId, 'Sales', 'data:image/png;base64,AAAA')
        store.emit('threads_changed')
      },
    },
    {
      name: 'the thread model changes',
      change: (): void => {
        patchThreadAnywhere(store, threadId, (thread) => ({
          ...thread,
          model: 'openai:gpt-5.5',
        }))
        store.emit('threads_changed')
      },
    },
    {
      name: 'the app restarts mid-turn',
      change: (): void => {
        patchThreadAnywhere(store, threadId, (thread) => ({
          ...thread,
          interruptedTurnAt: Date.now() + 1_000,
        }))
        store.emit('threads_changed')
      },
    },
  ]
}

function reviewReport(overrides: Partial<ThreadReviewReport> = {}): ThreadReviewReport {
  return {
    status: 'done',
    startedAt: 1,
    models: { reviewer: 'gpt-5', challenger: 'claude-opus-4-8' },
    lenses: ['correctness'],
    baseRef: 'HEAD',
    headCommit: 'abc',
    dirtyWorkingTree: true,
    execution: { backend: 'os-sandbox', strength: 'os-sandbox', executed: true, reason: '' },
    checks: [],
    notChecked: [],
    findings: [
      {
        id: '0123456789abcdef',
        path: 'src/math.ts',
        startLine: 3,
        endLine: 3,
        claim: 'add subtracts its second argument.',
        class: 'contract',
        severity: 'high',
        confidence: 'high',
        verdict: { status: 'confirmed', reason: 'The reproducer fails on head.' },
        raisedBy: ['gpt-5 (correctness)'],
        corroboratedBy: [],
        challengedBy: [],
        evidence: [],
      },
    ],
    appendix: 0,
    refuted: 0,
    reviewers: [],
    verification: null,
    durationMs: 1,
    ...overrides,
  }
}

/** Every child of the list but the activity row, which outlives every rebuild. */
function listRows(host: HTMLElement): string[] {
  return Array.from(
    host.querySelectorAll('.messages-list > :not(.agent-activity)'),
    (child) => child.outerHTML,
  )
}

/** Mount a second view on the same store and require it to draw the same rows. */
async function assertMatchesFreshRebuild(
  store: ReturnType<typeof createStore>,
  live: HTMLElement,
  label: string,
): Promise<void> {
  const fresh = document.createElement('div')
  document.body.append(fresh)
  const unmount = mountConversation(fresh, store, fakeApi({ count: 0 }))
  await delay(0)
  const reconciled = listRows(live)
  const rebuilt = listRows(fresh)
  unmount()
  fresh.remove()
  assert.equal(reconciled.length, rebuilt.length, `${label}: row count`)
  const firstDifference = reconciled.findIndex((html, i) => html !== rebuilt[i])
  assert.equal(firstDifference, -1, `${label}: row ${String(firstDifference)} differs`)
}

interface Seeded {
  store: ReturnType<typeof createStore>
  threadId: string
  prompt: string
  answer: string
  resolveCalls: { count: number }
  host: HTMLElement
}

/** One finished turn: a prompt, and an answer with a file path and a tool card. */
async function seed(): Promise<Seeded> {
  // The turn-recovery card needs a project to retry in.
  const store = createStore({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  const prompt = addMessage(store, threadId, 'user', 'Where are palette entries built?')
  const answer = addMessage(
    store,
    threadId,
    'assistant',
    'The palette builds entries in `src/renderer/views/command-palette.ts`.',
  )
  addToolCall(store, answer, {
    id: 'tc-read',
    name: 'read_file',
    args: { path: 'src/renderer/views/command-palette.ts' },
    status: 'done',
    result: 'export function mountCommandPalette() {}',
  })
  const resolveCalls = { count: 0 }
  const host = document.createElement('div')
  document.body.append(host)
  unmounts.push(mountConversation(host, store, fakeApi(resolveCalls)))
  await delay(0)
  return { store, threadId, prompt, answer, resolveCalls, host }
}

function row(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.messages-list > [data-message-id="${id}"]`)
}

function rowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.messages-list > [data-message-id]'),
    (element) => element.dataset['messageId'] ?? '',
  )
}

describe('conversation keyed row reconcile (component)', () => {
  it('keeps unchanged rows, their resolved links and open disclosures across a new turn', async () => {
    const { store, threadId, prompt, answer, resolveCalls } = await seed()
    const promptNode = row(prompt)
    const answerNode = row(answer)
    assert.ok(promptNode && answerNode)
    const link = answerNode.querySelector('a.file-reference-link')
    assert.ok(link, 'expected the inline path to resolve into a file-reference link')
    const card = qsRequired<HTMLDetailsElement>(answerNode, '[data-tool-id="tc-read"]')
    qsRequired(card, ':scope > summary').click()
    assert.equal(card.open, true, 'the reader opened the tool card')
    const resolvesBefore = resolveCalls.count

    // A second turn starts and ends. Every step changes what the transcript
    // draws (a new message array, then the status), and each is followed by
    // the coarse threads_changed that used to rebuild every row.
    const next = addMessage(store, threadId, 'user', 'And the tests?')
    setThreadTitle(store, threadId, 'Palette entries')
    setThreadStatus(store, threadId, 'running')
    const reply = addMessage(store, threadId, 'assistant', 'In command-palette.test.ts.')
    setThreadStatus(store, threadId, 'idle')
    store.emit('threads_changed')
    await delay(0)

    assert.deepEqual(rowIds(), [prompt, answer, next, reply])
    // assert.ok, not assert.equal: a failing equal on DOM nodes makes node
    // inspect them, which hangs on happy-dom's object graph.
    assert.ok(row(prompt) === promptNode, 'the first prompt row was rebuilt')
    assert.ok(row(answer) === answerNode, 'the first answer row was rebuilt')
    assert.ok(
      answerNode.querySelector('a.file-reference-link') === link,
      'the resolved link was lost',
    )
    assert.ok(
      answerNode.querySelector('[data-tool-id="tc-read"]') === card,
      'the tool card was rebuilt',
    )
    assert.equal(card.open, true, 'the open disclosure was closed')
    assert.equal(
      resolveCalls.count - resolvesBefore,
      1,
      'only the new reply resolves its paths; the kept answer does not resolve again',
    )
  })

  it('patches a changed row in place and drops a removed one, keeping the rest', async () => {
    const { store, threadId, prompt, answer } = await seed()
    const second = addMessage(store, threadId, 'user', 'Second prompt')
    const third = addMessage(store, threadId, 'assistant', 'Third reply')
    const promptNode = row(prompt)
    const secondNode = row(second)
    assert.ok(promptNode && secondNode)

    // An edit replaces one message object and truncates the last one away.
    patchThreadAnywhere(store, threadId, (thread) => ({
      ...thread,
      messages: thread.messages
        .filter((message) => message.id !== third)
        .map((message) =>
          message.id === answer ? { ...message, content: 'Edited answer.' } : message,
        ),
    }))
    store.emit('threads_changed')

    assert.deepEqual(rowIds(), [prompt, answer, second])
    assert.ok(row(prompt) === promptNode, 'an unchanged row before the edit was rebuilt')
    assert.ok(row(second) === secondNode, 'an unchanged row after the edit was rebuilt')
    assert.match(row(answer)?.textContent ?? '', /Edited answer\./)
    assert.equal(document.querySelectorAll('.messages-list > [data-message-id]').length, 3)
  })

  it('rebuilds the turn-recovery card with the failed last row only', async () => {
    const { store, threadId, prompt, answer } = await seed()
    const promptNode = row(prompt)
    assert.ok(promptNode)
    setThreadStatus(store, threadId, 'running')
    store.emit('threads_changed')
    // The turn ends with a provider failure: the outcome lands on the last
    // message (its own threads_changed), then the status settles.
    setMessageTurnOutcome(store, threadId, answer, {
      status: 'failed',
      stopReason: 'error',
      source: 'provider',
      executor: 'local',
      provider: 'openai',
      model: 'gpt',
      endedAt: 2,
    })
    setThreadStatus(store, threadId, 'error')
    store.emit('threads_changed')

    assert.ok(row(prompt) === promptNode, 'the prompt row was rebuilt')
    assert.equal(document.querySelectorAll(`[data-turn-recovery-for="${answer}"]`).length, 1)
    const recovery = document.querySelector(`[data-turn-recovery-for="${answer}"]`)
    assert.ok(recovery?.previousElementSibling === row(answer), 'recovery follows its message')
  })

  it('leaves the transcript exactly as a fresh rebuild would draw it', async () => {
    // Drive the real stream reducer through a finished turn and a turn the
    // user stops mid-tool, with the coarse threads_changed between steps, then
    // compare every row with a second view mounted fresh on the same store.
    const store = createStore({
      threads: [threadWith('t1', [humanPrompt('u1', 'What does the plan say?')])],
      activeThreadId: 't1',
      activeProjectId: 'project-1',
    })
    const live = document.createElement('div')
    document.body.append(live)
    unmounts.push(mountConversation(live, store, fakeApi({ count: 0 })))
    const reducer = createTranscriptReducer(store)
    for (const chunk of recordedTurn()) {
      reducer.apply('t1', chunk)
      store.emit('threads_changed')
    }
    markThreadRead(store, 't1')
    addMessage(store, 't1', 'user', 'Wait for my phone to stop this run.')
    setThreadStatus(store, 't1', 'running')
    store.emit('threads_changed')
    reducer.apply('t1', { type: 'reasoning', text: 'Waiting.' })
    reducer.apply('t1', {
      type: 'tool_call',
      toolCall: { id: 'call-wait', name: 'run_shell', args: { command: 'sleep 5' } },
    })
    // The Stop cancels the running command: the host records it as a cancelled
    // error, which the turn's user-cancel outcome relabels as interrupted.
    reducer.apply('t1', {
      type: 'tool_result',
      toolCallId: 'call-wait',
      result: ACP_CANCELLED_TOOL_CALL_RESULT,
      isError: true,
    })
    reducer.apply('t1', { type: 'text', text: 'This must be interrupted' })
    store.emit('threads_changed')
    reducer.apply('t1', {
      type: 'turn_outcome',
      outcome: {
        status: 'cancelled',
        stopReason: 'cancelled',
        source: 'user',
        executor: 'local',
        provider: 'openai',
        model: 'openai:gpt-5.5',
        endedAt: 99,
        userAbort: 'stop',
      },
    })
    reducer.apply('t1', { type: 'done' })
    markThreadRead(store, 't1')
    await delay(0)

    const fresh = document.createElement('div')
    document.body.append(fresh)
    unmounts.push(mountConversation(fresh, store, fakeApi({ count: 0 })))
    await delay(0)
    // The activity row outlives every rebuild, so it is the view's, not a row.
    const rows = (host: HTMLElement): string[] =>
      Array.from(
        host.querySelectorAll('.messages-list > :not(.agent-activity)'),
        (child) => child.outerHTML,
      )
    // The outcome lands on the reply bubble, but the interrupted command's card
    // lives on the bubble before it, which the Stop relabels all the same.
    const card = live.querySelector('[data-tool-id="call-wait"]')
    assert.equal(card?.getAttribute('data-status'), 'interrupted')
    const reconciled = rows(live)
    const rebuilt = rows(fresh)
    assert.equal(reconciled.length, rebuilt.length)
    const firstDifference = reconciled.findIndex((html, i) => html !== rebuilt[i])
    assert.equal(firstDifference, -1, `row ${String(firstDifference)} differs from a rebuild`)
  })

  it('keeps a streamed reply, with its resolved link, once the turn ends', async () => {
    // The reply is built empty when the turn starts and filled in place by the
    // streaming handlers. Each re-stamps the row, so the reconcile that the
    // next turn triggers keeps it rather than rebuilding it from scratch.
    const resolveCalls = { count: 0 }
    const store = createStore({
      threads: [threadWith('t1', [humanPrompt('u1', 'Where are palette entries built?')])],
      activeThreadId: 't1',
      activeProjectId: 'project-1',
    })
    const host = document.createElement('div')
    document.body.append(host)
    unmounts.push(mountConversation(host, store, fakeApi(resolveCalls)))
    const reducer = createTranscriptReducer(store)
    reducer.apply('t1', { type: 'reasoning', text: 'Look for the builder.' })
    // The bubble as the turn started it: built once, then only patched.
    const built = host.querySelector<HTMLElement>('.messages-list > .msg-assistant')
    assert.ok(built)
    reducer.apply('t1', { type: 'text', text: 'The palette builds entries in ' })
    reducer.apply('t1', { type: 'text', text: '`src/renderer/views/command-palette.ts`.' })
    reducer.apply('t1', {
      type: 'turn_outcome',
      outcome: {
        status: 'completed',
        stopReason: 'end_turn',
        source: 'provider',
        executor: 'local',
        provider: 'openai',
        model: 'openai:gpt-5.5',
        endedAt: 50,
      },
    })
    reducer.apply('t1', { type: 'done' })
    markThreadRead(store, 't1')
    await delay(0)

    const reply = host.querySelector<HTMLElement>('.messages-list > .msg-assistant')
    const link = reply?.querySelector('a.file-reference-link')
    assert.ok(reply && link, 'expected the streamed reply with its resolved file link')
    assert.ok(reply === built, 'the turn itself rebuilt the reply')
    const resolvesBefore = resolveCalls.count

    addMessage(store, 't1', 'user', 'And the tests?')
    store.emit('threads_changed')
    await delay(0)

    assert.ok(
      host.querySelector('.messages-list > .msg-assistant') === reply,
      'the streamed reply was rebuilt by the next reconcile',
    )
    assert.ok(reply.querySelector('a.file-reference-link') === link, 'the resolved link was lost')
    assert.equal(resolveCalls.count, resolvesBefore, 'the kept reply resolved its paths again')
  })
})

describe('conversation keyed row reconcile: thread-wide inputs (component)', () => {
  it('keeps every row a thread-wide change does not draw, links and disclosures intact', async () => {
    const { store, threadId, answer } = await seed()
    // A thread the proposal can start; not blank, so it is not pruned.
    const started = createThread(store)
    addMessage(store, started, 'user', 'The proposed work')
    store.setState({ activeThreadId: threadId })
    store.emit('threads_changed')
    const [proposing = '', asking = '', drawing = ''] = addThreadWideRows(store, threadId)
    store.emit('threads_changed')
    await delay(0)
    const answerNode = row(answer)
    assert.ok(answerNode)
    const link = answerNode.querySelector('a.file-reference-link')
    assert.ok(link, 'expected the inline path to resolve into a file-reference link')
    const card = qsRequired<HTMLDetailsElement>(answerNode, '[data-tool-id="tc-read"]')
    qsRequired(card, ':scope > summary').click()
    assert.equal(card.open, true)

    const drawsIt: Record<string, string | null> = {
      'a proposal is started': proposing,
      'the started thread is deleted': proposing,
      'a reviewer question is answered': asking,
      'a canvas thumbnail lands': drawing,
      'the thread model changes': null,
      'the app restarts mid-turn': drawing,
    }
    for (const { name, change } of threadWideChanges(store, threadId, started)) {
      const before = new Map(rowIds().map((id) => [id, row(id)]))
      change()
      await delay(0)
      const rebuiltRows = rowIds().filter((id) => row(id) !== before.get(id))
      const expected = drawsIt[name]
      assert.deepEqual(rebuiltRows, expected ? [expected] : [], `${name}: rebuilt rows`)
      assert.ok(row(answer) === answerNode, `${name}: the answer row was rebuilt`)
      assert.ok(answerNode.querySelector('a.file-reference-link') === link, `${name}: link lost`)
      assert.ok(answerNode.querySelector('[data-tool-id="tc-read"]') === card, `${name}: card`)
      assert.equal(card.open, true, `${name}: the open disclosure was closed`)
    }

    // The rebuilt rows draw the new facts.
    assert.equal(
      row(proposing)?.querySelector<HTMLElement>('.thread-proposal')?.dataset['proposalStatus'],
      'started',
    )
    assert.match(row(asking)?.textContent ?? '', /Your answer: Yes/)
    // The canvas card builds its body, thumbnail included, when opened.
    const canvas = qsRequired<HTMLDetailsElement>(document.body, '[data-tool-id="call-canvas"]')
    qsRequired(canvas, ':scope > summary').click()
    assert.ok(canvas.querySelector('.canvas-preview-image'), 'the thumbnail is drawn')
    assert.ok(document.querySelector(`[data-turn-recovery-for="${drawing}"]`))
  })

  it('draws each thread-wide change exactly as a fresh rebuild would', async () => {
    const { store, threadId, host } = await seed()
    const started = createThread(store)
    addMessage(store, started, 'user', 'The proposed work')
    store.setState({ activeThreadId: threadId })
    store.emit('threads_changed')
    addThreadWideRows(store, threadId)
    store.emit('threads_changed')
    await delay(0)
    for (const { name, change } of threadWideChanges(store, threadId, started)) {
      change()
      await delay(0)
      await assertMatchesFreshRebuild(store, host, name)
    }
  })
})

describe('conversation trailing cards (component)', () => {
  it('keeps the review report card, and the finding the reader opened, across chrome syncs', async () => {
    const { store, threadId, host } = await seed()
    setThreadReviewReport(store, threadId, reviewReport())
    const report = qsRequired(
      document.body,
      '[data-review-report-card]:not([data-review-report-for])',
    )
    const finding = qsRequired<HTMLDetailsElement>(report, '.review-finding-details')
    qsRequired(finding, ':scope > summary').click()
    assert.equal(finding.open, true)

    // A rename, a new turn and a full same-thread sync each used to recreate it.
    setThreadTitle(store, threadId, 'Renamed')
    const next = addMessage(store, threadId, 'user', 'And the tests?')
    setThreadStatus(store, threadId, 'running')
    setThreadStatus(store, threadId, 'idle')
    store.emit('threads_changed')
    await delay(0)

    const list = qsRequired(document.body, '.messages-list')
    assert.ok(
      list.querySelector('[data-review-report-card]:not([data-review-report-for])') === report,
      'the report card was recreated',
    )
    assert.equal(finding.open, true, 'the opened finding was closed')
    assert.ok(list.lastElementChild === report, 'the report stays the trailing card')
    assert.ok(
      row(next)?.compareDocumentPosition(report) === Node.DOCUMENT_POSITION_FOLLOWING,
      'the new prompt sits above the report',
    )
    // A fresh view draws the finding closed; close it to compare the rest.
    finding.open = false
    await assertMatchesFreshRebuild(store, host, 'kept')
  })

  it('redraws the report card when the report changes, without an event', async () => {
    const { store, threadId } = await seed()
    setThreadReviewReport(store, threadId, reviewReport())
    const report = qsRequired(document.body, '[data-review-report-card]')
    // Write the store directly: the card follows the state, not the event.
    patchThreadAnywhere(store, threadId, (thread) => ({
      ...thread,
      reviewReport: reviewReport({ status: 'error', error: 'Review declined.' }),
    }))
    const redrawn = qsRequired(document.body, '[data-review-report-card]')
    assert.ok(redrawn !== report, 'a changed report must redraw its card')
    assert.equal(redrawn.getAttribute('data-status'), 'error')
    patchThreadAnywhere(store, threadId, (thread) => {
      const { reviewReport: _dropped, ...rest } = thread
      return rest
    })
    assert.equal(document.querySelector('[data-review-report-card]'), null)
  })
})
