import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMMessage, LLMProvider, StreamChunk } from '@shared/types'
import type { ProviderStreamChunk } from '@shared/types/stream.ts'
import type { BuildProviderOptions } from './providers/provider-selection.ts'
import {
  ADVISOR_PROVIDER_OPTIONS,
  createAdvisorRunner,
  resolveAdvisorModelForGating,
  type AdvisorRunner,
  type AdvisorRunnerDeps,
} from './advisor-runner.ts'
import type { AdvisorRunnerContext } from './advisor-runner-context.ts'
import { RequestError } from '@agentclientprotocol/sdk'
import { ToolCircuitBreaker } from './tool-circuit-breaker.ts'
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

/**
 * A provider that ends its stream cleanly on abort with the partial text it had,
 * like the native LM Studio client answering a cancel with `userStopped`.
 */
function cleanStopProvider(recorded: Recorded): LLMProvider {
  return {
    async *stream(_messages, _tools, signal): AsyncGenerator<ProviderStreamChunk> {
      recorded.signals.push(signal)
      yield { type: 'text' as const, text: 'Partial adv' }
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else
          signal?.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
      })
      yield { type: 'usage' as const, model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 5 }
      yield { type: 'done' as const }
    },
  }
}

/** A provider that finishes its answer, but Stop lands before the stream closes. */
function stoppedAtCompletionProvider(controller: AbortController): LLMProvider {
  return {
    async *stream(): AsyncGenerator<ProviderStreamChunk> {
      yield { type: 'text' as const, text: 'Complete advice.' }
      yield { type: 'usage' as const, model: 'claude-opus-4-8', inputTokens: 100, outputTokens: 20 }
      controller.abort(new Error('user stopped'))
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
    breaker: new ToolCircuitBreaker(),
    currentThreadId: () => null,
    isLocalServer: (model) => model.startsWith('lmstudio:'),
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

  it('rejects when Stop ends the stream cleanly, instead of returning partial advice', async () => {
    const recorded = fresh()
    const run = createAdvisorRunner(
      context(recorded, [{ role: 'user', content: 'Task' }]),
      deps(recorded, cleanStopProvider(recorded)),
    )
    const controller = new AbortController()
    const pending = run(controller.signal)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort(new Error('user stopped'))
    await assert.rejects(pending, /user stopped/)
    assert.equal(
      recorded.chunks.some((chunk) => chunk.type === 'usage'),
      false,
      'a stopped consult reports no advisor usage line, like a transport that rejects',
    )
  })

  it('rejects when Stop races the completion of a cloud consult', async () => {
    const recorded = fresh()
    const controller = new AbortController()
    const run = createAdvisorRunner(
      context(recorded, [{ role: 'user', content: 'Task' }]),
      deps(recorded, stoppedAtCompletionProvider(controller)),
    )
    await assert.rejects(run(controller.signal), /user stopped/)
    assert.equal(recorded.chunks.length, 0)
  })

  it('rejects when Stop lands after an ACP consult has returned', async () => {
    const recorded = fresh()
    const controller = new AbortController()
    const run = createAdvisorRunner(context(recorded, [{ role: 'user', content: 'Task' }]), {
      ...deps(recorded, answeringProvider(recorded), 'acp:claude-code'),
      runAcpPrompt: () => {
        // ACP answers a cancel with a normal `cancelled` turn carrying the partial text.
        controller.abort(new Error('user stopped'))
        return Promise.resolve({
          text: 'Partial ACP advice',
          usage: { inputTokens: 10, outputTokens: 2 },
        })
      },
    })
    await assert.rejects(run(controller.signal), /user stopped/)
    assert.equal(recorded.chunks.length, 0)
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

describe('advisor circuit breaker', () => {
  /** An ACP advisor whose agent's login has expired: every consult is refused. */
  function signedOutAcp(
    recorded: Recorded,
    breaker: ToolCircuitBreaker,
    threadId = 't1',
  ): { run: AdvisorRunner; consults: () => number } {
    let consults = 0
    const run = createAdvisorRunner(context(recorded, [{ role: 'user', content: 'Task' }]), {
      ...deps(recorded, answeringProvider(recorded), 'acp:codex'),
      breaker,
      currentThreadId: () => threadId,
      runAcpPrompt: () => {
        consults++
        return Promise.reject(new RequestError(-32000, 'Authentication required'))
      },
    })
    return { run, consults: () => consults }
  }

  it('consults an always-unauthenticated advisor once per thread, then fails fast', async () => {
    const recorded = fresh()
    const breaker = new ToolCircuitBreaker()
    const { run, consults } = signedOutAcp(recorded, breaker)
    const errors: string[] = []
    for (let i = 0; i < 5; i++) {
      await run(new AbortController().signal).then(
        () => assert.fail('a signed-out advisor must not return advice'),
        (err: unknown) => errors.push(err instanceof Error ? err.message : String(err)),
      )
    }
    assert.equal(consults(), 1)
    assert.equal(errors.length, 5)
    for (const message of errors) {
      // Actionable for the user, and an explicit stop for the executor.
      assert.match(message, /The advisor is unavailable for now/)
      assert.match(message, /`acp:codex` needs you to sign in/)
      assert.match(message, /Advisor role in Settings → Models/)
      assert.match(message, /Do not call the advisor tool again/)
    }
    assert.equal(recorded.chunks.length, 0, 'a failed consult reports no advisor usage')
  })

  it('scopes the trip to the thread and re-arms when the advisor selection changes', async () => {
    const breaker = new ToolCircuitBreaker()
    const first = signedOutAcp(fresh(), breaker, 't1')
    await assert.rejects(first.run(new AbortController().signal))
    await assert.rejects(first.run(new AbortController().signal))
    assert.equal(first.consults(), 1)
    // Another thread pays its own single probe.
    const other = signedOutAcp(fresh(), breaker, 't2')
    await assert.rejects(other.run(new AbortController().signal))
    assert.equal(other.consults(), 1)
    // The user picks a different advisor model: the trip no longer applies.
    assert.equal(breaker.get('t1', 'advisor', 'claude-opus-4-8'), null)
  })

  it('does not trip on a transient failure', async () => {
    const recorded = fresh()
    const breaker = new ToolCircuitBreaker()
    let consults = 0
    const run = createAdvisorRunner(context(recorded, [{ role: 'user', content: 'Task' }]), {
      ...deps(recorded, answeringProvider(recorded), 'acp:codex'),
      breaker,
      currentThreadId: () => 't1',
      runAcpPrompt: () => {
        consults++
        return Promise.reject(new Error('API Error: 529 Overloaded'))
      },
    })
    await assert.rejects(run(new AbortController().signal), /Overloaded/)
    await assert.rejects(run(new AbortController().signal), /Overloaded/)
    assert.equal(consults, 2)
    assert.equal(breaker.get('t1', 'advisor', 'auto:best-intellect'), null)
  })

  it('names LM Studio when a local advisor server is not running', async () => {
    const recorded = fresh()
    const breaker = new ToolCircuitBreaker()
    // What the OpenAI SDK's APIConnectionError reports when nothing listens.
    const refusing: LLMProvider = {
      async *stream(): AsyncGenerator<ProviderStreamChunk> {
        await Promise.reject(new Error('Connection error.'))
        yield { type: 'done' as const }
      },
    }
    const run = createAdvisorRunner(context(recorded, [{ role: 'user', content: 'Task' }]), {
      ...deps(recorded, refusing, 'lmstudio:qwen/qwen3.6-35b-a3b'),
      breaker,
      currentThreadId: () => 't1',
    })
    await assert.rejects(run(new AbortController().signal), /is LM Studio running/)
    await assert.rejects(run(new AbortController().signal), /is LM Studio running/)
    assert.equal(recorded.builds.length, 1, 'the second call never reached the provider')
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

  it('does not hold the turn when discovery misses the deadline (keeps the tool)', async () => {
    // A cold discovery cache: expansion would eventually name the executor itself.
    let finishDiscovery: (id: string) => void = () => {}
    const slowDiscovery = new Promise<string>((done) => {
      finishDiscovery = done
    })
    const resolved = await resolveAdvisorModelForGating(
      'auto:best-intellect',
      () => slowDiscovery,
      5,
    )
    assert.equal(resolved, 'auto:best-intellect')
    assert.equal(advisorAddsLift('claude-opus-4-8', resolved), true)
    finishDiscovery('claude-opus-4-8')
  })
})
