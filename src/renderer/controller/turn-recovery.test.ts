import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseAgentRunPayload } from '@copse/agent/parse-agent-run-payload.ts'
import type { TurnOutcome } from '@shared/types'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  createThread,
  getThreadById,
  setMessageTurnOutcome,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import {
  INTERRUPTED_TURN_CONTINUATION,
  recoverFailedTurn,
  turnRecoveryForMessage,
} from './turn-recovery.ts'

function outcome(
  status: TurnOutcome['status'],
  executor: TurnOutcome['executor'],
  model: string,
  source: TurnOutcome['source'] = 'provider',
): TurnOutcome {
  return {
    status,
    stopReason: status === 'completed' ? 'end_turn' : 'error',
    source,
    executor,
    provider: 'test-provider',
    model,
    ...(status === 'failed' ? { error: { message: 'upstream disconnected' } } : {}),
    endedAt: 10,
  }
}

function setup(): {
  store: ReturnType<typeof createStore>
  api: ApiClient
  runs: Array<{ projectId: string; threadId: string; payload: string }>
  selections: Array<{ threadId: string; from: string | undefined; to: string }>
} {
  const store = createStore({ activeProjectId: 'project-1' })
  const runs: Array<{ projectId: string; threadId: string; payload: string }> = []
  const selections: Array<{ threadId: string; from: string | undefined; to: string }> = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      run: (projectId, threadId, payload) => {
        runs.push({ projectId, threadId, payload })
        return Promise.resolve()
      },
    },
    threads: {
      ...base.threads,
      recordModelSelection: (projectId, threadId, by, from, to) => {
        selections.push({ threadId, from, to })
        return Promise.resolve({
          id: `${projectId}:${threadId}:${to}`,
          recordedAt: 10,
          by,
          ...(from !== undefined ? { from } : {}),
          to,
        })
      },
    },
  }
  return { store, api, runs, selections }
}

function addFinishedAssistant(
  store: ReturnType<typeof createStore>,
  threadId: string,
  content: string,
  turnOutcome: TurnOutcome,
): string {
  const id = addMessage(store, threadId, 'assistant', content, undefined, undefined, {
    model: turnOutcome.model,
  })
  setMessageTurnOutcome(store, threadId, id, turnOutcome)
  return id
}

describe('explicit failed-turn recovery', () => {
  it('continues from persisted history instead of repeating the side-effecting prompt', () => {
    const { store, api, runs } = setup()
    const threadId = createThread(store)
    addMessage(store, threadId, 'user', 'Delete the generated files after uploading them')
    const failedId = addFinishedAssistant(
      store,
      threadId,
      'Uploaded report.pdf. Cleaning up',
      outcome('failed', 'local', 'openrouter:x-ai/grok-4.5'),
    )

    assert.equal(
      recoverFailedTurn(store, api, 'project-1', threadId, failedId, 'current-model'),
      true,
    )

    const thread = getThreadById(store, threadId)
    assert.ok(thread)
    assert.deepEqual(
      thread.messages.map((message) => message.content),
      [
        'Delete the generated files after uploading them',
        'Uploaded report.pdf. Cleaning up',
        INTERRUPTED_TURN_CONTINUATION,
      ],
    )
    assert.equal(thread.status, 'running')
    assert.equal(thread.continuationUsed, 0)
    assert.equal(typeof thread.currentEpoch, 'string')
    assert.equal(runs.length, 1)
    assert.equal(
      parseAgentRunPayload(runs[0]?.payload ?? '').userContent,
      INTERRUPTED_TURN_CONTINUATION,
    )
  })

  it('offers the most recent earlier completed model for provider failures across executors', () => {
    for (const executor of ['local', 'acp', 'remote'] as const) {
      const { store } = setup()
      const threadId = createThread(store)
      addFinishedAssistant(
        store,
        threadId,
        'Older success',
        outcome('completed', executor, 'model-a'),
      )
      addFinishedAssistant(
        store,
        threadId,
        'Latest success',
        outcome('completed', executor, 'model-b'),
      )
      const failedId = addFinishedAssistant(
        store,
        threadId,
        'Partial work',
        outcome('failed', executor, 'model-c'),
      )

      assert.deepEqual(turnRecoveryForMessage(getThreadById(store, threadId), failedId), {
        lastKnownGoodModel: 'model-b',
      })
    }
  })

  it('switches through the audited model-selection path before dispatching the continuation', () => {
    const { store, api, runs, selections } = setup()
    const threadId = createThread(store)
    addFinishedAssistant(
      store,
      threadId,
      'Working answer',
      outcome('completed', 'remote', 'remote-agent:cursor/claude-4.6-opus'),
    )
    const failedId = addFinishedAssistant(
      store,
      threadId,
      'Interrupted answer',
      outcome('failed', 'local', 'openrouter:x-ai/grok-4.5'),
    )
    store.setState({
      threads: store
        .getState()
        .threads.map((thread) =>
          thread.id === threadId ? { ...thread, model: 'auto:best' } : thread,
        ),
    })

    assert.equal(
      recoverFailedTurn(store, api, 'project-1', threadId, failedId, 'last-known-good'),
      true,
    )

    assert.deepEqual(selections, [
      {
        threadId,
        from: 'auto:best',
        to: 'remote-agent:cursor/claude-4.6-opus',
      },
    ])
    assert.equal(
      parseAgentRunPayload(runs[0]?.payload ?? '').model,
      'remote-agent:cursor/claude-4.6-opus',
    )
  })

  it('never offers a fallback for non-provider failures or the same concrete model', () => {
    const { store } = setup()
    const threadId = createThread(store)
    addFinishedAssistant(store, threadId, 'Success', outcome('completed', 'local', 'model-a'))
    const hostFailure = addFinishedAssistant(
      store,
      threadId,
      'Host failed',
      outcome('failed', 'local', 'model-b', 'host'),
    )
    assert.deepEqual(turnRecoveryForMessage(getThreadById(store, threadId), hostFailure), {})

    const sameModel = addFinishedAssistant(
      store,
      threadId,
      'Provider failed',
      outcome('failed', 'local', 'model-a'),
    )
    assert.deepEqual(turnRecoveryForMessage(getThreadById(store, threadId), sameModel), {})
  })

  it('does not skip a latest same-model success to advertise an older route', () => {
    const { store } = setup()
    const threadId = createThread(store)
    addFinishedAssistant(store, threadId, 'Old success', outcome('completed', 'local', 'model-a'))
    addFinishedAssistant(
      store,
      threadId,
      'Latest success',
      outcome('completed', 'local', 'model-b'),
    )
    const failedId = addFinishedAssistant(
      store,
      threadId,
      'Provider failed',
      outcome('failed', 'local', 'model-b'),
    )

    assert.deepEqual(turnRecoveryForMessage(getThreadById(store, threadId), failedId), {})
  })

  it('skips a legacy completed turn with no route and finds the latest usable model', () => {
    const { store } = setup()
    const threadId = createThread(store)
    addFinishedAssistant(
      store,
      threadId,
      'Attributed success',
      outcome('completed', 'local', 'model-a'),
    )
    const legacyId = addMessage(store, threadId, 'assistant', 'Legacy success')
    setMessageTurnOutcome(store, threadId, legacyId, outcome('completed', 'local', 'legacy-route'))
    const failedId = addFinishedAssistant(
      store,
      threadId,
      'Provider failed',
      outcome('failed', 'local', 'model-b'),
    )

    assert.deepEqual(turnRecoveryForMessage(getThreadById(store, threadId), failedId), {
      lastKnownGoodModel: 'model-a',
    })
  })

  it('rejects stale, running, switched-thread, and switched-project actions', () => {
    const cases = ['later-message', 'running', 'switched-thread', 'switched-project'] as const
    for (const state of cases) {
      const { store, api, runs } = setup()
      const threadId = createThread(store)
      const failedId = addFinishedAssistant(
        store,
        threadId,
        'Partial work',
        outcome('failed', 'local', 'model-b'),
      )
      if (state === 'later-message') addMessage(store, threadId, 'user', 'I handled it')
      if (state === 'running') setThreadStatus(store, threadId, 'running')
      if (state === 'switched-thread') createThread(store)
      if (state === 'switched-project') store.setState({ activeProjectId: 'project-2' })

      assert.equal(
        recoverFailedTurn(store, api, 'project-1', threadId, failedId, 'current-model'),
        false,
        state,
      )
      assert.equal(runs.length, 0, state)
    }
  })

  it('accepts a settled error state but rejects unloaded history and pending follow-ups', () => {
    const { store } = setup()
    const threadId = createThread(store)
    const failedId = addFinishedAssistant(
      store,
      threadId,
      'Partial work',
      outcome('failed', 'acp', 'acp:claude-agent-acp#opus'),
    )
    setThreadStatus(store, threadId, 'error')
    assert.deepEqual(turnRecoveryForMessage(getThreadById(store, threadId), failedId), {})

    store.setState({
      threads: store
        .getState()
        .threads.map((thread) =>
          thread.id === threadId ? { ...thread, pendingMessages: [] } : thread,
        ),
    })
    const pendingId = addMessage(store, threadId, 'user', 'queued')
    store.setState({
      threads: store.getState().threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: thread.messages.filter((message) => message.id !== pendingId),
              pendingMessages: [
                {
                  messageId: pendingId,
                  payload: { content: 'queued' },
                  createdAt: 11,
                  autoDispatch: false,
                },
              ],
            }
          : thread,
      ),
    })
    assert.equal(turnRecoveryForMessage(getThreadById(store, threadId), failedId), null)

    store.setState({
      threads: store
        .getState()
        .threads.map((thread) =>
          thread.id === threadId
            ? { ...thread, pendingMessages: [], messagesLoaded: false }
            : thread,
        ),
    })
    assert.equal(turnRecoveryForMessage(getThreadById(store, threadId), failedId), null)
  })

  it('accepts only one synchronous click for the same failure', () => {
    const { store, api, runs } = setup()
    const threadId = createThread(store)
    const failedId = addFinishedAssistant(
      store,
      threadId,
      'Partial work',
      outcome('failed', 'local', 'model-b'),
    )

    assert.equal(
      recoverFailedTurn(store, api, 'project-1', threadId, failedId, 'current-model'),
      true,
    )
    assert.equal(
      recoverFailedTurn(store, api, 'project-1', threadId, failedId, 'current-model'),
      false,
    )
    assert.equal(runs.length, 1)
  })
})
