import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import * as agentService from './agent-service.ts'
import { ToolRegistry } from './tool-registry.ts'
import { runWithActiveRunIdentity } from './thread-models.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'
import { getPluginService } from './plugins/plugin-service.ts'
import { defineTool } from '@shared/types'
import type { LLMMessage, LLMProvider } from '@shared/types'
import { ResponsesProvider } from '@copse/llm/responses-provider.ts'
import { clearReasoningReplayForTests } from '@copse/llm/reasoning-replay-store.ts'

type Body = Record<string, unknown>

const THREAD = 'thread-turn-prefix'
const GPT = 'gpt-5.6-sol'

/** Scripted Responses endpoint: alternates a tool call and a plain answer. */
function scriptedClient(bodies: Body[]): unknown {
  let step = 0
  return {
    responses: {
      create: async (body: Body): Promise<AsyncIterable<unknown>> => {
        bodies.push(structuredClone(body))
        const calling = step++ % 2 === 0
        const n = bodies.length
        return (async function* (): AsyncGenerator {
          if (calling) {
            yield {
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                call_id: `call_${String(n)}`,
                name: 'read_file',
                arguments: JSON.stringify({ path: `file-${String(n)}.ts` }),
              },
            }
          } else {
            yield { type: 'response.output_text.delta', delta: `Answer ${String(n)}.` }
          }
          yield {
            type: 'response.completed',
            response: {
              output: [{ type: calling ? 'function_call' : 'message' }],
              usage: {
                input_tokens: 100,
                output_tokens: 10,
                input_tokens_details: { cached_tokens: 0 },
              },
            },
          }
        })()
      },
    },
  }
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register(
    defineTool({
      name: 'read_file',
      description: 'Read a file',
      parameters: z.object({ path: z.string() }),
      execute: ({ path }) => Promise.resolve(`contents of ${path}`),
    }),
  )
  return tools
}

async function runTurn(
  model: string,
  provider: LLMProvider,
  prompt: string,
  history: LLMMessage[],
): Promise<LLMMessage[]> {
  const result = await runWithThreadExecutionContext(
    {
      projectId: 'project-1',
      threadId: THREAD,
      projectRoot: '/workspace',
      root: '/workspace',
      checkoutMode: 'shared',
      branch: null,
    },
    () =>
      runWithActiveRunIdentity(THREAD, () =>
        agentService.runAgent(THREAD, prompt, history, { emit: () => undefined }, registry(), {
          model,
          provider,
          contextWindow: 200_000,
          adaptiveExtensions: false,
          // A pinned plan makes the todo-pin turnStart hook inject per-turn
          // operator steering — the trailing developer message under test.
          priorTodos: [{ id: 'a', content: 'Read the parser', status: 'in_progress' }],
        }),
      ),
  )
  return result.messages
}

function gptProvider(bodies: Body[]): ResponsesProvider {
  const provider = new ResponsesProvider(GPT, { apiKey: 'test', promptCacheKey: THREAD })
  Object.defineProperty(provider, 'client', { value: scriptedClient(bodies), configurable: true })
  return provider
}

function inputOf(body: Body | undefined): unknown[] {
  const input = body?.['input']
  assert.ok(Array.isArray(input), 'request carries an input array')
  return input
}

function isDeveloperItem(item: unknown): boolean {
  return typeof item === 'object' && item !== null && Reflect.get(item, 'role') === 'developer'
}

describe('turn-boundary prompt prefix (GPT, trailing developer steering)', () => {
  let cacheReports: unknown[] = []
  const originalError = console.error
  const previousFlag = process.env['COPSE_DEBUG_PROMPT_CACHE']
  beforeEach(() => {
    // Boot order matches main/index.ts: persisted plugin enablement is applied
    // before any turn builds a system prompt.
    getPluginService()
    clearReasoningReplayForTests()
    cacheReports = []
    process.env['COPSE_DEBUG_PROMPT_CACHE'] = '1'
    console.error = (...args: unknown[]): void => {
      if (args[0] === '[prompt-cache]' && typeof args[1] === 'string') {
        cacheReports.push(JSON.parse(args[1]))
      }
    }
  })
  afterEach(() => {
    console.error = originalError
    if (previousFlag === undefined) delete process.env['COPSE_DEBUG_PROMPT_CACHE']
    else process.env['COPSE_DEBUG_PROMPT_CACHE'] = previousFlag
    clearReasoningReplayForTests()
  })

  it("starts the next turn's request with the previous turn's final request, unchanged", async () => {
    const bodies: Body[] = []
    const first = await runTurn(GPT, gptProvider(bodies), 'Look at the parser.', [])
    const firstTurnRequests = bodies.length
    assert.ok(
      inputOf(bodies[0]).some(isDeveloperItem),
      'the first turn carries trailing developer steering',
    )

    await runTurn(GPT, gptProvider(bodies), 'Now look at the lexer.', first)
    assert.ok(bodies.length > firstTurnRequests, 'the second turn made requests')

    const previousFinal = inputOf(bodies[firstTurnRequests - 1])
    const nextFirst = inputOf(bodies[firstTurnRequests])
    assert.deepEqual(nextFirst.slice(0, previousFinal.length), previousFinal)
    assert.ok(
      nextFirst.slice(previousFinal.length).some(isDeveloperItem),
      'the second turn appends its own steering after the earlier turn',
    )

    // Every request in the thread, not only the boundary, extends the last one,
    // and the built-in diagnostics agree.
    for (let i = 1; i < bodies.length; i++) {
      const previous = inputOf(bodies[i - 1])
      assert.deepEqual(
        inputOf(bodies[i]).slice(0, previous.length),
        previous,
        `request ${String(i)}`,
      )
      assert.deepEqual(
        bodies[i]?.['tools'],
        bodies[i - 1]?.['tools'],
        `tools at request ${String(i)}`,
      )
    }
    assert.equal(cacheReports.length, bodies.length)
    for (const report of cacheReports.slice(1)) {
      assert.equal(Reflect.get(Object(report), 'firstChangedInputIndex'), -1)
      assert.equal(Reflect.get(Object(report), 'systemChanged'), false)
    }
  })

  it('drops earlier developer steering when the thread continues on a model without that role', async () => {
    const bodies: Body[] = []
    const first = await runTurn(GPT, gptProvider(bodies), 'Look at the parser.', [])
    assert.ok(first.some((message) => message.role === 'developer'))

    const seen: LLMMessage[][] = []
    const claude: LLMProvider = {
      stream: async function* (messages) {
        seen.push(structuredClone(messages))
        yield { type: 'text' as const, text: 'Done.' }
      },
    }
    await runTurn('claude-sonnet-5-5', claude, 'Now look at the lexer.', first)
    assert.ok(seen.length > 0)
    for (const messages of seen) {
      assert.ok(!messages.some((message) => message.role === 'developer'))
    }
  })
})
