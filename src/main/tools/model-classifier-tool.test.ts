import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { CLOUD_MODELS } from '@copse/llm/model-catalog.ts'
import { BAND_REPRESENTATIVE_MODEL, modelIntellect } from '@copse/llm/model-intellect.ts'
import { computeParetoFrontier } from '@copse/llm/pareto-frontier.ts'
import type { ProviderStreamChunk } from '@shared/types/stream.ts'
import { runWithExplicitSettings } from '../services/storage/settings-context.ts'
import { suggestRoleForTask } from '../services/providers/model-classifier.ts'
import {
  recommendFromPool,
  recommendTaskModel,
  type TaskModelRecommendation,
} from '../services/providers/prompt-model-routing.ts'
import type { SmallTasksRoute } from '../services/providers/small-tasks-provider.ts'
import { formatModelRecommendation } from './model-classifier-tool.ts'

// A closed port: no LM Studio models join the pool, and nothing waits on a
// server that is not there.
const NO_LOCAL_SERVER = 'http://127.0.0.1:9/v1'
const LOCAL_URL_ENV = ['COPSE_EVAL_LM_STUDIO_URL', 'LM_STUDIO_BASE_URL'] as const

async function* routes(...items: SmallTasksRoute[]): AsyncIterable<SmallTasksRoute> {
  yield* items
}

function answering(answer: string): SmallTasksRoute {
  return {
    model: 'assessor',
    provider: {
      async *stream(): AsyncIterable<ProviderStreamChunk> {
        yield { type: 'text', text: answer }
        yield { type: 'done' }
      },
    },
  }
}

function providerOf(model: string): string | undefined {
  return CLOUD_MODELS.find(([id]) => id === model)?.[2]
}

/** The real configured pool for a profile holding only these provider keys. */
async function recommendWithKeys(
  apiKeys: Record<string, string>,
  task: string,
  assessor: AsyncIterable<SmallTasksRoute> = routes(),
): Promise<TaskModelRecommendation> {
  return runWithExplicitSettings({ values: { localServerUrl: NO_LOCAL_SERVER }, apiKeys }, () =>
    recommendTaskModel(task, assessor, new AbortController().signal, 0),
  )
}

const role = suggestRoleForTask('Fix the typo in README')

describe('suggest_model shares Match task routing', () => {
  const savedEnv = new Map<string, string | undefined>()
  beforeEach(() => {
    for (const name of LOCAL_URL_ENV) {
      savedEnv.set(name, process.env[name])
      Reflect.deleteProperty(process.env, name)
    }
  })
  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, name)
      else process.env[name] = value
    }
  })

  it('never recommends a model from a provider the user has not configured', async () => {
    for (const task of ['Fix the typo in README', 'Debug the race in the transaction layer']) {
      const rec = await recommendWithKeys({ openai: 'test-key' }, task)
      assert.ok(rec.pick, `expected a recommendation for ${task}`)
      assert.equal(providerOf(rec.pick.model), 'openai', rec.pick.model)
    }
    const anthropicOnly = await recommendWithKeys(
      { anthropic: 'test-key' },
      'Fix the typo in README',
    )
    assert.ok(anthropicOnly.pick)
    assert.equal(providerOf(anthropicOnly.pick.model), 'anthropic', anthropicOnly.pick.model)
  })

  it('names no model when nothing is configured', async () => {
    const rec = await recommendWithKeys({}, 'Fix the typo in README')
    assert.equal(rec.pick, null)
    assert.equal(rec.poolSize, 0)
    const text = formatModelRecommendation(rec, role, 0)
    assert.match(text, /Recommended model: none\. No model is configured/)
    assert.doesNotMatch(text, /claude-|gpt-/)
  })

  it('uses the model assessment rather than keyword rules', async () => {
    // "Rename" reads as low demand to the keyword heuristic; the assessor wins.
    const rec = await recommendWithKeys(
      { openai: 'test-key' },
      'Rename the variable',
      routes(answering('top')),
    )
    assert.equal(rec.demand, 'top')
    assert.ok(rec.pick)
    const floor = modelIntellect(BAND_REPRESENTATIVE_MODEL.top)
    assert.ok(floor !== null)
    assert.equal(rec.pick.meetsDemand, rec.pick.point.intellect >= floor)
  })

  it('stops after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      runWithExplicitSettings(
        { values: { localServerUrl: NO_LOCAL_SERVER }, apiKeys: { openai: 'test-key' } },
        () => recommendTaskModel('Fix the typo', routes(), controller.signal, 0),
      ),
      { name: 'AbortError' },
    )
  })
})

describe('recommendFromPool', () => {
  const low = modelIntellect(BAND_REPRESENTATIVE_MODEL.low)
  const top = modelIntellect(BAND_REPRESENTATIVE_MODEL.top)
  assert.ok(low !== null && top !== null)

  it('ranks like Match task and reports an included or local price', async () => {
    const pool = computeParetoFrontier([
      { id: 'local', intellect: low, costPerMTok: 0, local: true },
      { id: 'paid', intellect: top, costPerMTok: 9 },
      { id: 'acp:claude#frontier', intellect: top, costPerMTok: 0, plan: 'Claude Max' },
    ])
    const lowRec = await recommendFromPool('low', pool, 0)
    assert.equal(lowRec.pick?.model, 'lmstudio:local')
    assert.match(formatModelRecommendation(lowRec, role, 0), /Price: runs on this device/)
    const topRec = await recommendFromPool('top', pool, 0)
    assert.equal(topRec.pick?.model, 'acp:claude#frontier')
    assert.match(formatModelRecommendation(topRec, role, 0), /Price: included in Claude Max/)
  })

  it('labels the strongest configured model when none meets the demand', async () => {
    const pool = computeParetoFrontier([{ id: 'small', intellect: low, costPerMTok: 1 }])
    const rec = await recommendFromPool('top', pool, 0)
    assert.ok(rec.pick)
    assert.equal(rec.pick.model, 'small')
    assert.equal(rec.pick.meetsDemand, false)
    const text = formatModelRecommendation(rec, role, 0)
    assert.match(text, /Recommended model: small \(strongest configured model; below the top/)
    assert.match(text, /Price: ~\$1\.00\/MTok/)
  })

  it('skips routes too small for the estimated context and names none when nothing fits', async () => {
    const pool = computeParetoFrontier([
      { id: 'narrow', intellect: low, costPerMTok: 0, local: true },
      { id: 'wide', intellect: low + 1, costPerMTok: 2 },
    ])
    const windowFor = async (model: string): Promise<number> =>
      model === 'lmstudio:narrow' ? 8192 : 200_000
    assert.equal((await recommendFromPool('low', pool, 50_000, windowFor)).pick?.model, 'wide')
    const none = await recommendFromPool('low', pool, 500_000, windowFor)
    assert.equal(none.pick, null)
    assert.match(
      formatModelRecommendation(none, role, 500_000),
      /none\. No configured model has a context window of at least 500,000 tokens/,
    )
  })
})
