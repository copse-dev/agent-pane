import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { StreamChunk, TranscriptStamp, TranscriptSnapshot } from '@shared/types'
import { createStore } from '@shared/store/store.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import { createTranscriptReducer } from '@shared/store/transcript-reducer.ts'
import {
  comparable,
  humanPrompt,
  recordedTurn,
  threadWith,
} from '@shared/store/transcript-stream.test-support.ts'
import { AgentDispatcher, type AgentDispatcherDependencies } from './agent-dispatcher.ts'
import type { ThreadExecutionContext } from './thread-execution-context.ts'
import { appendMessage, createThread, getProjectThread, updateMeta } from './thread-store.ts'
import { ToolRegistry } from './tool-registry.ts'
import { TurnTranscriptWriter } from './turn-transcript-writer.ts'

const PROJECT = 'project-1'
const writeErrors: unknown[] = []
const THREAD = 'thread-1'

const context: ThreadExecutionContext = {
  projectId: PROJECT,
  threadId: THREAD,
  projectRoot: '/workspace',
  root: '/workspace',
  checkoutMode: 'shared',
  branch: null,
}

interface Delivery {
  threadId: string
  chunk: StreamChunk
  stamp: TranscriptStamp | undefined
}

/** A dispatcher whose turn streams `chunks`, writing through a real store. */
function harness(
  chunks: () => StreamChunk[],
  forward: (delivery: Delivery) => void = () => undefined,
  snapshot: (snapshot: TranscriptSnapshot) => void = () => undefined,
): {
  dispatcher: AgentDispatcher
  writer: TurnTranscriptWriter
  windowHost: AgentHost<StreamChunk>
} {
  let ids = 0
  const writer = new TurnTranscriptWriter({
    forward: (threadId, chunk, stamp): void => {
      forward({ threadId, chunk, stamp })
    },
    loadThread: getProjectThread,
    snapshot,
    appendMessage,
    updateMeta,
    defaultModel: (): string | undefined => undefined,
    createId: (): string => {
      ids += 1
      return `msg-${String(ids)}`
    },
    onError: (error): void => {
      writeErrors.push(error)
    },
  })
  // What the window would receive for chunks main does not own.
  const windowHost: AgentHost<StreamChunk> = {
    emit: (threadId, chunk) => {
      forward({ threadId, chunk, stamp: undefined })
    },
  }
  const dependencies: AgentDispatcherDependencies = {
    loadHistory: async () => [],
    saveHistory: async () => undefined,
    recoverHistory: async () => [],
    loadEpoch: async () => null,
    saveEpoch: async () => undefined,
    appendMachineContinuation: async () => undefined,
    now: () => 100,
    createId: () => 'audit-id',
    loadPlan: async () => null,
    prepareExecutionContext: async () => context,
    isScheduledAutomationRun: () => false,
    transcriptLength: async () => 0,
    run: async (threadId, userContent, priorMessages, host) => {
      for (const chunk of chunks()) host.emit(threadId, chunk)
      return {
        usage: { inputTokens: 0, outputTokens: 0 },
        messages: [...priorMessages, { role: 'user', content: userContent }],
      }
    },
  }
  return {
    dispatcher: new AgentDispatcher(windowHost, new ToolRegistry(), dependencies, writer),
    writer,
    windowHost,
  }
}

/** Run one turn and wait until main's writes for it have landed. */
async function dispatch(turn: {
  dispatcher: AgentDispatcher
  writer: TurnTranscriptWriter
}): Promise<void> {
  await turn.dispatcher.dispatch({
    projectId: PROJECT,
    threadId: THREAD,
    payload: { userContent: 'What does the plan say?', invokedSkills: [], priorTodos: [] },
  })
  await turn.writer.settled(THREAD)
}

async function stored(): Promise<NonNullable<Awaited<ReturnType<typeof getProjectThread>>>> {
  const thread = await getProjectThread(PROJECT, THREAD)
  if (!thread) throw new Error('expected the thread on disk')
  return thread
}

describe('TurnTranscriptWriter', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(async () => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-turn-transcript-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
    // The window wrote the thread and the human prompt before starting the turn.
    await createThread(PROJECT, threadWith(THREAD))
    await appendMessage(PROJECT, THREAD, humanPrompt('u1', 'What does the plan say?'))
  })

  afterEach(() => {
    assert.deepEqual(writeErrors.splice(0), [], 'no transcript write failed')
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('persists running status before any output or window is attached', async () => {
    await updateMeta(PROJECT, THREAD, { status: 'idle' })
    const { writer } = harness(() => [])
    const transcript = writer.begin(PROJECT, THREAD)
    try {
      await writer.attach(PROJECT, [THREAD])
      assert.equal((await stored()).status, 'running')
    } finally {
      transcript.end()
      await writer.settled(THREAD)
    }
    assert.equal((await stored()).status, 'idle')
  })

  it('writes the whole turn with no window to deliver it to', async () => {
    // The window closed before the turn started streaming: nothing is received.
    const turn = harness(recordedTurn)
    await dispatch(turn)

    const thread = await stored()
    assert.deepEqual(
      thread.messages.map((message) => [message.id, message.role]),
      [
        ['u1', 'user'],
        ['msg-1', 'assistant'],
        ['msg-2', 'assistant'],
      ],
    )
    assert.equal(thread.messages.at(1)?.content, 'Checking the plan before answering.')
    assert.equal(thread.messages.at(1)?.toolCalls.at(0)?.result, '1. Ship it')
    assert.equal(thread.messages.at(2)?.content, 'The plan has one step: ship it. Done.')
    assert.equal(thread.messages.at(2)?.turnOutcome?.status, 'completed')
    assert.equal(thread.status, 'idle')
    assert.deepEqual(
      [thread.usage.inputTokens, thread.usage.outputTokens],
      [280, 70],
      'usage from both calls',
    )
    assert.equal(thread.todos?.[0]?.content, 'Ship it')
  })

  it('stamps every chunk so an open window draws the same messages it wrote', async () => {
    const window = createStore({
      threads: [threadWith(THREAD, [humanPrompt('u1', 'What does the plan say?')])],
      activeThreadId: THREAD,
    })
    let stamped: string[] = []
    const reducer = createTranscriptReducer(window, { createMessageId: () => stamped.shift() })
    const deliveries: Delivery[] = []
    const turn = harness(recordedTurn, (delivery) => {
      deliveries.push(delivery)
      stamped = [...(delivery.stamp?.messageIds ?? [])]
      reducer.apply(delivery.threadId, delivery.chunk)
    })
    await dispatch(turn)

    assert.ok(deliveries.length > 0)
    assert.ok(
      deliveries.every((delivery) => delivery.stamp !== undefined),
      'every chunk of a dispatched turn is main-owned',
    )
    const thread = await stored()
    assert.deepEqual(
      comparable(getThreadById(window, THREAD)?.messages ?? []),
      comparable(thread.messages),
    )
  })

  it('keeps output of a turn that dies before done', async () => {
    const turn = harness(() => recordedTurn().slice(0, 6))
    await dispatch(turn)

    const thread = await stored()
    assert.deepEqual(
      thread.messages.map((message) => message.id),
      ['u1', 'msg-1'],
    )
    assert.equal(thread.messages.at(1)?.toolCalls.at(0)?.status, 'done')
  })

  it('labels a user Stop the way the window does, on disk and on the wire', async () => {
    const outcome = {
      status: 'cancelled' as const,
      stopReason: 'cancelled' as const,
      source: 'user' as const,
      executor: 'local' as const,
      provider: 'openai',
      model: 'openai:gpt-5.5',
      endedAt: 10,
    }
    const deliveries: Delivery[] = []
    const turn = harness(
      () => [
        { type: 'text', text: 'Partial' },
        { type: 'turn_outcome', outcome },
        { type: 'done' },
      ],
      (delivery) => deliveries.push(delivery),
    )
    // Recorded while the turn runs, as `agent:abort` does; `begin` forgets any
    // reason left over from an earlier turn.
    const running = dispatch(turn)
    turn.writer.noteUserAbort(THREAD, 'send_now')
    await running

    const thread = await stored()
    assert.equal(thread.messages.at(-1)?.turnOutcome?.userAbort, 'send_now')
    const wire = deliveries.find((delivery) => delivery.chunk.type === 'turn_outcome')?.chunk
    assert.equal(wire?.type === 'turn_outcome' ? wire.outcome.userAbort : undefined, 'send_now')
  })

  it('merges a summary label into a message after the turn', async () => {
    const turn = harness(recordedTurn)
    await dispatch(turn)

    await turn.writer.annotate(PROJECT, THREAD, 'msg-1', { commandSummary: 'Read the plan' })

    const thread = await stored()
    assert.equal(thread.messages.at(1)?.commandSummary, 'Read the plan')
    assert.equal(thread.messages.at(1)?.toolCalls.at(0)?.result, '1. Ship it')
    assert.equal(thread.messages.length, 3)
  })

  it('records a background task ending on its card after the turn, without the window writing it', async () => {
    const deliveries: Delivery[] = []
    const turn = harness(recordedTurn, (delivery) => deliveries.push(delivery))
    await dispatch(turn)
    deliveries.length = 0

    const phase = {
      state: 'exited' as const,
      since: 50,
      launched: true,
      exitCode: 1,
      backgroundTaskId: 'bg-1',
    }
    await turn.writer.updateCommandPhase(PROJECT, THREAD, 'call-read', phase)

    const thread = await stored()
    const call = thread.messages.at(1)?.toolCalls.find((candidate) => candidate.id === 'call-read')
    assert.deepEqual(call?.commandPhase, phase)
    assert.equal(call?.result, '1. Ship it', 'the rest of the call is untouched')
    assert.equal(thread.messages.length, 3)
    assert.deepEqual(deliveries, [
      {
        threadId: THREAD,
        chunk: { type: 'tool_call_update', toolCallId: 'call-read', commandPhase: phase },
        stamp: { messageIds: [] },
      },
    ])
  })

  it('ignores an ending for a tool call the thread does not hold', async () => {
    const deliveries: Delivery[] = []
    const turn = harness(recordedTurn, (delivery) => deliveries.push(delivery))
    await dispatch(turn)
    deliveries.length = 0
    const before = await stored()

    await turn.writer.updateCommandPhase(PROJECT, THREAD, 'call-missing', {
      state: 'cancelled',
      since: 50,
      launched: true,
    })

    assert.deepEqual(await stored(), before)
    assert.deepEqual(deliveries, [])
  })

  it('restores an in-flight bubble and continues with the same identity and full prefix', async () => {
    const window = createStore({ threads: [threadWith(THREAD)] })
    let ids: string[] = []
    const reducer = createTranscriptReducer(window, { createMessageId: () => ids.shift() })
    let attached = false
    const turn = harness(
      () => [],
      ({ threadId, chunk, stamp }) => {
        if (!attached) return
        ids = [...(stamp?.messageIds ?? [])]
        reducer.apply(threadId, chunk)
      },
      (snapshot) => {
        if (!attached) return
        window.setState({ threads: [snapshot.thread] })
        reducer.restore(THREAD, snapshot.checkpoint)
      },
    )
    const transcript = turn.writer.begin(PROJECT, THREAD)
    transcript.emit({ type: 'text', text: 'Complete prefix ' })
    // attach waits for seeding, then snapshots the already-reduced prefix.
    await turn.writer.attach(PROJECT, [THREAD])
    assert.equal(
      getThreadById(window, THREAD)?.messages.length,
      0,
      'the first prefix was not delivered',
    )
    attached = true
    await turn.writer.attach(PROJECT, [THREAD])
    transcript.emit({ type: 'text', text: 'and suffix.' })
    transcript.emit({ type: 'done' })
    transcript.end()
    await turn.writer.settled(THREAD)
    assert.deepEqual(
      comparable(getThreadById(window, THREAD)?.messages ?? []),
      comparable((await stored()).messages),
    )
    assert.equal(
      getThreadById(window, THREAD)?.messages.at(-1)?.content,
      'Complete prefix and suffix.',
    )
    assert.equal(getThreadById(window, THREAD)?.messages.length, 2)
  })

  it('persists context and resolved model metadata without a renderer', async () => {
    await updateMeta(PROJECT, THREAD, {
      automation: { scheduleId: 'schedule', scheduleName: 'Scheduled task', triggeredAt: 1 },
    })
    const turn = harness(() => [
      { type: 'turn_parameters', parameters: {}, model: 'openai:gpt-5.5' },
      {
        type: 'context_pressure',
        contextWindow: 1000,
        conversationBudget: 800,
        conversationTokens: 400,
        fillRatio: 0.5,
      },
      { type: 'text', text: 'Finished.' },
      {
        type: 'turn_outcome',
        outcome: {
          status: 'failed',
          stopReason: 'error',
          source: 'provider',
          executor: 'local',
          provider: 'openai',
          model: 'openai:gpt-5.5',
          endedAt: 20,
          error: { message: 'Provider unavailable' },
        },
      },
      { type: 'done' },
    ])
    await dispatch(turn)
    const thread = await stored()
    assert.equal(thread.resolvedModel, 'openai:gpt-5.5')
    assert.equal(thread.contextSnapshot?.conversationTokens, 400)
    assert.equal(thread.contextSnapshot.fillRatio, 0.5)
    assert.equal(thread.automation?.failure?.message, 'Provider unavailable')
  })

  it('leaves an unknown thread to the window, unstamped', async () => {
    const deliveries: Delivery[] = []
    const { writer } = harness(recordedTurn, (delivery) => deliveries.push(delivery))
    const transcript = writer.begin(PROJECT, 'not-on-disk')
    for (const chunk of recordedTurn()) transcript.emit(chunk)
    transcript.end()
    await writer.settled('not-on-disk')

    assert.equal(deliveries.length, recordedTurn().length)
    assert.ok(deliveries.every((delivery) => delivery.stamp === undefined))
  })
})
