import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { LLMMessage, LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { AgentStreamChunk } from './wire-types.ts'
import { runAgentLoop } from './run-agent-loop.ts'
import { AgentRunDeadline } from './agent-loop-limits.ts'
import { isRecord } from '@copse/std/unknown-value.ts'

describe('unfinished productive runs at the desktop budget', () => {
  it('pauses at the unchanged default boundary and continues without repeating checkpointed writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-budget-checkpoint-'))
    const checkpoint = join(root, 'checkpoint.txt')
    writeFileSync(checkpoint, '')
    const writes = new Map<number, number>()
    const messages: LLMMessage[] = [
      { role: 'user', content: 'Complete all sixty migration phases.' },
    ]
    const executeTool = async (name: string, args: unknown): Promise<string> => {
      assert.equal(name, 'write_file')
      assert.ok(isRecord(args))
      const step = args['step']
      assert.ok(typeof step === 'number')
      writes.set(step, (writes.get(step) ?? 0) + 1)
      writeFileSync(join(root, `phase-${String(step)}.txt`), 'completed\n')
      appendFileSync(checkpoint, `${String(step)}\n`)
      return `Phase ${String(step)} is complete.`
    }
    let calls = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        calls += 1
        // Two healthy extensions reach fifty steps. Bounded finalization then
        // produces no answer; the remaining ten phases are still unfinished.
        if (calls <= 50) {
          yield {
            type: 'tool_call',
            toolCall: { id: `phase-${String(calls)}`, name: 'write_file', args: { step: calls } },
          }
        }
        yield { type: 'done' }
      },
    }
    const chunks: AgentStreamChunk[] = []
    try {
      await runAgentLoop({
        provider,
        messages,
        tools: [],
        // This is the desktop host's supported override. Leave steps and
        // extension policy at their actual product defaults.
        maxLlmCalls: 40,
        onChunk: (chunk) => chunks.push(chunk),
        executeTool,
      })
      assert.equal(calls, 51)
      assert.equal(writes.size, 50)
      assert.deepEqual(chunks.at(-1), { type: 'done', stopReason: 'max_steps' })
      assert.ok(chunks.some((chunk) => chunk.type === 'text' && chunk.text.includes('step limit')))

      messages.push({
        role: 'user',
        content: 'Continue from the saved checkpoint. Do not repeat completed migration phases.',
      })
      let nextPhase = 50
      const continuation: LLMProvider = {
        async *stream(): AsyncGenerator<ProviderStreamChunk> {
          if (nextPhase < 60) {
            nextPhase += 1
            yield {
              type: 'tool_call',
              toolCall: {
                id: `phase-${String(nextPhase)}`,
                name: 'write_file',
                args: { step: nextPhase },
              },
            }
          } else yield { type: 'text', text: 'All sixty migration phases are complete.' }
          yield { type: 'done' }
        },
      }
      const continued: AgentStreamChunk[] = []
      await runAgentLoop({
        provider: continuation,
        messages,
        tools: [],
        maxLlmCalls: 40,
        onChunk: (chunk) => continued.push(chunk),
        executeTool,
      })
      assert.deepEqual(continued.at(-1), { type: 'done' })
      assert.equal(writes.size, 60)
      assert.ok([...writes.values()].every((count) => count === 1))
      assert.equal(
        readFileSync(checkpoint, 'utf8'),
        Array.from({ length: 60 }, (_, index) => `${String(index + 1)}\n`).join(''),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a successful final answer completed when its deadline expires at the step boundary', async () => {
    let now = 0
    const deadline = new AgentRunDeadline(60_000, 100, now, () => now)
    let calls = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        calls += 1
        if (calls === 1)
          yield { type: 'tool_call', toolCall: { id: 'check', name: 'check', args: {} } }
        else {
          now = 100
          yield { type: 'text', text: 'The check passed; the request is complete.' }
        }
        yield { type: 'done' }
      },
    }
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'Run the check.' }],
      tools: [],
      maxSteps: 1,
      maxLlmCalls: 3,
      adaptiveExtensions: false,
      runDeadline: deadline,
      executeTool: async () => 'passed',
      onChunk: (chunk) => chunks.push(chunk),
    })
    assert.equal(calls, 2)
    assert.deepEqual(chunks.at(-1), { type: 'done' })
  })

  it('does not turn a user Stop during finalization into a budget failure', async () => {
    const controller = new AbortController()
    let calls = 0
    const provider: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        calls += 1
        if (calls === 1)
          yield { type: 'tool_call', toolCall: { id: 'check', name: 'check', args: {} } }
        else controller.abort('user-stop')
        yield { type: 'done' }
      },
    }
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider,
      messages: [{ role: 'user', content: 'Run the check.' }],
      tools: [],
      maxSteps: 1,
      maxLlmCalls: 3,
      adaptiveExtensions: false,
      signal: controller.signal,
      executeTool: async () => 'passed',
      onChunk: (chunk) => chunks.push(chunk),
    })
    assert.equal(calls, 2)
    assert.deepEqual(chunks.at(-1), { type: 'done' })
    assert.ok(
      !chunks.some(
        (chunk) => chunk.type === 'text' && chunk.text.includes('limit before finishing'),
      ),
    )
  })

  it('keeps an unfinished plan paused after bounded closeout has spent its allowance', async () => {
    const chunks: AgentStreamChunk[] = []
    await runAgentLoop({
      provider: {
        async *stream(): AsyncGenerator<ProviderStreamChunk> {
          yield { type: 'done' }
        },
      },
      messages: [{ role: 'user', content: 'Complete the migration.' }],
      tools: [],
      maxSteps: 1,
      maxLlmCalls: 2,
      adaptiveExtensions: false,
      getOpenTodos: () => [{ id: 'migration', content: 'Finish migration', status: 'pending' }],
      continuationBudget: { tryGrant: () => false, remaining: () => 0 },
      executeTool: async () => 'unused',
      onChunk: (chunk) => chunks.push(chunk),
    })
    assert.deepEqual(chunks.at(-1), { type: 'done', stopReason: 'max_steps' })
    assert.ok(
      chunks.some(
        (chunk) => chunk.type === 'text' && chunk.text.includes('task plan still has open'),
      ),
    )
  })
})
