import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import { ToolRegistry } from './tool-registry.ts'
import {
  AgentDispatcher,
  type AgentDispatcherDependencies,
  type AgentDispatchRequest,
} from './agent-dispatcher.ts'
import type { ThreadExecutionContext } from './thread-execution-context.ts'

const host: AgentHost<StreamChunk> = { emit: () => undefined }
const registry = new ToolRegistry()
const context: ThreadExecutionContext = {
  projectId: 'project-1',
  threadId: 'thread-1',
  projectRoot: '/workspace',
  root: '/workspace',
  checkoutMode: 'shared',
  branch: null,
}

function request(overrides?: Partial<AgentDispatchRequest>): AgentDispatchRequest {
  return {
    projectId: 'project-1',
    threadId: 'thread-1',
    payload: { userContent: 'continue', invokedSkills: [], priorTodos: [] },
    ...overrides,
  }
}

function dependencies(
  overrides?: Partial<AgentDispatcherDependencies>,
): AgentDispatcherDependencies {
  return {
    loadHistory: async () => [],
    saveHistory: async () => undefined,
    prepareExecutionContext: async () => context,
    run: async (_threadId, userContent, priorMessages) => ({
      usage: { inputTokens: 0, outputTokens: 0 },
      messages: [...priorMessages, { role: 'user', content: userContent }],
    }),
    ...overrides,
  }
}

describe('AgentDispatcher', () => {
  it('loads history once and commits each completed turn', async () => {
    const loaded: LLMMessage[] = [{ role: 'assistant', content: 'prior' }]
    const saved: LLMMessage[][] = []
    let loadCount = 0
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        loadHistory: async () => {
          loadCount += 1
          return loaded
        },
        saveHistory: async (_projectId, _threadId, messages) => {
          saved.push(messages)
        },
      }),
    )

    await dispatcher.dispatch(request())
    await dispatcher.dispatch(
      request({ payload: { userContent: 'again', invokedSkills: [], priorTodos: [] } }),
    )

    assert.equal(loadCount, 1)
    assert.deepEqual(saved, [
      [...loaded, { role: 'user', content: 'continue' }],
      [...loaded, { role: 'user', content: 'continue' }, { role: 'user', content: 'again' }],
    ])
  })

  it('rejects a second active dispatch for the same project thread', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        run: async (_threadId, userContent: UserContent, priorMessages) => {
          await gate
          return {
            usage: { inputTokens: 0, outputTokens: 0 },
            messages: [...priorMessages, { role: 'user', content: userContent }],
          }
        },
      }),
    )

    const first = dispatcher.dispatch(request())
    await assert.rejects(dispatcher.dispatch(request()), /already running for thread "thread-1"/)
    release()
    await first
    assert.equal(dispatcher.isActive('project-1', 'thread-1'), false)
  })

  it('does not run when trusted execution context resolution fails', async () => {
    let ran = false
    const dispatcher = new AgentDispatcher(
      host,
      registry,
      dependencies({
        prepareExecutionContext: async () => null,
        run: async () => {
          ran = true
          return { usage: { inputTokens: 0, outputTokens: 0 }, messages: [] }
        },
      }),
    )

    await dispatcher.dispatch(request())

    assert.equal(ran, false)
  })
})
