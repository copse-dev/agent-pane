import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { headlessEventSchema } from '@copse/agent/headless-contract.ts'
import type { LLMMessage, LLMProvider } from '@copse/llm/wire-types.ts'
import { materialiseCheckouts, type MaterialisedCheckouts } from './checkouts.ts'
import { buildReviewContext, type ReviewContext } from './context.ts'
import {
  CONTRACTS_LENS,
  CORRECTNESS_LENS,
  LENSES,
  lensSystemPrompt,
  resolveLenses,
} from './lenses.ts'
import { ScriptedProvider, type ScriptedStep } from './scripted-provider.ts'
import { runReviewers, runStage2 } from './stage2.ts'
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
      {
        type: 'tool_call',
        name: 'finish_review',
        args: {
          checked: 'src/math.ts and the changed implementation.',
          couldNotVerify: 'Tests, because run_command was unavailable.',
        },
      },
      { type: 'text', text: 'Done.' },
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
    assert.equal(
      result.summary,
      'Checked: src/math.ts and the changed implementation.\nCould not verify: Tests, because run_command was unavailable.',
    )
    assert.equal(result.toolCalls, 3)
    assert.equal(result.usage.estimated, false)
    assert.deepEqual(events, [
      'turn_start',
      'message',
      'tool_call',
      'tool_result',
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
    assert.match(lensSystemPrompt(CORRECTNESS_LENS, { canRun: false }), /finish_review/)
  })

  it('fails closed when the model ends without the completion attestation', async () => {
    const result = await runStage2({
      provider: new ScriptedProvider([
        { type: 'text', text: 'I inspected the diff and found nothing.' },
      ]),
      model: 'scripted',
      lens: CORRECTNESS_LENS,
      context,
      headCheckout: checkouts.head,
      cell: null,
      shellDecision: 'deny',
      scrub: (text) => text,
      threadId: 'thread-incomplete',
      turnId: 'turn-incomplete',
    })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.stopReason, 'error')
    assert.match(result.error ?? '', /without calling the required finish_review tool/)
    assert.equal(result.summary, 'I inspected the diff and found nothing.')
    const end = result.events.at(-1)
    assert.equal(end?.type, 'turn_end')
    assert.equal(end.outcome, 'failed')
  })

  it('repairs a prose draft into one structured closure without losing its finding', async () => {
    const provider = new ScriptedProvider([
      {
        type: 'text',
        text: 'I found one defect: add subtracts at src/math.ts line 1. I checked the implementation but could not run tests.',
      },
      {
        type: 'tool_call',
        name: 'finish_review',
        args: {
          checked: 'src/math.ts and the changed implementation.',
          couldNotVerify: 'Tests, because run_command was unavailable.',
          findings: [finding],
        },
      },
      { type: 'text', text: 'Done.' },
    ])
    const result = await runStage2({
      provider,
      model: 'scripted',
      lens: CORRECTNESS_LENS,
      context,
      headCheckout: checkouts.head,
      cell: null,
      shellDecision: 'deny',
      scrub: (text) => text,
      threadId: 'thread-repaired',
      turnId: 'turn-repaired',
    })
    assert.equal(result.outcome, 'completed')
    assert.equal(result.error, undefined)
    assert.equal(result.toolCalls, 1)
    assert.equal(result.candidates.length, 1)
    assert.equal(result.candidates[0]?.candidate.claim, finding.claim)
    assert.equal(
      result.summary,
      'Checked: src/math.ts and the changed implementation.\nCould not verify: Tests, because run_command was unavailable.',
    )
    assert.equal(result.events.filter((event) => event.type === 'turn_start').length, 1)
    assert.equal(result.events.filter((event) => event.type === 'turn_end').length, 1)
    const repairCall = provider.calls[1]
    assert.ok(repairCall)
    const repairPrompt = repairCall.at(-1)
    assert.ok(repairPrompt && repairPrompt.role === 'user')
    assert.match(textOf(repairPrompt), /Call finish_review exactly once now/)
    assert.match(textOf(repairPrompt), /already 0 structured finding/)
    assert.equal(provider.streamOptions[0], undefined)
    assert.deepEqual(provider.streamOptions[1], { toolChoice: { name: 'finish_review' } })
    // The exact choice is one-shot: after the tool result, the provider may
    // emit its ordinary terminal response without being forced to call again.
    assert.equal(provider.streamOptions[2], undefined)
  })

  it('feeds a rejected closure reason back so the repair can correct its arguments', async () => {
    const provider = new ScriptedProvider([
      { type: 'text', text: 'I checked the changed implementation and found no defect.' },
      {
        type: 'tool_call',
        name: 'finish_review',
        args: { checked: 'short', couldNotVerify: 'Nothing', findings: [] },
      },
      {
        type: 'tool_call',
        name: 'finish_review',
        args: {
          checked: 'src/math.ts and the changed implementation.',
          couldNotVerify: 'Nothing',
          findings: [],
        },
      },
      { type: 'text', text: 'Done.' },
    ])
    const result = await runStage2({
      provider,
      model: 'scripted',
      lens: CORRECTNESS_LENS,
      context,
      headCheckout: checkouts.head,
      cell: null,
      shellDecision: 'deny',
      scrub: (text) => text,
      threadId: 'thread-repair-invalid',
      turnId: 'turn-repair-invalid',
    })
    assert.equal(result.outcome, 'completed')
    assert.equal(result.error, undefined)
    assert.equal(result.toolCalls, 2)
    assert.equal(result.candidates.length, 0)
    assert.equal(
      result.summary,
      'Checked: src/math.ts and the changed implementation.\nCould not verify: Nothing',
    )
    assert.deepEqual(provider.streamOptions[1], { toolChoice: { name: 'finish_review' } })
    assert.equal(provider.streamOptions[2], undefined)
    const rejectedResult = result.events.find(
      (event) => event.type === 'tool_result' && event.toolCallId === 'call-2',
    )
    assert.ok(rejectedResult?.type === 'tool_result')
    assert.match(rejectedResult.result, /checked:.*8/)
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

  it('fans out every model over every lens and keeps each result in place', async () => {
    const results = await runReviewers({
      context,
      headCheckout: checkouts.head,
      cell: null,
      shellDecision: 'deny',
      scrub: (text) => text,
      reviewers: [
        {
          model: 'm1',
          providerFor: (): ScriptedProvider =>
            new ScriptedProvider([
              {
                type: 'tool_call',
                name: 'finish_review',
                args: { checked: 'm1 reviewed the changed code.', couldNotVerify: 'Nothing' },
              },
              { type: 'text', text: 'Done.' },
            ]),
        },
        {
          model: 'm2',
          providerFor: (lens): ScriptedProvider =>
            new ScriptedProvider([
              {
                type: 'tool_call',
                name: 'finish_review',
                args: {
                  checked: `m2 reviewed the ${lens.id} boundary.`,
                  couldNotVerify: 'Nothing',
                },
              },
              { type: 'text', text: 'Done.' },
            ]),
        },
      ],
      lenses: [CORRECTNESS_LENS, CONTRACTS_LENS],
      threadId: 'thread',
      turnPrefix: 'turn',
      concurrency: 3,
    })
    assert.deepEqual(
      results.map((result) => [result.model, result.lens, result.summary, result.turnId]),
      [
        [
          'm1',
          'correctness',
          'Checked: m1 reviewed the changed code.\nCould not verify: Nothing',
          'turn:m1:correctness',
        ],
        [
          'm1',
          'contracts',
          'Checked: m1 reviewed the changed code.\nCould not verify: Nothing',
          'turn:m1:contracts',
        ],
        [
          'm2',
          'correctness',
          'Checked: m2 reviewed the correctness boundary.\nCould not verify: Nothing',
          'turn:m2:correctness',
        ],
        [
          'm2',
          'contracts',
          'Checked: m2 reviewed the contracts boundary.\nCould not verify: Nothing',
          'turn:m2:contracts',
        ],
      ],
    )
  })

  it('resolves lens specs and rejects unknown ids', () => {
    assert.deepEqual(
      resolveLenses(undefined).map((lens) => lens.id),
      ['correctness'],
    )
    assert.deepEqual(
      resolveLenses('all').map((lens) => lens.id),
      LENSES.map((lens) => lens.id),
    )
    assert.deepEqual(
      resolveLenses(' tests, security ,tests').map((lens) => lens.id),
      ['tests', 'security'],
    )
    assert.throws(() => resolveLenses('vibes'), /unknown lens vibes/)
  })
})
