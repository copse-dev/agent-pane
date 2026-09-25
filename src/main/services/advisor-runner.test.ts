import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage, LLMProvider, StreamChunk } from '@shared/types'
import type { ProviderStreamChunk } from '@shared/types/stream.ts'
import type { BuildProviderOptions } from './providers/provider-selection.ts'
import {
  ADVISOR_PROVIDER_OPTIONS,
  createAdvisorRunner,
  resolveAdvisorModelForGating,
  type AdvisorRunnerDeps,
} from './advisor-runner.ts'
import type { AdvisorRunnerContext } from './advisor-runner-context.ts'
import {
  DEFAULT_ADVISOR_MAX_TOKENS,
  MAX_ADVISOR_TRANSCRIPT_CHARS,
  advisorAddsLift,
} from './advisor-strategy.ts'

interface Recorded {
  builds: { model: string; opts: BuildProviderOptions }[]
  prompts: string[]
  signals: (AbortSignal | undefined)[]
  chunks: StreamChunk[]
}

/** A provider that answers with fixed advice and a usage chunk. */
function answeringProvider(recorded: Recorded, text = 'Use a context.'): LLMProvider {
  return {
    async *stream(messages, _tools, signal): AsyncGenerator<ProviderStreamChunk> {
      const first = messages[0]
      recorded.prompts.push(
        first?.role === 'user' && typeof first.content === 'string' ? first.content : '',
      )
      recorded.signals.push(signal)
      yield { type: 'text' as const, text }
      yield { type: 'usage' as const, model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 20 }
      yield { type: 'done' as const }
    },
  }
}

/** A provider that never answers until its signal aborts, then rejects like a transport. */
function hangingProvider(recorded: Recorded): LLMProvider {
  return {
    async *stream(_messages, _tools, signal): AsyncGenerator<ProviderStreamChunk> {
      recorded.signals.push(signal)
      await new Promise<never>((_resolve, reject) => {
        const fail = (): void => {
          reject(new DOMException('aborted', 'AbortError'))
        }
        if (signal?.aborted) fail()
        else signal?.addEventListener('abort', fail, { once: true })
      })
      yield { type: 'done' as const }
    },
  }
}

function deps(
  recorded: Recorded,
  provider: LLMProvider,
  resolved = 'claude-opus-4-8',
): AdvisorRunnerDeps {
  return {
    resolveModel: () => Promise.resolve(resolved),
    buildRepoState: () => Promise.resolve('## Repo state\n\nbranch: main\n\n'),
    buildWorkingDiff: () => Promise.resolve('## Working diff\n\n'),
    buildProvider: (model, opts): Promise<LLMProvider> => {
      recorded.builds.push({ model, opts })
      return Promise.resolve(provider)
    },
    runAcpPrompt: () => Promise.reject(new Error('ACP not expected in this test')),
  }
}

function context(recorded: Recorded, transcript: LLMMessage[]): AdvisorRunnerContext {
  return {
    advisorModel: 'auto:best-intellect',
    executorModel: 'lmstudio:qwen/qwen3-4b-2507',
    getTranscript: () => transcript,
    onChunk: (chunk) => recorded.chunks.push(chunk),
  }
}

function fresh(): Recorded {
  return { builds: [], prompts: [], signals: [], chunks: [] }
}

describe('advisor runner', () => {
  it('builds the advisor provider with the advisor output cap', async () => {
    const recorded = fresh()
    const run = createAdvisorRunner(
      context(recorded, [{ role: 'user', content: 'Add graceful shutdown.' }]),
      deps(recorded, answeringProvider(recorded)),
    )
    const advice = await run(new AbortController().signal)
    assert.equal(recorded.builds.length, 1)
    const [build] = recorded.builds
    assert.ok(build)
    assert.equal(build.model, 'claude-opus-4-8')
    assert.equal(build.opts.maxOutputTokens, DEFAULT_ADVISOR_MAX_TOKENS)
    assert.deepEqual(ADVISOR_PROVIDER_OPTIONS, { maxOutputTokens: DEFAULT_ADVISOR_MAX_TOKENS })
    assert.match(advice, /Use a context\./)
    assert.match(advice, /^\*\*Advisor — /)
  })

  it('emits the advisor usage line on the resolved model', async () => {
    const recorded = fresh()
    const run = createAdvisorRunner(
      context(recorded, [{ role: 'user', content: 'Task' }]),
      deps(recorded, answeringProvider(recorded)),
    )
    await run(new AbortController().signal)
    const usage = recorded.chunks.find((chunk) => chunk.type === 'usage')
    assert.ok(usage?.type === 'usage')
    assert.equal(usage.model, 'claude-opus-4-8')
    assert.equal(usage.usageSource, 'advisor')
    assert.equal(usage.inputTokens, 100)
  })

  it('cancels the consult when the executor aborts, instead of waiting for the timeout', async () => {
    const recorded = fresh()
    const run = createAdvisorRunner(
      context(recorded, [{ role: 'user', content: 'Task' }]),
      deps(recorded, hangingProvider(recorded)),
    )
    const controller = new AbortController()
    const started = Date.now()
    const pending = run(controller.signal)
    // Let the runner reach the provider stream before stopping.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort(new Error('user stopped'))
    await assert.rejects(pending)
    assert.ok(Date.now() - started < 5_000, 'abort should settle promptly')
    const forwarded = recorded.signals[0]
    assert.ok(forwarded, 'the provider receives a signal')
    assert.equal(forwarded.aborted, true)
  })

  it('forwards a capped transcript that keeps the most recent context', async () => {
    const recorded = fresh()
    const transcript: LLMMessage[] = [{ role: 'user', content: 'The original task.' }]
    for (let i = 0; i < 400; i++) {
      transcript.push({
        role: 'tool',
        toolResults: [
          { toolCallId: `t${String(i)}`, result: `step-${String(i)} ${'x'.repeat(1_000)}` },
        ],
      })
    }
    const run = createAdvisorRunner(
      context(recorded, transcript),
      deps(recorded, answeringProvider(recorded)),
    )
    await run(new AbortController().signal, { question: 'Is SIGTERM enough?' })
    const prompt = recorded.prompts[0] ?? ''
    assert.ok(prompt.length < MAX_ADVISOR_TRANSCRIPT_CHARS + 5_000, 'prompt is bounded')
    assert.ok(prompt.includes('[Transcript truncated'))
    assert.ok(prompt.includes('step-399 '))
    assert.ok(!prompt.includes('step-0 '))
    assert.ok(prompt.includes('The original task.'))
    // The executor's question is still the last thing the advisor reads.
    assert.ok(prompt.trimEnd().endsWith('Is SIGTERM enough?'))
  })

  it('routes an acp: advisor through the ACP prompt with a cancellable signal', async () => {
    const recorded = fresh()
    const acpCalls: { agentId: string; signal: AbortSignal }[] = []
    const run = createAdvisorRunner(context(recorded, [{ role: 'user', content: 'Task' }]), {
      ...deps(recorded, answeringProvider(recorded), 'acp:claude-code'),
      runAcpPrompt: (options) => {
        acpCalls.push({ agentId: options.agentId, signal: options.signal })
        return Promise.resolve({ text: 'ACP advice', usage: { inputTokens: 0, outputTokens: 0 } })
      },
    })
    const controller = new AbortController()
    const advice = await run(controller.signal)
    assert.match(advice, /ACP advice/)
    assert.equal(recorded.builds.length, 0)
    const [call] = acpCalls
    assert.ok(call)
    assert.equal(call.agentId, 'claude-code')
    controller.abort()
    assert.equal(call.signal.aborted, true)
  })
})

describe('resolveAdvisorModelForGating', () => {
  it('expands a dynamic selector so a same-model pairing hides the tool', async () => {
    const executor = 'claude-opus-4-8'
    // The raw selector carries no annotation, so on its own it reads as "keep offering".
    assert.equal(advisorAddsLift(executor, 'auto:best-intellect'), true)
    const resolved = await resolveAdvisorModelForGating('auto:best-intellect', () =>
      Promise.resolve(executor),
    )
    assert.equal(resolved, executor)
    assert.equal(advisorAddsLift(executor, resolved), false)
  })

  it('passes a pinned id through the resolver', async () => {
    const resolved = await resolveAdvisorModelForGating('claude-opus-4-8', (value) =>
      Promise.resolve(value),
    )
    assert.equal(resolved, 'claude-opus-4-8')
  })

  it('falls back to the unexpanded selection when expansion fails (keeps the tool)', async () => {
    const resolved = await resolveAdvisorModelForGating('auto:best-intellect', () =>
      Promise.reject(new Error('catalog unavailable')),
    )
    assert.equal(resolved, 'auto:best-intellect')
    assert.equal(advisorAddsLift('claude-opus-4-8', resolved), true)
  })
})
