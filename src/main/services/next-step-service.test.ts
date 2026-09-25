import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider } from '@shared/types'
import type { ProviderStreamChunk } from '@shared/types/stream.ts'
import type { FollowUpContext } from '@shared/follow-ups/types.ts'
import type { UsageRecordInput } from '@shared/usage/usage-event.ts'
import type { SmallTasksRoute } from './providers/small-tasks-provider.ts'
import { setSetting } from './storage/settings.ts'
import {
  NEXT_STEP_TIMEOUT_MS,
  cleanNextStep,
  mockNextStepHint,
  suggestNextStep,
  type NextStepDeps,
} from './next-step-service.ts'

describe('cleanNextStep', () => {
  it('passes a plain instruction through, dropping a trailing period', () => {
    assert.equal(
      cleanNextStep('Run the tests to verify the fix.'),
      'Run the tests to verify the fix',
    )
  })

  it('strips wrapping quotes, backticks, and list markers', () => {
    assert.equal(cleanNextStep('"Commit these changes"'), 'Commit these changes')
    assert.equal(cleanNextStep('`Run pnpm test`'), 'Run pnpm test')
    assert.equal(cleanNextStep('- Run the linter'), 'Run the linter')
    assert.equal(cleanNextStep('1. Run the linter'), 'Run the linter')
  })

  it('takes the first substantive line of chatty output', () => {
    assert.equal(
      cleanNextStep('\n\nRun the tests\nBecause the fix touched the parser.'),
      'Run the tests',
    )
  })

  it('skips code-fence lines rather than suggesting them', () => {
    assert.equal(cleanNextStep('```\nRun the tests\n```'), 'Run the tests')
  })

  it('returns null when the model declines', () => {
    assert.equal(cleanNextStep('NONE'), null)
    assert.equal(cleanNextStep('none.'), null)
    assert.equal(cleanNextStep('Nothing comes to mind'), null)
    assert.equal(cleanNextStep('No next step is obvious here'), null)
  })

  it('returns null for empty or whitespace output', () => {
    assert.equal(cleanNextStep(''), null)
    assert.equal(cleanNextStep('   \n  '), null)
    assert.equal(cleanNextStep('""'), null)
  })

  it('rejects a rambling suggestion instead of truncating it', () => {
    const long = 'Review the changes and then consider whether the '.repeat(4)
    assert.equal(cleanNextStep(long), null)
  })
})

describe('mockNextStepHint', () => {
  it('is itself a valid hint, so the e2e fixture exercises the real path', () => {
    assert.equal(cleanNextStep(mockNextStepHint()), mockNextStepHint())
  })
})

// --- suggestNextStep: the model call itself, driven through injected I/O ---

const CONTEXT: FollowUpContext = {
  userMessage: 'Fix the parser bug',
  assistantMessage: 'I fixed the off-by-one in the tokenizer.',
  toolNames: ['edit_file'],
}

/** A provider that answers `text` and reports usage (unless `usage` is null). */
function answering(
  text: string,
  usage: { inputTokens: number; outputTokens: number } | null = {
    inputTokens: 120,
    outputTokens: 8,
  },
): LLMProvider & { calls: number } {
  const provider = {
    calls: 0,
    async *stream(): AsyncGenerator<ProviderStreamChunk> {
      provider.calls++
      yield { type: 'text' as const, text }
      if (usage) yield { type: 'usage' as const, model: 'x', ...usage }
      yield { type: 'done' as const }
    },
  }
  return provider
}

/** A provider that reports usage, then never finishes until aborted. */
function stalling(): LLMProvider {
  return {
    async *stream(_messages, _tools, signal): AsyncGenerator<ProviderStreamChunk> {
      yield { type: 'usage' as const, model: 'x', inputTokens: 90, outputTokens: 0 }
      await new Promise<never>((_resolve, reject) => {
        const fail = (): void => {
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (signal?.aborted) fail()
        else signal?.addEventListener('abort', fail, { once: true })
      })
    },
  }
}

function harness(route: SmallTasksRoute | null): {
  deps: NextStepDeps
  recorded: UsageRecordInput[]
  resolves: () => number
} {
  const recorded: UsageRecordInput[] = []
  let resolves = 0
  return {
    recorded,
    resolves: () => resolves,
    deps: {
      resolveRoute: (): Promise<SmallTasksRoute | null> => {
        resolves++
        return Promise.resolve(route)
      },
      recordUsage: (input) => recorded.push(input),
    },
  }
}

describe('suggestNextStep', () => {
  beforeEach(async () => {
    await setSetting('nextStepSuggestionEnabled', true)
  })
  afterEach(async () => {
    await setSetting('nextStepSuggestionEnabled', false)
  })

  it('makes no model call while the feature is switched off', async () => {
    await setSetting('nextStepSuggestionEnabled', false)
    const provider = answering('Run the tests')
    const h = harness({ provider, model: 'lmstudio:small' })
    assert.equal(await suggestNextStep(CONTEXT, h.deps), null)
    assert.equal(h.resolves(), 0)
    assert.equal(provider.calls, 0)
    assert.deepEqual(h.recorded, [])
  })

  it('returns null without recording anything when no provider resolves', async () => {
    const h = harness(null)
    assert.equal(await suggestNextStep(CONTEXT, h.deps), null)
    assert.equal(h.resolves(), 1)
    assert.deepEqual(h.recorded, [])
  })

  it('returns the cleaned hint and records usage under the small-tasks model', async () => {
    const h = harness({ provider: answering('Run the tests.'), model: 'lmstudio:small' })
    assert.equal(await suggestNextStep(CONTEXT, h.deps), 'Run the tests')
    assert.deepEqual(h.recorded, [
      { model: 'lmstudio:small', source: 'small-tasks', inputTokens: 120, outputTokens: 8 },
    ])
  })

  it('attributes usage to the chat model when the route fell back to it', async () => {
    const h = harness({ provider: answering('Commit these changes'), model: 'claude-sonnet-4-6' })
    assert.equal(await suggestNextStep(CONTEXT, h.deps), 'Commit these changes')
    assert.equal(h.recorded.length, 1)
    assert.equal(h.recorded[0]?.model, 'claude-sonnet-4-6')
  })

  it('records nothing when the provider reports no usage', async () => {
    const h = harness({ provider: answering('NONE', null), model: 'lmstudio:small' })
    assert.equal(await suggestNextStep(CONTEXT, h.deps), null)
    assert.deepEqual(h.recorded, [])
  })

  it('gives up at the timeout and still records the tokens the provider reported', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness({ provider: stalling(), model: 'lmstudio:small' })
    const pending = suggestNextStep(CONTEXT, h.deps)
    // Let the stream start and report usage before the deadline passes.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    t.mock.timers.tick(NEXT_STEP_TIMEOUT_MS)
    assert.equal(await pending, null)
    assert.deepEqual(h.recorded, [
      { model: 'lmstudio:small', source: 'small-tasks', inputTokens: 90, outputTokens: 0 },
    ])
  })
})
