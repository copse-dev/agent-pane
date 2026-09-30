import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@copse/std/array-utils.ts'
import { ResponsesProvider } from '@copse/llm/responses-provider.ts'
import { clearReasoningReplayForTests } from '@copse/llm/reasoning-replay-store.ts'
import { compareRequestPrefix, describeDivergence } from '@copse/llm/request-prefix-diff.ts'
import type { LLMMessage, LLMTool } from '@copse/llm/wire-types.ts'
import { runAgentLoop } from './run-agent-loop.ts'

// Golden prefix-stability test. Copse replays the whole history every turn
// (`store: false`), so OpenAI's automatic prompt cache only helps while each
// request is the previous request plus appended items. This drives the real
// agent loop and the real Responses adapter over a scripted multi-turn,
// multi-tool thread — a fresh provider per user turn, as agent-service does —
// records every request body, and fails at the first byte that changes
// anywhere before the newly appended messages.

type Body = Record<string, unknown>

const TOOLS: LLMTool[] = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
  { name: 'search_code', description: 'Search code', parameters: { type: 'object' } },
]

const SYSTEM: LLMMessage = { role: 'system', content: 'You are Copse.' }

/** Scripted endpoint: every request gets `callsPerStep` tool calls until `toolSteps` are spent. */
function scriptedClient(bodies: Body[], toolSteps: number, callsPerStep: number): unknown {
  let step = 0
  return {
    responses: {
      create: async (body: Body): Promise<AsyncIterable<unknown>> => {
        bodies.push(body)
        const calling = step++ < toolSteps
        const n = bodies.length
        return (async function* (): AsyncGenerator {
          if (calling) {
            yield {
              type: 'response.output_item.done',
              item: {
                type: 'reasoning',
                id: `rs_${String(n)}`,
                encrypted_content: `enc_${String(n)}`,
              },
            }
            for (let call = 0; call < callsPerStep; call++) {
              yield {
                type: 'response.output_item.done',
                item: {
                  type: 'function_call',
                  call_id: `call_${String(n)}_${String(call)}`,
                  name: call % 2 === 0 ? 'read_file' : 'search_code',
                  arguments: JSON.stringify({ path: `file-${String(n)}.ts`, line: call }),
                },
              }
            }
          } else {
            yield {
              type: 'response.output_text.delta',
              delta: 'Done; nothing further to add here.',
            }
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

function newProvider(bodies: Body[], toolSteps: number, callsPerStep: number): ResponsesProvider {
  const provider = new ResponsesProvider('gpt-5.6-sol', {
    apiKey: 'test',
    promptCacheKey: 'thread-1',
    encryptedReasoning: true,
    reasoningSummaries: true,
  })
  Object.defineProperty(provider, 'client', {
    value: scriptedClient(bodies, toolSteps, callsPerStep),
    configurable: true,
  })
  return provider
}

interface ThreadScript {
  turns: number
  toolSteps: number
  callsPerStep: number
  /** Tool list offered on each user turn; defaults to `TOOLS` every turn. */
  toolsForTurn?: (turn: number) => LLMTool[]
  /** System prompt on each user turn; defaults to `SYSTEM` every turn. */
  systemForTurn?: (turn: number) => LLMMessage
  /** Forget replayable reasoning between user turns, as a provider-owned map did. */
  forgetReasoningBetweenTurns?: boolean
}

/** Run the thread and return every request body it sent, in order, with the turn each belongs to. */
async function runThread(script: ThreadScript): Promise<{ body: Body; turn: number }[]> {
  const bodies: Body[] = []
  const turnOf: number[] = []
  let history: LLMMessage[] = []
  for (let turn = 0; turn < script.turns; turn++) {
    const messages: LLMMessage[] = [
      script.systemForTurn?.(turn) ?? SYSTEM,
      ...history,
      { role: 'user', content: `question ${String(turn)}` },
    ]
    const before = bodies.length
    await runAgentLoop({
      provider: newProvider(bodies, script.toolSteps, script.callsPerStep),
      messages,
      tools: script.toolsForTurn?.(turn) ?? TOOLS,
      onChunk: () => {},
      executeTool: async (name, args) => `${name} result for ${JSON.stringify(args)}`,
    })
    for (let i = before; i < bodies.length; i++) turnOf.push(turn)
    // What the host persists for the next turn: everything but the system prompt.
    history = messages.slice(1)
    if (script.forgetReasoningBetweenTurns) clearReasoningReplayForTests()
  }
  return bodies.map((body, i) => ({ body, turn: at(turnOf, i) }))
}

/** First divergence between any two consecutive requests, described; null when every prefix holds. */
function firstDivergence(requests: { body: Body; turn: number }[]): string | null {
  for (let i = 1; i < requests.length; i++) {
    const previous = at(requests, i - 1)
    const next = at(requests, i)
    const { divergence } = compareRequestPrefix(previous.body, next.body)
    if (divergence) {
      return `request ${String(i)} (turn ${String(next.turn)}): ${describeDivergence(divergence)}`
    }
  }
  return null
}

describe('request prefix stability (golden)', () => {
  beforeEach(clearReasoningReplayForTests)
  afterEach(clearReasoningReplayForTests)

  it('only appends between consecutive requests of a multi-turn, multi-tool thread', async () => {
    const requests = await runThread({ turns: 4, toolSteps: 3, callsPerStep: 2 })
    // 4 user turns × (3 tool steps + 1 answer).
    assert.equal(requests.length, 16)
    assert.equal(firstDivergence(requests), null)
    // The thread's cache key rides every request.
    for (const { body } of requests) assert.equal(body['prompt_cache_key'], 'thread-1')
  })

  it('reproduces the whole previous request as the next one’s leading input', async () => {
    const requests = await runThread({ turns: 3, toolSteps: 2, callsPerStep: 1 })
    for (let i = 1; i < requests.length; i++) {
      const { sharedInputChars, previousInputChars } = compareRequestPrefix(
        at(requests, i - 1).body,
        at(requests, i).body,
      )
      assert.equal(sharedInputChars, previousInputChars, `request ${String(i)} lost prefix`)
    }
  })

  // Negative controls: the detector must actually notice each way the prefix
  // can drift, or a green run above proves nothing.
  it('reports a tool list that reorders between turns', async () => {
    const requests = await runThread({
      turns: 2,
      toolSteps: 1,
      callsPerStep: 1,
      toolsForTurn: (turn) => (turn === 0 ? TOOLS : [...TOOLS].reverse()),
    })
    assert.match(firstDivergence(requests) ?? '', /^request 2 \(turn 1\): tools changed/)
  })

  it('reports a system prompt that changes between turns', async () => {
    const requests = await runThread({
      turns: 2,
      toolSteps: 1,
      callsPerStep: 1,
      systemForTurn: (turn) => ({
        role: 'system',
        content: `You are Copse. Turn ${String(turn)}.`,
      }),
    })
    assert.match(firstDivergence(requests) ?? '', /^request 2 \(turn 1\): input\[0\] changed/)
  })

  it('reports reasoning that is forgotten between user turns', async () => {
    const requests = await runThread({
      turns: 2,
      toolSteps: 2,
      callsPerStep: 1,
      forgetReasoningBetweenTurns: true,
    })
    // Request 3 is turn 1's first: the earlier reasoning item is gone.
    assert.match(firstDivergence(requests) ?? '', /^request 3 \(turn 1\): input\[2\] changed/)
  })
})
