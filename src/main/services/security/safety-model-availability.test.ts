import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { setSetting, setApiKey } from '../storage/settings.ts'
import { findSafetyModelProblem } from './safety-model-availability.ts'
import { classifyShellScope } from './safety-classifier.ts'
import {
  invalidateLmStudioModelsCache,
  normalizeRoleModelSelection,
} from '../providers/provider-selection.ts'
import { DEFAULT_SAFETY_MODEL, SAFETY_MODEL_MIN_INTELLECT } from '@shared/lm-studio-defaults.ts'
import { isDynamicModel, minIntellectSelector } from '@copse/llm/dynamic-model.ts'
import { pickDynamicModel } from '@copse/llm/dynamic-model-pick.ts'
import type { FrontierPoint } from '@copse/llm/pareto-frontier.ts'
import {
  reportSafetyModelProblem,
  resetSafetyModelProblemReportsForTest,
} from './safety-model-availability.ts'
import { runWithActiveRunIdentity } from '../thread-models.ts'
import { readDecisionLog } from './decision-log-store.ts'
import { drainWriteQueue } from '../storage/write-queue.ts'
import { storageSet } from '../storage/storage.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INSTALLED = 'google/gemma-4-e4b'
const MISSING = 'qwen/qwen3-4b-2507'

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
  return address.port
}

let server: Server
let completionCalls = 0
let modelsReachable = true

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/v1/models') || url.endsWith('/api/v1/models')) {
      if (!modelsReachable) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'down' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: INSTALLED }] }))
      return
    }
    if (url.endsWith('/v1/chat/completions')) {
      completionCalls += 1
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Model not found.' }))
      return
    }
    res.writeHead(404).end('{}')
  })
  const port = await listenOnLoopback(server)
  delete process.env['COPSE_EVAL_LM_STUDIO_URL']
  delete process.env['LM_STUDIO_BASE_URL']
  await setSetting('localServerUrl', `http://127.0.0.1:${String(port)}/v1`)
  setApiKey('lmstudio', 'test-token')
})

after(() => {
  server.close()
})

beforeEach(() => {
  completionCalls = 0
  modelsReachable = true
  invalidateLmStudioModelsCache()
})

describe('findSafetyModelProblem', () => {
  it('flags a local model the server does not list', async () => {
    const problem = await findSafetyModelProblem(`lmstudio:${MISSING}`)
    assert.equal(problem?.reason, 'not-available')
  })

  it('passes a local model the server does list', async () => {
    assert.equal(await findSafetyModelProblem(`lmstudio:${INSTALLED}`), null)
  })

  it('separates an unreachable server from a missing model', async () => {
    modelsReachable = false
    invalidateLmStudioModelsCache()
    const problem = await findSafetyModelProblem(`lmstudio:${MISSING}`)
    assert.equal(problem?.reason, 'server-unreachable')
  })

  it('does not pre-judge a cloud model', async () => {
    // Cloud selections have no cheap catalogue probe: a key or quota fault only
    // shows at request time, so claiming it is unavailable here would be a lie.
    assert.equal(await findSafetyModelProblem('claude-opus-5'), null)
    assert.equal(await findSafetyModelProblem('openrouter:qwen/qwen3.8-max'), null)
  })

  it('does not pre-judge a bare lmstudio selection', async () => {
    // `lmstudio:` alone means "whatever is loaded"; there is no id to check.
    assert.equal(await findSafetyModelProblem('lmstudio:'), null)
  })
})

describe('classifyShellScope with an unavailable safety model', () => {
  it('returns null without spending a request', async () => {
    await setSetting('safetyClassifierEnabled', true)
    await setSetting('safetyModel', `lmstudio:${MISSING}`)
    assert.equal(await classifyShellScope('ls -la'), null)
    assert.equal(completionCalls, 0)
    await setSetting('safetyClassifierEnabled', false)
  })
})

/**
 * An unavailable classifier is worth one audit line: it explains a run of
 * approval prompts that otherwise looks like a flaky model. It is a
 * configuration fault rather than a per-call event, so it is recorded once per
 * thread instead of once per command.
 */
describe('reportSafetyModelProblem', () => {
  const PROJECT = 'proj-safety-availability'
  let store = ''
  let previousStore: string | undefined

  beforeEach(() => {
    previousStore = process.env['COPSE_WORKSPACE_DIR']
    store = mkdtempSync(join(tmpdir(), 'copse-safety-availability-'))
    process.env['COPSE_WORKSPACE_DIR'] = store
    storageSet('activeProjectId', PROJECT)
    resetSafetyModelProblemReportsForTest()
  })

  afterEach(async () => {
    // Recording is fire-and-forget; drain before the throwaway store is unset
    // so a late append cannot land in the next test's directory.
    await drainWriteQueue()
    if (previousStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousStore
    rmSync(store, { recursive: true, force: true })
  })

  it('records the fault as a system "ask", not a classification or a user denial', async () => {
    runWithActiveRunIdentity('t-availability', () => {
      reportSafetyModelProblem({
        model: `lmstudio:${MISSING}`,
        reason: 'not-available',
        message: 'missing',
      })
    })
    const events = await readDecisionLog(PROJECT)
    assert.equal(events.length, 1)
    const event = events[0]
    assert.ok(event)
    assert.equal(event.actor, 'system')
    assert.equal(event.verdict, 'ask')
    assert.equal(event.kind, 'classification')
    assert.equal(event.source, 'safety-classifier')
    assert.deepEqual(event.reasons, [`not-available: lmstudio:${MISSING}`])
  })

  it('records once per thread rather than once per call', async () => {
    const problem = {
      model: `lmstudio:${MISSING}`,
      reason: 'not-available' as const,
      message: 'missing',
    }
    runWithActiveRunIdentity('t-availability', () => {
      reportSafetyModelProblem(problem)
      reportSafetyModelProblem(problem)
      reportSafetyModelProblem(problem)
    })
    runWithActiveRunIdentity('t-other', () => {
      reportSafetyModelProblem(problem)
    })
    const events = await readDecisionLog(PROJECT)
    assert.equal(events.length, 2)
    assert.deepEqual(events.map((e) => e.threadId).sort(), ['t-availability', 't-other'])
  })
})

/**
 * The safety role stores a *rule* by default (`DEFAULT_SAFETY_MODEL`), because
 * a fixed local id is wrong for everyone without a local server and fails
 * silently there. The rule is only worth anything if it survives the read path
 * intact — it used to be mangled into `lmstudio:auto:best-local`, an id that
 * cannot exist.
 */
describe('auto: rules on role settings', () => {
  it('the safety default is a rule, not a pinned local id', () => {
    assert.equal(DEFAULT_SAFETY_MODEL, minIntellectSelector(SAFETY_MODEL_MIN_INTELLECT))
    assert.ok(isDynamicModel(DEFAULT_SAFETY_MODEL))
  })

  it('survives the legacy bare-id upgrade instead of being prefixed', () => {
    for (const rule of ['auto:best-local', 'auto:cheapest', 'auto:min-intellect:30']) {
      assert.equal(normalizeRoleModelSelection(rule), rule)
    }
    // The legacy upgrade itself still applies to genuinely bare ids.
    assert.equal(normalizeRoleModelSelection(INSTALLED), `lmstudio:${INSTALLED}`)
  })

  it('is not mistaken for an unavailable model', async () => {
    // A rule has no id to install; pre-checking it as one would report a
    // configuration fault on a perfectly valid default.
    assert.equal(await findSafetyModelProblem(DEFAULT_SAFETY_MODEL), null)
  })

  it('takes a qualifying local model, and a cloud one only when none qualifies', () => {
    const weakLocal: FrontierPoint = {
      id: 'lmstudio:weak',
      intellect: 8,
      costPerMTok: 0,
      local: true,
      onFrontier: true,
    }
    const goodLocal: FrontierPoint = {
      id: 'lmstudio:good',
      intellect: 31.7,
      costPerMTok: 0,
      local: true,
      onFrontier: true,
    }
    const cloudCheap: FrontierPoint = {
      id: 'cloud-cheap',
      intellect: 25,
      costPerMTok: 0.5,
      onFrontier: true,
    }
    const cloudDear: FrontierPoint = {
      id: 'cloud-dear',
      intellect: 60,
      costPerMTok: 30,
      onFrontier: true,
    }
    const rule = { kind: 'min-intellect', threshold: SAFETY_MODEL_MIN_INTELLECT } as const

    // A local model over the bar wins outright, however much smarter the cloud
    // options are: screening reads terminal scrollback, so staying on the
    // machine is the point. Local counts as free, and free wins.
    assert.equal(pickDynamicModel(rule, [goodLocal, cloudCheap, cloudDear])?.id, 'lmstudio:good')
    // A local model *under* the bar does not qualify, so screening moves to the
    // cheapest cloud route that does -- the whole reason the bar exists.
    assert.equal(pickDynamicModel(rule, [weakLocal, cloudCheap, cloudDear])?.id, 'cloud-cheap')
    // No local server at all: still resolves, still to the cheapest qualifier.
    assert.equal(pickDynamicModel(rule, [cloudCheap, cloudDear])?.id, 'cloud-cheap')
  })
})
