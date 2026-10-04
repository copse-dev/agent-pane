import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@copse/std/array-utils.ts'
import type {
  LLMMessage,
  LLMProvider,
  LLMStreamOptions,
  ProviderStreamChunk,
} from '@copse/llm/wire-types.ts'
import { runAgentLoop, type AppliedNudgeRecord } from './run-agent-loop.ts'
import type { ReasoningCheckpointPolicy } from './reasoning-circle-detector.ts'
import type { StreamCutRecord } from './stream-cut-record.ts'
import {
  REASONING_BUDGET_CARRY_FORWARD_HOOK_ID,
  buildReasoningBudgetCarryForwardNudge,
  defaultReasoningSoftBudget,
  excerptReasoningForCarryForward,
  validateReasoningSoftBudget,
} from './reasoning-budget.ts'

describe('reasoning soft budget helpers', () => {
  it('keeps the head and tail of long reasoning within the carry budget', () => {
    const reasoning = `START ${'x '.repeat(2_000)} CONCLUSION: write the file`
    const excerpt = excerptReasoningForCarryForward(reasoning, 300)
    assert.ok(excerpt.length <= 300)
    assert.ok(excerpt.startsWith('START'))
    assert.ok(excerpt.endsWith('CONCLUSION: write the file'))
    assert.ok(excerpt.includes('[...]'))
  })

  it('honours carry limits smaller than the truncation marker', () => {
    const reasoning = 'opening reasoning and latest conclusion'
    for (let carryChars = 1; carryChars <= 8; carryChars++) {
      validateReasoningSoftBudget({ ...defaultReasoningSoftBudget(), carryChars })
      const excerpt = excerptReasoningForCarryForward(reasoning, carryChars)
      assert.ok(excerpt.length <= carryChars)
      assert.ok(excerpt.endsWith(reasoning.slice(-1)))
    }
  })

  it('returns short reasoning whole with whitespace collapsed', () => {
    assert.equal(excerptReasoningForCarryForward('a\n\n  b', 300), 'a b')
  })

  it('escalates the nudge on a consecutive cut', () => {
    const first = buildReasoningBudgetCarryForwardNudge('plan', { carryChars: 100, cutNumber: 1 })
    const second = buildReasoningBudgetCarryForwardNudge('plan', { carryChars: 100, cutNumber: 2 })
    assert.match(first, /plan/)
    assert.doesNotMatch(first, /begin with a tool call/)
    assert.match(second, /begin with a tool call/)
  })

  it('rejects non-positive limits', () => {
    assert.throws(() => {
      validateReasoningSoftBudget({ ...defaultReasoningSoftBudget(), tokens: 0 })
    })
    assert.doesNotThrow(() => {
      validateReasoningSoftBudget(defaultReasoningSoftBudget())
    })
  })
})

function policy(overrides: Partial<ReasoningCheckpointPolicy> = {}): ReasoningCheckpointPolicy {
  return {
    intervalTokens: 100,
    maxNonReasoningTokens: 100,
    maxInitialTokens: 200,
    maxRecoveryTokens: 200,
    softReasoningBudget: {
      tokens: 20,
      carryChars: 400,
      maxCutsPerRun: 3,
      maxConsecutiveCuts: 2,
    },
    ...overrides,
  }
}

const tools = [{ name: 'run_shell', description: 'run', parameters: { type: 'object' } }]

interface RunResult {
  nudges: AppliedNudgeRecord[]
  cuts: StreamCutRecord[]
  histories: LLMMessage[][]
  calls: () => number
  streamOptions: (LLMStreamOptions | undefined)[]
  stopReasons: (string | undefined)[]
}

async function run(
  streams: (call: number) => ProviderStreamChunk[],
  reasoningCheckpointPolicy: ReasoningCheckpointPolicy,
): Promise<RunResult> {
  const nudges: AppliedNudgeRecord[] = []
  const cuts: StreamCutRecord[] = []
  const histories: LLMMessage[][] = []
  let calls = 0
  const streamOptions: (LLMStreamOptions | undefined)[] = []
  const stopReasons: (string | undefined)[] = []
  const provider: LLMProvider = {
    async *stream(messages, _tools, _signal, options): AsyncGenerator<ProviderStreamChunk> {
      calls++
      streamOptions.push(options)
      histories.push([...messages])
      for (const chunk of streams(calls)) yield chunk
    },
  }
  await runAgentLoop({
    provider,
    messages: [{ role: 'user', content: 'go' }],
    tools,
    maxSteps: 10,
    maxStreamOutputTokens: 100,
    reasoningRunawayTextToleranceChars: 0,
    reasoningCheckpointPolicy,
    onChunk: (chunk) => {
      if (chunk.type === 'done') stopReasons.push(chunk.stopReason)
    },
    executeTool: async () => 'ok',
    recordAppliedNudge: (record) => {
      nudges.push(record)
    },
    recordStreamCut: (record) => {
      cuts.push(record)
    },
  })
  return { nudges, cuts, histories, streamOptions, stopReasons, calls: () => calls }
}

const longReasoning = (): ProviderStreamChunk[] => [
  { type: 'reasoning', text: 'Plan: write /app/out.txt with the header. '.repeat(3) },
  { type: 'reasoning', text: 'Then compute the rest. '.repeat(4) },
  { type: 'reasoning', text: 'never reached '.repeat(50) },
]

const toolCallStream = (id: string): ProviderStreamChunk[] => [
  { type: 'tool_call', toolCall: { id, name: 'run_shell', args: {} } },
  { type: 'done' },
]

const answerStream = (): ProviderStreamChunk[] => [
  { type: 'text', text: 'Done.' },
  { type: 'done' },
]

describe('reasoning soft budget in the agent loop', () => {
  it('disarms soft carry through the suppression ladder and terminates after the third runaway cut', async () => {
    const result = await run(() => longReasoning(), policy())
    assert.deepEqual(
      result.cuts.map((cut) => cut.cutReason),
      [
        'reasoning_budget_soft',
        'reasoning_budget_soft',
        'reasoning_circle_detected',
        'reasoning_circle_detected',
        'reasoning_circle_detected',
      ],
    )
    assert.equal(result.calls(), 5)
    assert.deepEqual(
      result.streamOptions.map((options) => options?.suppressReasoning),
      [undefined, undefined, undefined, undefined, true],
    )
    assert.deepEqual(result.stopReasons, ['reasoning_runaway_exhausted'])
    assert.equal(
      result.nudges.filter((n) => n.hookId === REASONING_BUDGET_CARRY_FORWARD_HOOK_ID).length,
      2,
    )
  })

  it('breaks the consecutive soft-cut streak on malformed recovery but retains the per-run bound', async () => {
    const result = await run(
      (call) => {
        if (call === 2)
          return [
            {
              type: 'done',
              stopReason: 'tool_call_malformed',
              malformedToolCall: {
                message: 'Failed to parse tool call: Unexpected end of content.',
                hitOutputCeiling: true,
              },
            },
          ]
        if (call === 4) return toolCallStream('progress')
        if (call >= 6) return answerStream()
        return longReasoning()
      },
      policy({
        softReasoningBudget: {
          tokens: 20,
          carryChars: 400,
          maxCutsPerRun: 2,
          maxConsecutiveCuts: 1,
        },
      }),
    )
    const softCuts = result.cuts.filter((cut) => cut.cutReason === 'reasoning_budget_soft')
    assert.deepEqual(
      softCuts.map((cut) => cut.step),
      [1, 3],
    )
    const carries = result.nudges.filter(
      (nudge) => nudge.hookId === REASONING_BUDGET_CARRY_FORWARD_HOOK_ID,
    )
    assert.equal(carries.length, 2)
    for (const carry of carries) assert.doesNotMatch(carry.text, /begin with a tool call/)
    assert.ok(
      result.cuts.some((cut) => cut.step === 5 && cut.cutReason !== 'reasoning_budget_soft'),
    )
  })
  it('cuts early, carries the reasoning into history and continues with tools', async () => {
    const result = await run((call) => {
      if (call === 1) return longReasoning()
      if (call === 2) return toolCallStream('t1')
      return answerStream()
    }, policy())
    assert.equal(result.calls(), 3)
    assert.equal(result.cuts.length, 1)
    const cut = at(result.cuts, 0)
    assert.equal(cut.cutReason, 'reasoning_budget_soft')
    assert.equal(cut.willInjectReasoningRunawayNudge, false)
    // Cut well before the stream's total volume or any hard cap.
    assert.ok(cut.streamReasoningChars < 300)
    assert.deepEqual(
      result.nudges.map((n) => n.hookId),
      [REASONING_BUDGET_CARRY_FORWARD_HOOK_ID],
    )
    const secondCallHistory = at(result.histories, 1)
    const carried = at(secondCallHistory, secondCallHistory.length - 1)
    assert.equal(carried.role, 'user')
    const text = typeof carried.content === 'string' ? carried.content : ''
    assert.match(text, /write \/app\/out\.txt with the header/)
    assert.match(text, /calling a tool/)
  })

  it('stays out of the way of streams under the budget', async () => {
    const result = await run((call) => {
      if (call === 1) {
        return [{ type: 'reasoning', text: 'short plan' }, ...toolCallStream('t1')]
      }
      return answerStream()
    }, policy())
    assert.equal(result.cuts.length, 0)
    assert.equal(result.nudges.length, 0)
  })

  it('is inert without a soft budget', async () => {
    const { softReasoningBudget: _omitted, ...withoutBudget } = policy()
    const result = await run((call) => {
      if (call === 1) return longReasoning().slice(0, 2)
      return answerStream()
    }, withoutBudget)
    assert.equal(result.cuts.length, 0)
    assert.equal(
      result.nudges.some((n) => n.hookId === REASONING_BUDGET_CARRY_FORWARD_HOOK_ID),
      false,
    )
  })

  it('bounds consecutive soft cuts and then defers to the hard caps', async () => {
    const result = await run((call) => (call <= 4 ? longReasoning() : answerStream()), policy())
    const softCuts = result.cuts.filter((cut) => cut.cutReason === 'reasoning_budget_soft')
    assert.equal(softCuts.length, 2)
    const carried = result.nudges.filter((n) => n.hookId === REASONING_BUDGET_CARRY_FORWARD_HOOK_ID)
    assert.equal(carried.length, 2)
    assert.doesNotMatch(at(carried, 0).text, /begin with a tool call/)
    assert.match(at(carried, 1).text, /begin with a tool call/)
    // The third tool-less stream is not soft-cut: the hard-cap path owns it.
    assert.ok(result.cuts.length >= 3)
    assert.notEqual(at(result.cuts, 2).cutReason, 'reasoning_budget_soft')
  })

  it('stops soft cutting after the per-run limit', async () => {
    const result = await run(
      (call) => {
        if (call >= 9) return answerStream()
        return call % 2 === 1 ? longReasoning() : toolCallStream(`t${String(call)}`)
      },
      policy({
        softReasoningBudget: {
          tokens: 20,
          carryChars: 400,
          maxCutsPerRun: 2,
          maxConsecutiveCuts: 2,
        },
      }),
    )
    const softCuts = result.cuts.filter((cut) => cut.cutReason === 'reasoning_budget_soft')
    assert.equal(softCuts.length, 2)
  })

  it('does not cut a stream that already produced an answer', async () => {
    const result = await run(
      () => [
        { type: 'text', text: 'The answer is 42.' },
        { type: 'reasoning', text: 'thinking '.repeat(40) },
        { type: 'done' },
      ],
      policy(),
    )
    assert.equal(
      result.cuts.some((cut) => cut.cutReason === 'reasoning_budget_soft'),
      false,
    )
  })
})
