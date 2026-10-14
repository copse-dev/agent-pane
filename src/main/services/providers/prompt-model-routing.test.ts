import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { CLASSIFIER_PRESETS } from '@copse/llm/classifiers/presets.ts'
import { deleteSetting, setSetting } from '../storage/settings.ts'
import {
  saveClassifierProfile,
  setBackgroundClassifier,
} from '../classifiers/classifier-service.ts'
import { BAND_REPRESENTATIVE_MODEL, modelIntellect } from '@copse/llm/model-intellect.ts'
import { computeParetoFrontier } from '@copse/llm/pareto-frontier.ts'
import type { SmallTasksRoute } from './small-tasks-provider.ts'
import type { ProviderStreamChunk } from '@shared/types/stream.ts'
import {
  assessPromptDemand,
  assessPromptDemandWithFallback,
  pickPromptModel,
  pickPromptModelWithinContext,
  promptRoutingContext,
} from './prompt-model-routing.ts'

async function* routes(...items: SmallTasksRoute[]): AsyncIterable<SmallTasksRoute> {
  yield* items
}

function assessmentRoute(model: string, answer: string | Error): SmallTasksRoute {
  return {
    model,
    provider: {
      async *stream(): AsyncIterable<ProviderStreamChunk> {
        if (answer instanceof Error) throw answer
        yield { type: 'text', text: answer }
        yield { type: 'done' }
      },
    },
  }
}

describe('primary prompt model routing', () => {
  beforeEach(() => {
    setSetting('classifierProviders', { version: 1, profiles: [] })
    deleteSetting('backgroundClassifier')
  })
  afterEach(() => {
    mock.restoreAll()
  })

  async function enableClassifier(): Promise<void> {
    const profile = CLASSIFIER_PRESETS.find((entry) => entry.id === 'kev')
    assert.ok(profile)
    await saveClassifierProfile(profile)
    await setBackgroundClassifier('kev')
  }

  it('uses classifier probabilities before resolving any model route', async () => {
    await enableClassifier()
    mock.method(globalThis, 'fetch', async () =>
      Response.json({
        model: 'kev-fixture',
        answers: {
          answer: {
            type: 'choice',
            choice: 'top',
            probabilities: { low: 0.9, mid: 0.08, top: 0.02 },
          },
        },
      }),
    )
    let modelResolved = false
    const candidates: AsyncIterable<SmallTasksRoute> = {
      async *[Symbol.asyncIterator]() {
        modelResolved = true
        yield assessmentRoute('unused', 'top')
      },
    }
    assert.equal(
      await assessPromptDemandWithFallback(
        'Check for typos',
        candidates,
        new AbortController().signal,
      ),
      'low',
    )
    assert.equal(modelResolved, false)
  })

  it('falls back to the small model after classifier failure or malformed probabilities', async () => {
    await enableClassifier()
    for (const fail of [true, false]) {
      mock.method(globalThis, 'fetch', async () => {
        if (fail) throw new Error('offline')
        return Response.json({
          model: 'kev-fixture',
          answers: { answer: { type: 'choice', choice: 'low', probabilities: { low: 1 } } },
        })
      })
      assert.equal(
        await assessPromptDemandWithFallback(
          'Task',
          routes(assessmentRoute('local', 'mid')),
          new AbortController().signal,
        ),
        'mid',
      )
      mock.restoreAll()
    }
  })

  it('cancels classifier inference without starting model fallback', async () => {
    await enableClassifier()
    const controller = new AbortController()
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.signal)
      controller.abort()
      assert.equal(init.signal.aborted, true)
      throw new DOMException('Aborted', 'AbortError')
    })
    await assert.rejects(
      assessPromptDemandWithFallback(
        'Task',
        routes(assessmentRoute('unused', 'low')),
        controller.signal,
      ),
      { name: 'AbortError' },
    )
  })

  it('prefers sufficient local and smaller plan models over included Astra', () => {
    const low = modelIntellect(BAND_REPRESENTATIVE_MODEL.low)
    assert.ok(low !== null)
    const local = { id: 'local-fit', intellect: low, costPerMTok: 0, local: true }
    const plan = { id: 'acp:plan#small', intellect: low + 1, costPerMTok: 0, plan: 'included' }
    const astra = {
      id: 'acp:codex-acp#gpt-6-astra',
      intellect: low + 30,
      costPerMTok: 0,
      plan: 'ChatGPT',
    }
    assert.equal(
      pickPromptModel('low', computeParetoFrontier([astra, plan, local]), 'fallback'),
      'lmstudio:local-fit',
    )
    assert.equal(pickPromptModel('low', computeParetoFrontier([astra, plan]), 'fallback'), plan.id)
  })

  it('tries the backup after a stopped local server or malformed assessment', async () => {
    for (const answer of [new Error('Local server unavailable'), 'unparseable answer']) {
      assert.equal(
        await assessPromptDemandWithFallback(
          'Check for typos in the README',
          routes(assessmentRoute('local', answer), assessmentRoute('backup', 'low')),
          new AbortController().signal,
        ),
        'low',
      )
    }
  })

  it('does not ask the backup after a successful assessment', async () => {
    let backupAsked = false
    const candidates: AsyncIterable<SmallTasksRoute> = {
      async *[Symbol.asyncIterator]() {
        yield assessmentRoute('local', 'low')
        backupAsked = true
        yield assessmentRoute('backup', 'top')
      },
    }
    assert.equal(
      await assessPromptDemandWithFallback(
        'Check for typos',
        candidates,
        new AbortController().signal,
      ),
      'low',
    )
    assert.equal(backupAsked, false)
  })

  it('keeps a typo check on a smaller included model when no assessor is usable', async () => {
    const low = modelIntellect(BAND_REPRESENTATIVE_MODEL.low)
    const high = modelIntellect(BAND_REPRESENTATIVE_MODEL.top)
    assert.ok(low !== null && high !== null)
    const included = computeParetoFrontier([
      { id: 'acp:codex-acp#small', intellect: low, costPerMTok: 0, plan: 'ChatGPT' },
      { id: 'acp:codex-acp#large', intellect: high, costPerMTok: 0, plan: 'ChatGPT' },
    ])
    const prompt = promptRoutingContext('Check for typos in the README', [])
    for (const candidates of [routes(), routes(assessmentRoute('offline', new Error('offline')))]) {
      const demand = await assessPromptDemandWithFallback(
        prompt,
        candidates,
        new AbortController().signal,
      )
      assert.equal(demand, 'low')
      assert.equal(pickPromptModel(demand, included, 'fallback'), 'acp:codex-acp#small')
    }
  })

  it('retains high demand for difficult work when assessment is unavailable', async () => {
    const demand = await assessPromptDemandWithFallback(
      promptRoutingContext('Debug a race condition in the transaction isolation layer', []),
      routes(),
      new AbortController().signal,
    )
    assert.equal(demand, 'top')
  })

  it('does not fall back or ask another model after cancellation', async () => {
    const controller = new AbortController()
    const candidates: AsyncIterable<SmallTasksRoute> = {
      async *[Symbol.asyncIterator]() {
        yield {
          model: 'cancelled',
          provider: {
            async *stream(): AsyncIterable<ProviderStreamChunk> {
              controller.abort()
              yield { type: 'text', text: 'low' }
            },
          },
        }
        assert.fail('backup must not run after cancellation')
      },
    }
    await assert.rejects(assessPromptDemandWithFallback('task', candidates, controller.signal), {
      name: 'AbortError',
    })
  })
  it('asks a model about the task rather than applying keyword rules', async () => {
    let received = ''
    const demand = await assessPromptDemand(
      'Rename the whole architecture',
      {
        model: 'fixture',
        provider: {
          async *stream(messages) {
            const message = messages[0]
            if (message?.role === 'user' && typeof message.content === 'string')
              received = message.content
            yield { type: 'text', text: 'top' }
            yield { type: 'done' }
          },
        },
      },
      new AbortController().signal,
    )
    assert.equal(demand, 'top')
    assert.match(received, /Rename the whole architecture/)
    assert.match(received, /short follow-up/)
  })

  it('returns no assessment for malformed replies or provider failures', async () => {
    for (const answer of ['I cannot assess this', '']) {
      const demand = await assessPromptDemand(
        'task',
        {
          model: 'fixture',
          provider: {
            async *stream() {
              if (!answer) throw new Error('offline')
              yield { type: 'text', text: answer }
            },
          },
        },
        new AbortController().signal,
      )
      assert.equal(demand, null)
    }
  })

  it('does not call the assessment provider after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const demand = await assessPromptDemand(
      'task',
      {
        model: 'fixture',
        provider: {
          async *stream() {
            called = true
            yield { type: 'text', text: 'top' }
          },
        },
      },
      controller.signal,
    )
    assert.equal(demand, null)
    assert.equal(called, false)
  })
  const medium = modelIntellect(BAND_REPRESENTATIVE_MODEL.mid)
  const high = modelIntellect(BAND_REPRESENTATIVE_MODEL.top)
  assert.ok(medium !== null && high !== null)
  const pool = computeParetoFrontier([
    { id: 'small', intellect: 1, costPerMTok: 0, local: true },
    { id: 'capable', intellect: medium, costPerMTok: 2 },
    { id: 'frontier', intellect: high, costPerMTok: 8 },
  ])

  it('uses a capable route instead of the cheapest underpowered local model', () => {
    assert.equal(pickPromptModel('mid', pool, 'fallback'), 'capable')
    assert.equal(pickPromptModel('top', pool, 'fallback'), 'frontier')
  })

  it('skips a loaded local model whose context is too small before starting it', async () => {
    const low = modelIntellect(BAND_REPRESENTATIVE_MODEL.low)
    assert.ok(low !== null)
    const candidates = computeParetoFrontier([
      { id: 'local-small-window', intellect: low, costPerMTok: 0, local: true },
      { id: 'cloud-large-window', intellect: low + 1, costPerMTok: 1 },
    ])
    const checked: string[] = []
    const chosen = await pickPromptModelWithinContext(
      'low',
      candidates,
      'fallback',
      12_000,
      async (model) => {
        checked.push(model)
        return model === 'lmstudio:local-small-window' ? 8192 : 128_000
      },
    )
    assert.equal(chosen, 'cloud-large-window')
    assert.deepEqual(checked, ['lmstudio:local-small-window', 'cloud-large-window'])
  })

  it('keeps a fitting local model and rejects a task that fits no route', async () => {
    const local = computeParetoFrontier([
      { id: 'local', intellect: 50, costPerMTok: 0, local: true },
    ])
    const windowForModel = async (): Promise<number> => 8192
    assert.equal(
      await pickPromptModelWithinContext('low', local, 'fallback', 4096, windowForModel),
      'lmstudio:local',
    )
    await assert.rejects(
      pickPromptModelWithinContext('low', local, 'fallback', 12_000, windowForModel),
      /could not find a model with enough context/,
    )
  })

  it('uses included capacity when it meets the requirement', () => {
    const included = computeParetoFrontier([
      ...pool,
      { id: 'acp:claude#frontier', intellect: high, costPerMTok: 0, plan: 'Claude' },
    ])
    assert.equal(pickPromptModel('mid', included, 'fallback'), 'acp:claude#frontier')
  })

  it('uses the strongest available model when none meets the demand', () => {
    const result = pickPromptModel(
      'top',
      pool.filter((point) => point.id !== 'frontier'),
      'fallback',
    )
    assert.equal(result, 'capable')
  })

  it('uses the fallback when the scored pool is empty', () => {
    assert.equal(pickPromptModel('low', [], 'fallback'), 'fallback')
    assert.equal(pickPromptModel('top', [], 'fallback'), 'fallback')
  })

  it('preserves conversational context for a short follow-up without forwarding tool or system text', () => {
    const context = promptRoutingContext('Yes, do that', [
      { role: 'system', content: 'private system instructions' },
      { role: 'user', content: 'Redesign the transaction isolation layer' },
      { role: 'tool', toolResults: [{ toolCallId: 'x', result: 'private tool output' }] },
      { role: 'assistant', content: 'I propose replacing the locking strategy.' },
    ])
    assert.match(context, /transaction isolation/)
    assert.match(context, /locking strategy/)
    assert.match(context, /Current request:\nYes, do that/)
    assert.doesNotMatch(context, /private/)
  })

  it('bounds the assessment input', () => {
    const context = promptRoutingContext(
      'x'.repeat(100_000),
      Array.from({ length: 100 }, () => ({
        role: 'user' as const,
        content: 'y'.repeat(10_000),
      })),
    )
    assert.ok(context.length < 25_000)
  })
})
