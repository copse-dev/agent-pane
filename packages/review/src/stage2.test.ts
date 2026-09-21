import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessEventSchema } from '@copse/agent/headless-contract.ts'
import type { LLMMessage, LLMProvider } from '@copse/llm/wire-types.ts'
import { materialiseCheckouts, type MaterialisedCheckouts } from './checkouts.ts'
import { buildReviewContext, type ReviewContext } from './context.ts'
import { CORRECTNESS_LENS, lensSystemPrompt } from './lenses.ts'
import { ScriptedProvider, type ScriptedStep } from './scripted-provider.ts'
import { runStage2 } from './stage2.ts'
import { createTestRepo, type TestRepo } from './test-repo.ts'

function textOf(message: LLMMessage): string {
  return 'content' in message && typeof message.content === 'string' ? message.content : ''
}

describe('runStage2', () => {
  let repo: TestRepo
  let scratch = ''
  let checkouts: MaterialisedCheckouts
  let context: ReviewContext

  before(async () => {
    repo = await createTestRepo({
      'src/math.ts': 'export const add = (a: number, b: number): number => a + b\n',
    })
    repo.git('checkout', '-q', '-b', 'feature')
    await repo.write({
      'src/math.ts': 'export const add = (a: number, b: number): number => a - b\n',
    })
    repo.commit('break add')
    scratch = await mkdtemp(join(tmpdir(), 'review-stage2-'))
    checkouts = await materialiseCheckouts({
      repoRoot: repo.root,
      baseRef: 'main',
      scratchDir: scratch,
      includeWorkingTree: false,
    })
    context = await buildReviewContext({ checkouts })
  })

  after(async () => {
    await checkouts.cleanup()
    await rm(scratch, { recursive: true, force: true })
    await repo.remove()
  })

  const finding = {
    path: 'src/math.ts',
    startLine: 1,
    class: 'contract',
    severity: 'high',
    confidence: 'high',
    claim: 'add subtracts its second argument instead of adding it.',
    reason: 'The body is a - b; every caller expecting a sum gets the difference.',
  }

  it('drives the scripted reviewer through its tools and collects candidates and events', async () => {
    const script: ScriptedStep[] = [
      { type: 'tool_call', name: 'read_file', args: { path: 'src/math.ts' }, text: 'Reading.' },
      { type: 'tool_call', name: 'report_finding', args: finding },
      { type: 'text', text: 'Checked src/math.ts. Could not run the tests.' },
    ]
    const provider = new ScriptedProvider(script)
    const events: string[] = []
    const result = await runStage2({
      provider,
      model: 'scripted',
      lens: CORRECTNESS_LENS,
      context,
      headCheckout: checkouts.head,
      cell: null,
      shellDecision: 'deny',
      scrub: (text) => text,
      threadId: 'thread-1',
      turnId: 'turn-1',
      onEvent: (event) => events.push(event.type),
    })
    assert.equal(result.outcome, 'completed')
    assert.equal(result.stopReason, 'end_turn')
    const [reported] = result.candidates
    assert.ok(reported)
    assert.equal(result.candidates.length, 1)
    assert.equal(reported.candidate.claim, finding.claim)
    assert.equal(
      reported.anchoredText,
      'export const add = (a: number, b: number): number => a - b',
    )
    assert.equal(result.summary, 'Checked src/math.ts. Could not run the tests.')
    assert.equal(result.toolCalls, 2)
    assert.equal(result.usage.estimated, false)
    assert.deepEqual(events, [
      'turn_start',
      'message',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'message',
      'turn_end',
    ])
    for (const event of result.events) headlessEventSchema.parse(event)
    // The reviewer saw the lens brief and the rendered context, in that order.
    const first = provider.calls[0]
    assert.ok(first)
    const [system, user] = first
    assert.ok(system && user)
    assert.equal(system.role, 'system')
    assert.match(textOf(system), /Lens: Bugs and regressions/)
    assert.match(textOf(user), /Diff:\n```diff/)
  })

  it('says in the system prompt whether commands can run', () => {
    assert.match(lensSystemPrompt(CORRECTNESS_LENS, { canRun: true }), /You may run commands/)
    assert.match(lensSystemPrompt(CORRECTNESS_LENS, { canRun: false }), /not available in this run/)
  })

  it('reports a provider failure as a failed turn, never as findings', async () => {
    const broken: LLMProvider = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('provider exploded')),
        }),
      }),
    }
    const result = await runStage2({
      provider: broken,
      model: 'broken',
      lens: CORRECTNESS_LENS,
      context,
      headCheckout: checkouts.head,
      cell: null,
      shellDecision: 'deny',
      scrub: (text) => text,
      threadId: 'thread-2',
      turnId: 'turn-2',
    })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.stopReason, 'error')
    assert.match(result.error ?? '', /provider exploded/)
    assert.deepEqual(result.candidates, [])
    assert.equal(result.events.at(-1)?.type, 'turn_end')
  })
})
