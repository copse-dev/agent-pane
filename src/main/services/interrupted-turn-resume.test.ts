import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Message, Thread, TurnOutcome } from '@shared/types'
import type { MachineDispatchResult } from '@shared/types/machine-dispatch.ts'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  getThreadById,
  setMessageTurnOutcome,
} from '@shared/store/thread-helpers.ts'
import { INTERRUPTED_TURN_CONTINUATION } from '@shared/turn-recovery.ts'
import type { MachineAgentDispatchRequest } from './agent-dispatcher.ts'
import {
  RESTART_RESUME_DISPLAY,
  RESTART_RESUME_OPERATION_PREFIX,
  resumeInterruptedTurns,
  transcriptCanResume,
  wasInterruptedByExit,
  type InterruptedTurnResumeDependencies,
} from './interrupted-turn-resume.ts'

const BOOTED_AT = 1_000_000

function completed(): TurnOutcome {
  return {
    status: 'completed',
    stopReason: 'end_turn',
    source: 'provider',
    executor: 'local',
    provider: 'test-provider',
    model: 'test-model',
    endedAt: 10,
  }
}

/** A transcript built through the same helpers the reducer uses. */
function transcript(
  build: (add: (role: Message['role'], text: string, origin?: Message['origin']) => string) => void,
  outcomeFor?: (ids: string[]) => string | undefined,
): Message[] {
  const store = createStore({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  const ids: string[] = []
  build((role, text, origin) => {
    const id = addMessage(store, threadId, role, text, undefined, undefined, {
      ...(origin ? { origin } : {}),
    })
    ids.push(id)
    return id
  })
  const settled = outcomeFor?.(ids)
  if (settled) setMessageTurnOutcome(store, threadId, settled, completed())
  return getThreadById(store, threadId)?.messages ?? []
}

type Meta = Parameters<typeof wasInterruptedByExit>[0]

function meta(overrides: Partial<Meta> = {}): Meta {
  return { id: 'thread-1', status: 'running', ...overrides }
}

describe('wasInterruptedByExit', () => {
  it('takes a thread the last exit left running', () => {
    assert.equal(wasInterruptedByExit(meta(), BOOTED_AT), true)
  })

  it('takes a thread the window already settled on this launch', () => {
    const settled = meta({ status: 'idle', interruptedTurnAt: BOOTED_AT + 5 })
    assert.equal(wasInterruptedByExit(settled, BOOTED_AT), true)
  })

  it('leaves an interruption the user already saw on an earlier launch', () => {
    const seen = meta({ status: 'idle', interruptedTurnAt: BOOTED_AT - 5 })
    assert.equal(wasInterruptedByExit(seen, BOOTED_AT), false)
    assert.equal(wasInterruptedByExit(meta({ status: 'idle' }), BOOTED_AT), false)
  })

  it('leaves archived threads, side chats, automations and queued follow-ups alone', () => {
    assert.equal(wasInterruptedByExit(meta({ archivedAt: 1 }), BOOTED_AT), false)
    const sideChat: Thread['sideChat'] = {
      parentThreadId: 'parent',
      anchorMessageId: 'm',
    }
    assert.equal(wasInterruptedByExit(meta({ sideChat }), BOOTED_AT), false)
    const automation = {
      scheduleId: 's',
      scheduleName: 'Nightly',
      triggeredAt: 1,
    }
    assert.equal(wasInterruptedByExit(meta({ automation }), BOOTED_AT), false)
    const pendingMessages: Thread['pendingMessages'] = [
      {
        messageId: 'queued',
        payload: { content: 'next', invokedSkills: [], priorTodos: [] },
        createdAt: 1,
      },
    ]
    assert.equal(wasInterruptedByExit(meta({ pendingMessages }), BOOTED_AT), false)
  })
})

describe('transcriptCanResume', () => {
  it('continues a turn cut off after the prompt or mid-answer', () => {
    assert.equal(transcriptCanResume(transcript((add) => add('user', 'fix it'))), true)
    assert.equal(
      transcriptCanResume(
        transcript((add) => {
          add('user', 'fix it')
          add('assistant', 'Looking at')
        }),
      ),
      true,
    )
  })

  it('leaves a turn that finished, or an empty thread', () => {
    const finished = transcript(
      (add) => {
        add('user', 'fix it')
        add('assistant', 'Done.')
      },
      (ids) => ids[1],
    )
    assert.equal(transcriptCanResume(finished), false)
    assert.equal(transcriptCanResume([]), false)
  })

  it('resumes once: a restart continuation cut off again is left for the user', () => {
    const again = transcript((add) => {
      add('user', 'fix it')
      add('assistant', 'Looking at')
      add('user', RESTART_RESUME_DISPLAY, {
        kind: 'machine',
        operationId: `${RESTART_RESUME_OPERATION_PREFIX}first`,
      })
      add('assistant', 'Picking up')
    })
    assert.equal(transcriptCanResume(again), false)
  })

  it('still resumes after other machine continuations', () => {
    const woken = transcript((add) => {
      add('user', 'fix it')
      add('user', 'Background task finished', {
        kind: 'machine',
        operationId: 'bg-1',
      })
      add('assistant', 'The build')
    })
    assert.equal(transcriptCanResume(woken), true)
  })
})

function harness(
  threads: Record<string, readonly Meta[]>,
  messages: Record<string, readonly Message[]>,
  options: { running?: string[]; result?: MachineDispatchResult } = {},
): {
  deps: InterruptedTurnResumeDependencies
  dispatched: MachineAgentDispatchRequest[]
  errors: unknown[]
} {
  const dispatched: MachineAgentDispatchRequest[] = []
  const errors: unknown[] = []
  let next = 0
  return {
    dispatched,
    errors,
    deps: {
      listProjectIds: () => Object.keys(threads),
      loadThreadMetas: async (projectId) => threads[projectId] ?? [],
      loadMessages: async (_projectId, threadId) => messages[threadId] ?? [],
      loadTurnTreeId: async (_projectId, threadId) =>
        threadId === 'legacy' ? null : `tree-${threadId}`,
      isRunning: (threadId) => options.running?.includes(threadId) ?? false,
      dispatchMachine: async (request): Promise<MachineDispatchResult> => {
        dispatched.push(request)
        return options.result ?? 'completed'
      },
      createId: () => `op-${String((next += 1))}`,
      bootedAt: BOOTED_AT,
      onError: (error) => errors.push(error),
    },
  }
}

describe('resumeInterruptedTurns', () => {
  const cutOff = transcript((add) => add('user', 'fix it'))

  it('dispatches one continuation per cut-off thread, across projects', async () => {
    const { deps, dispatched } = harness(
      {
        'project-a': [meta({ id: 'a1', todos: [] }), meta({ id: 'a2', status: 'idle' })],
        'project-b': [meta({ id: 'b1', workingBrief: 'Ship the fix' })],
      },
      { a1: cutOff, a2: cutOff, b1: cutOff },
    )
    const resumed = await resumeInterruptedTurns(deps)
    assert.deepEqual(
      resumed.map((turn) => [turn.projectId, turn.threadId, turn.result]),
      [
        ['project-a', 'a1', 'completed'],
        ['project-b', 'b1', 'completed'],
      ],
    )
    assert.deepEqual(dispatched[0], {
      projectId: 'project-a',
      threadId: 'a1',
      operationId: `${RESTART_RESUME_OPERATION_PREFIX}op-1`,
      turnTreeId: 'tree-a1',
      display: { content: RESTART_RESUME_DISPLAY },
      payload: {
        userContent: INTERRUPTED_TURN_CONTINUATION,
        invokedSkills: [],
        priorTodos: [],
      },
    })
    assert.equal(dispatched[1]?.payload.workingBrief, 'Ship the fix')
  })

  it('uses the thread id as the turn tree of a thread that predates epochs', async () => {
    const { deps, dispatched } = harness({ p: [meta({ id: 'legacy' })] }, { legacy: cutOff })
    await resumeInterruptedTurns(deps)
    assert.equal(dispatched[0]?.turnTreeId, 'legacy')
  })

  it('skips a thread that is already running again', async () => {
    const { deps, dispatched } = harness(
      { p: [meta({ id: 'live' })] },
      { live: cutOff },
      {
        running: ['live'],
      },
    )
    await resumeInterruptedTurns(deps)
    assert.deepEqual(dispatched, [])
  })

  it('reports what the dispatcher refused, such as a spent budget', async () => {
    const { deps } = harness(
      { p: [meta({ id: 't' })] },
      { t: cutOff },
      {
        result: 'budget-exhausted',
      },
    )
    const [resumed] = await resumeInterruptedTurns(deps)
    assert.equal(resumed?.result, 'budget-exhausted')
  })

  it('keeps going when one project or dispatch fails', async () => {
    const { deps, errors } = harness({ broken: [], fine: [meta({ id: 'ok' })] }, { ok: cutOff })
    const failing: InterruptedTurnResumeDependencies = {
      ...deps,
      loadThreadMetas: async (projectId) => {
        if (projectId === 'broken') throw new Error('unreadable store')
        return deps.loadThreadMetas(projectId)
      },
      dispatchMachine: async () => {
        throw new Error('provider unavailable')
      },
    }
    const resumed = await resumeInterruptedTurns(failing)
    assert.deepEqual(
      resumed.map((turn) => turn.result),
      ['failed'],
    )
    assert.equal(errors.length, 2)
  })
})
