import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { parseAgentRunPayload } from '@copse/agent/parse-agent-run-payload.ts'
import type { TurnOutcome } from '@shared/types'
import { createStore } from '@shared/store/store.ts'
import {
  addMessage,
  addToolCall,
  createThread,
  getThreadById,
  setMessageTurnOutcome,
  setThreadStatus,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { INTERRUPTED_TURN_CONTINUATION } from '../controller/turn-recovery.ts'
import { mountConversation } from './conversation.ts'

function outcome(status: 'completed' | 'failed', model: string): TurnOutcome {
  return {
    status,
    stopReason: status === 'completed' ? 'end_turn' : 'error',
    source: 'provider',
    executor: 'local',
    provider: 'openrouter',
    model,
    ...(status === 'failed' ? { error: { code: 502, message: 'upstream disconnected' } } : {}),
    endedAt: 10,
  }
}

function setup(): {
  store: ReturnType<typeof createStore>
  threadId: string
  failedId: string
  api: ApiClient
  runs: string[]
  selections: string[]
} {
  const store = createStore({ activeProjectId: 'project-1' })
  const threadId = createThread(store)
  addMessage(store, threadId, 'user', 'Upload the report, then remove the generated file')
  const completedId = addMessage(
    store,
    threadId,
    'assistant',
    'Previous answer',
    undefined,
    undefined,
    {
      model: 'openai:gpt-5.4',
    },
  )
  setMessageTurnOutcome(store, threadId, completedId, outcome('completed', 'openai:gpt-5.4'))
  const failedId = addMessage(
    store,
    threadId,
    'assistant',
    'The report is uploaded. Cleaning up next.',
    undefined,
    undefined,
    { model: 'openrouter:x-ai/grok-4.5' },
  )
  addToolCall(store, failedId, {
    id: 'upload-1',
    name: 'read_file',
    args: { path: 'upload-result.txt' },
    status: 'done',
    result: 'uploaded',
  })
  setMessageTurnOutcome(store, threadId, failedId, outcome('failed', 'openrouter:x-ai/grok-4.5'))

  const runs: string[] = []
  const selections: string[] = []
  const base = createFakeApi()
  const api: ApiClient = {
    ...base,
    agent: {
      ...base.agent,
      run: (_projectId, _threadId, payload) => {
        runs.push(payload)
        return Promise.resolve()
      },
    },
    threads: {
      ...base.threads,
      recordModelSelection: (projectId, selectedThreadId, by, from, to) => {
        selections.push(to)
        return Promise.resolve({
          id: `${projectId}:${selectedThreadId}:${to}`,
          recordedAt: 10,
          by,
          ...(from !== undefined ? { from } : {}),
          to,
        })
      },
    },
  }
  return { store, threadId, failedId, api, runs, selections }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('interrupted turn recovery card', () => {
  it('renders after the exact failed message with partial output and completed tools intact', () => {
    const { store, failedId, api, runs } = setup()
    const host = document.createElement('div')
    document.body.append(host)
    const unmount = mountConversation(host, store, api)

    const failed = document.querySelector(`[data-message-id="${failedId}"]`)
    const card = document.querySelector<HTMLElement>(`[data-turn-recovery-for="${failedId}"]`)
    assert.ok(failed)
    assert.ok(card)
    assert.equal(failed.nextElementSibling, card)
    assert.match(failed.textContent, /The report is uploaded\. Cleaning up next\./)
    assert.match(failed.textContent, /upload/i)
    assert.match(card.textContent, /Completed tool calls stay in the history/)
    assert.match(card.textContent, /An earlier turn completed with/)
    assert.equal(runs.length, 0, 'rendering the offer never dispatches automatically')
    unmount()
  })

  it('appears when a live failed turn settles, after its outcome arrived while running', () => {
    const { store, threadId, failedId, api } = setup()
    setThreadStatus(store, threadId, 'running')
    const host = document.createElement('div')
    document.body.append(host)
    const unmount = mountConversation(host, store, api)

    assert.equal(document.querySelector('[data-turn-recovery-card]'), null)
    setThreadStatus(store, threadId, 'idle')

    assert.ok(document.querySelector(`[data-turn-recovery-for="${failedId}"]`))
    unmount()
  })

  it('dispatches one explicit continuation and removes the now-stale offer', () => {
    const { store, threadId, api, runs } = setup()
    const host = document.createElement('div')
    document.body.append(host)
    const unmount = mountConversation(host, store, api)

    const retry = [...document.querySelectorAll<HTMLButtonElement>('.turn-recovery-button')].find(
      (button) => button.textContent.includes('Retry this turn'),
    )
    assert.ok(retry)
    retry.click()

    assert.equal(runs.length, 1)
    assert.equal(parseAgentRunPayload(runs[0] ?? '').userContent, INTERRUPTED_TURN_CONTINUATION)
    assert.equal(
      getThreadById(store, threadId)?.messages.at(-1)?.content,
      INTERRUPTED_TURN_CONTINUATION,
    )
    assert.equal(document.querySelector('[data-turn-recovery-card]'), null)
    unmount()
  })

  it('keeps a stale switched-project card inert and available for the current owner to re-render', () => {
    const { store, api, runs } = setup()
    const host = document.createElement('div')
    document.body.append(host)
    const unmount = mountConversation(host, store, api)
    const retry = [...document.querySelectorAll<HTMLButtonElement>('.turn-recovery-button')].find(
      (button) => button.textContent.includes('Retry this turn'),
    )
    assert.ok(retry)

    store.setState({ activeProjectId: 'project-2' })
    retry.click()

    assert.equal(runs.length, 0)
    assert.equal(retry.disabled, false)
    assert.ok(document.querySelector('[data-turn-recovery-card]'))
    unmount()
  })

  it('labels the last successful route as historical and switches through selection before retry', () => {
    const { store, threadId, api, runs, selections } = setup()
    const host = document.createElement('div')
    document.body.append(host)
    const unmount = mountConversation(host, store, api)

    const fallback = [
      ...document.querySelectorAll<HTMLButtonElement>('.turn-recovery-button'),
    ].find((button) => button.textContent.includes('and retry'))
    assert.ok(fallback)
    assert.match(
      document.querySelector<HTMLElement>('.turn-recovery-model-note')?.textContent ?? '',
      /An earlier turn completed with/,
    )
    fallback.click()

    assert.deepEqual(selections, ['openai:gpt-5.4'])
    assert.equal(parseAgentRunPayload(runs[0] ?? '').model, 'openai:gpt-5.4')
    assert.equal(getThreadById(store, threadId)?.model, 'openai:gpt-5.4')
    unmount()
  })
})
