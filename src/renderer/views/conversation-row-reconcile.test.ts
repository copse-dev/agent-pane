import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  appendReasoning,
  createThread,
  markThreadRead,
  patchThreadAnywhere,
  setMessageReviewReport,
  setMessageTurnOutcome,
  setReviewerInputAnswer,
  setThreadProposalDecision,
  setThreadReviewReport,
  setThreadStatus,
  setThreadTitle,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import { resetArtefactPreviewsForTest, setArtefactPreview } from '../canvas/artefact-previews.ts'
import { createTranscriptReducer } from '@shared/store/transcript-reducer.ts'
import { ACP_CANCELLED_TOOL_CALL_RESULT } from '@shared/tools/tool-interruption.ts'
import {
  humanPrompt,
  recordedTurn,
  threadWith,
} from '@shared/store/transcript-stream.test-support.ts'
import type { StreamChunk, ThreadReviewReport, ToolCall } from '@shared/types'
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

/**
 * Every row `live` shows, compared with a second view mounted fresh on the same
 * store: the reconciled transcript must be the one a rebuild draws.
 */
async function assertDrawnAsRebuilt(
  store: ReturnType<typeof createStore>,
  live: HTMLElement,
  label = 'reconciled',
): Promise<void> {
  const fresh = document.createElement('div')
  document.body.append(fresh)
  const unmount = mountConversation(fresh, store, fakeApi({ count: 0 }))
  await delay(0)
  // The activity row outlives every rebuild, so it is the view's, not a row.
  const rows = (host: HTMLElement): string[] =>
    Array.from(
      host.querySelectorAll('.messages-list > :not(.agent-activity)'),
      (child) => child.outerHTML,
    )
  const reconciled = rows(live)
  const rebuilt = rows(fresh)
  // Unmounted so later changes in the same test reach only the live view.
  unmount()
  fresh.remove()
  assert.equal(reconciled.length, rebuilt.length, `${label}: row count`)
  const firstDifference = reconciled.findIndex((html, i) => html !== rebuilt[i])
  assert.equal(
    firstDifference,
    -1,
    `${label}: row ${String(firstDifference)} differs from a rebuild:\n${reconciled[firstDifference] ?? ''}\n${rebuilt[firstDifference] ?? ''}`,
  )
}

const REVIEW_REPORT: ThreadReviewReport = {
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
  findings: [],
  appendix: 0,
  refuted: 0,
  reviewers: [],
  verification: null,
  durationMs: 1,
}

const STOPPED: StreamChunk = {
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
}

/**
 * A finished turn that draws the row cards the stream adds in place — a hook
 * card, visual evidence, a canvas reference and a post-turn review — then a
 * turn whose work spans three assistant messages, drawn as one rollup on the
 * first, that the user stops while its reasoning-only last step is thinking.
 */
function decoratedTurnThenStoppedRun(): { first: StreamChunk[]; second: StreamChunk[] } {
  return {
    first: [
      { type: 'reasoning', text: 'Capture the toolbar first.' },
      { type: 'text', text: 'Capturing the toolbar.' },
      {
        type: 'tool_call',
        toolCall: { id: 'call-shot', name: 'read_file', args: { path: 'toolbar.ts' } },
      },
      { type: 'tool_result', toolCallId: 'call-shot', result: 'export {}', isError: false },
      {
        type: 'visual_evidence',
        toolCallId: 'call-shot',
        evidence: [
          {
            id: 'evidence-1',
            kind: 'screenshot',
            caption: 'Toolbar at the narrow breakpoint',
            createdAt: 3,
            assets: [
              {
                id: 'asset-1',
                label: 'After',
                mimeType: 'image/png',
                width: 390,
                height: 844,
                capturedAt: 2,
                dataUrl: 'data:image/png;base64,cGl4ZWxz',
                source: {
                  kind: 'browser',
                  viewId: 'view-1',
                  title: 'Copse',
                  url: 'https://example.test',
                },
              },
            ],
          },
        ],
      },
      {
        type: 'hook_run',
        card: {
          id: 'hook-1',
          event: 'stop',
          hookId: 'format-on-stop',
          executor: 'function',
          kind: 'execution',
          status: 'ok',
          durationMs: 4,
          parseOk: true,
        },
      },
      { type: 'text', text: 'The toolbar wraps at `src/renderer/views/toolbar.ts`.' },
      { type: 'canvas_artefact', artefact: { title: 'Toolbar sketch' } },
      { type: 'post_turn_review', status: 'running', summary: '' },
      { type: 'post_turn_review', status: 'done', summary: 'Looks right.', issuesFound: false },
      {
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
      },
      { type: 'done' },
    ],
    second: [
      { type: 'reasoning', text: 'Find the builder.' },
      { type: 'tool_call', toolCall: { id: 'call-a', name: 'read_file', args: { path: 'a.ts' } } },
      { type: 'tool_result', toolCallId: 'call-a', result: 'export const a = 1', isError: false },
      { type: 'reasoning', text: 'Now its tests.' },
      { type: 'tool_call', toolCall: { id: 'call-b', name: 'read_file', args: { path: 'b.ts' } } },
      { type: 'tool_result', toolCallId: 'call-b', result: 'export const b = 2', isError: false },
      { type: 'reasoning', text: 'Weighing the answer.' },
      STOPPED,
      { type: 'done' },
    ],
  }
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

  // The app reconciles only when a coarse threads_changed follows a change to
  // what the transcript draws, which a stream rarely raises before its turn
  // ends. Each of these runs once reconciling after every chunk as well, so a
  // row is held to a rebuild both while it streams and once it settles.
  for (const reconcileEachChunk of [true, false]) {
    const when = reconcileEachChunk ? 'reconciling every chunk' : 'reconciling at turn end'
    it(`leaves the transcript exactly as a fresh rebuild would draw it (${when})`, async () => {
      // Drive the real stream reducer through a finished turn and a turn the
      // user stops mid-tool, then compare every row with a second view mounted
      // fresh on the same store.
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
        if (reconcileEachChunk) store.emit('threads_changed')
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
      if (reconcileEachChunk) store.emit('threads_changed')
      reducer.apply('t1', STOPPED)
      reducer.apply('t1', { type: 'done' })
      markThreadRead(store, 't1')
      await delay(0)

      // The outcome lands on the reply bubble, but the interrupted command's card
      // lives on the bubble before it, which the Stop relabels all the same.
      const card = live.querySelector('[data-tool-id="call-wait"]')
      assert.equal(card?.getAttribute('data-status'), 'interrupted')
      await assertDrawnAsRebuilt(store, live)
    })
  }

  for (const reconcileEachChunk of [true, false]) {
    const when = reconcileEachChunk ? 'reconciling every chunk' : 'reconciling at turn end'
    it(`draws a decorated turn and a run stopped mid-thought as a rebuild would (${when})`, async () => {
      const store = createStore({
        threads: [threadWith('t1', [humanPrompt('u1', 'Fix the toolbar.')])],
        activeThreadId: 't1',
        activeProjectId: 'project-1',
        developerMode: true,
      })
      const live = document.createElement('div')
      document.body.append(live)
      unmounts.push(mountConversation(live, store, fakeApi({ count: 0 })))
      const reducer = createTranscriptReducer(store)
      const stream = (chunks: readonly StreamChunk[]): void => {
        for (const chunk of chunks) {
          reducer.apply('t1', chunk)
          if (reconcileEachChunk) store.emit('threads_changed')
        }
      }
      const { first, second } = decoratedTurnThenStoppedRun()
      stream(first)
      markThreadRead(store, 't1')
      addMessage(store, 't1', 'user', 'Now check its tests.')
      setThreadStatus(store, 't1', 'running')
      store.emit('threads_changed')
      stream(second.slice(0, 2))
      // The run's anchor, which draws the rollup every later step patches.
      const anchor = live.querySelector('[data-tool-id="call-a"]')?.closest('.msg')
      assert.ok(anchor)
      stream(second.slice(2))
      markThreadRead(store, 't1')
      await delay(0)

      assert.ok(live.querySelector('[data-hook-cards-for]'), 'expected the hook card')
      assert.ok(live.querySelector('[data-review-for]'), 'expected the post-turn review')
      // The thinking step joined the run with its reasoning alone: once the
      // Stop settles the turn, its own bubble is hidden inside the rollup.
      const steps = Array.from(
        live.querySelectorAll<HTMLElement>('.messages-list > .msg-assistant'),
      ).slice(-3)
      assert.equal(steps.length, 3)
      const thinking = steps[2]
      assert.ok(thinking, 'expected the thinking step')
      assert.ok(thinking.classList.contains('msg-tool-run-member'), 'the step is not a run member')
      assert.equal(thinking.hidden, true, 'the empty thinking step is still visible')
      assert.ok(steps[0] === anchor, 'the run anchor the stream patched was rebuilt')
      await assertDrawnAsRebuilt(store, live)
    })
  }

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

  it('keeps a streamed reply when a review report lands on an earlier message', async () => {
    // A review report replaces its message's object and is drawn by its own
    // handler. That must not stop the next reconcile from keeping the rows the
    // stream patched, here a reply whose path has resolved into a link.
    const store = createStore({
      threads: [threadWith('t1', [humanPrompt('u1', 'Review the palette change.')])],
      activeThreadId: 't1',
      activeProjectId: 'project-1',
    })
    const live = document.createElement('div')
    document.body.append(live)
    unmounts.push(mountConversation(live, store, fakeApi({ count: 0 })))
    const reducer = createTranscriptReducer(store)
    reducer.apply('t1', { type: 'text', text: 'Reviewed.' })
    reducer.apply('t1', { type: 'done' })
    const reviewed = live.querySelector<HTMLElement>('.messages-list > .msg-assistant')
    const reviewedId = reviewed?.dataset['messageId']
    assert.ok(reviewedId)

    addMessage(store, 't1', 'user', 'Where are palette entries built?')
    setThreadStatus(store, 't1', 'running')
    store.emit('threads_changed')
    reducer.apply('t1', { type: 'reasoning', text: 'Look for the builder.' })
    const replies = (): HTMLElement[] =>
      Array.from(live.querySelectorAll<HTMLElement>('.messages-list > .msg-assistant'))
    const built = replies()[1]
    assert.ok(built, 'expected the streamed reply')
    reducer.apply('t1', { type: 'text', text: 'Entries are built in ' })
    reducer.apply('t1', { type: 'text', text: '`src/renderer/views/command-palette.ts`.' })
    reducer.apply('t1', { type: 'done' })
    await delay(0)
    const link = built.querySelector('a.file-reference-link')
    assert.ok(link, 'expected the streamed path to resolve into a link')

    setMessageReviewReport(store, 't1', reviewedId, REVIEW_REPORT)
    assert.ok(live.querySelector(`[data-review-report-for="${reviewedId}"]`))
    store.emit('threads_changed')
    await delay(0)

    assert.ok(replies()[1] === built, 'the review report rebuilt the streamed reply')
    assert.ok(built.querySelector('a.file-reference-link') === link, 'the resolved link was lost')
    await assertDrawnAsRebuilt(store, live)
  })

  it('rebuilds a streamed row whose message was replaced outside the stream', async () => {
    // A snapshot or edit can replace a streaming message with fields no
    // streaming handler draws. A later chunk patches only its own part, so the
    // row must not count as drawing the replaced message.
    const store = createStore({
      threads: [threadWith('t1', [humanPrompt('u1', 'Read a.ts.')])],
      activeThreadId: 't1',
      activeProjectId: 'project-1',
    })
    const live = document.createElement('div')
    document.body.append(live)
    unmounts.push(mountConversation(live, store, fakeApi({ count: 0 })))
    const reducer = createTranscriptReducer(store)
    reducer.apply('t1', { type: 'text', text: 'Reading' })
    const replyId = live.querySelector<HTMLElement>('.messages-list > .msg-assistant')?.dataset[
      'messageId'
    ]
    assert.ok(replyId)
    patchThreadAnywhere(store, 't1', (thread) => ({
      ...thread,
      messages: thread.messages.map((message) =>
        message.id === replyId
          ? {
              ...message,
              toolCalls: [
                {
                  id: 'tc-snap',
                  name: 'read_file',
                  args: { path: 'a.ts' },
                  status: 'done',
                  result: 'ok',
                },
              ],
            }
          : message,
      ),
    }))
    reducer.apply('t1', { type: 'text', text: ' a.ts.' })
    store.emit('threads_changed')
    await delay(0)

    assert.ok(live.querySelector('[data-tool-id="tc-snap"]'), 'the replaced message lost its card')
    await assertDrawnAsRebuilt(store, live)
  })
})

describe('conversation streamed-row bookkeeping cost (component)', () => {
  /** A running turn whose `steps` tool-only steps share `payload` characters of results. */
  async function mountRun(steps: number, payload: number): Promise<ReturnType<typeof createStore>> {
    const messages = Array.from({ length: steps }, (_, i) => ({
      id: `step-${String(i)}`,
      role: 'assistant' as const,
      content: '',
      reasoning: `Step ${String(i)}.`,
      toolCalls: [
        {
          id: `call-${String(i)}`,
          name: 'run_shell',
          args: { command: `cat file-${String(i)}` },
          status: 'done' as const,
          result: 'x'.repeat(payload / steps),
        },
      ],
      createdAt: 20 + i,
    }))
    const store = createStore({
      threads: [threadWith('t1', [humanPrompt('u1', 'Go'), ...messages])],
      activeThreadId: 't1',
      activeProjectId: 'project-1',
    })
    const host = document.createElement('div')
    document.body.append(host)
    unmounts.push(mountConversation(host, store, fakeApi({ count: 0 })))
    await delay(0)
    return store
  }

  /** Mean wall-clock milliseconds of `event` over a few runs, for the diagnostics. */
  function meanMs(event: (i: number) => void): number {
    const runs = 5
    const start = performance.now()
    for (let i = 0; i < runs; i++) event(i)
    return (performance.now() - start) / runs
  }

  // Noting a patched row must stay constant time: signing the rows of a run
  // on every streamed event costs the run's length times its size, which on a
  // 40-step run took a reasoning chunk from milliseconds to 400 ms. What an
  // event encodes is counted rather than timed, so the bound cannot flake.
  it('encodes no more per streamed event as the same work spreads over more steps', async (t) => {
    const payload = 800_000
    const cost: Record<string, { reasoning: number; update: number }> = {}
    for (const steps of [10, 40]) {
      const store = await mountRun(steps, payload)
      const last = `step-${String(steps - 1)}`
      const call = `call-${String(steps - 1)}`
      const reasoningMs = meanMs(() => {
        appendReasoning(store, last, ' More.')
      })
      const updateMs = meanMs((i) => {
        updateToolCall(store, last, call, { result: `${'y'.repeat(payload / steps)}${String(i)}` })
      })
      t.diagnostic(
        `${String(steps)} steps: reasoning chunk ${reasoningMs.toFixed(1)} ms, tool update ${updateMs.toFixed(1)} ms`,
      )
      const stringify = t.mock.method(JSON, 'stringify')
      const encoded = (): number =>
        stringify.mock.calls.reduce(
          (total, entry) => total + (typeof entry.result === 'string' ? entry.result.length : 0),
          0,
        )
      appendReasoning(store, last, ' More.')
      const reasoning = encoded()
      stringify.mock.resetCalls()
      updateToolCall(store, last, call, { result: 'z'.repeat(payload / steps) })
      cost[String(steps)] = { reasoning, update: encoded() }
      stringify.mock.restore()
    }
    const few = cost['10']
    const many = cost['40']
    assert.ok(few && many)
    // A small allowance absorbs labels that grow with the step count.
    const slack = 64 * 1024
    assert.ok(
      many.reasoning <= few.reasoning * 1.25 + slack,
      `a reasoning chunk encoded ${String(many.reasoning)} characters over 40 steps, ${String(few.reasoning)} over 10`,
    )
    assert.ok(
      many.update <= few.update * 1.25 + slack,
      `a tool update encoded ${String(many.update)} characters over 40 steps, ${String(few.update)} over 10`,
    )
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
      await assertDrawnAsRebuilt(store, host, name)
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
    await assertDrawnAsRebuilt(store, host, 'kept')
  })

  it('leaves Retry usable when a retry changes nothing', async () => {
    // A kept card is drawn again only when its report changes, but its buttons
    // disable themselves on click. A Retry while a turn is running is a no-op
    // (startReview waits for the turn), so it must not leave Retry disabled.
    const { store, threadId } = await seed()
    setThreadReviewReport(store, threadId, reviewReport({ status: 'error', error: 'Declined.' }))
    setThreadStatus(store, threadId, 'running')
    store.emit('threads_changed')
    const retry = (): HTMLButtonElement =>
      qsRequired<HTMLButtonElement>(
        document.body,
        '[data-review-report-card]:not([data-review-report-for]) .card-retry-button',
      )
    retry().click()
    assert.equal(retry().disabled, false, 'Retry stayed disabled after a no-op retry')
    setThreadStatus(store, threadId, 'idle')
    store.emit('threads_changed')
    assert.equal(retry().disabled, false, 'Retry is disabled once the turn ends')
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
