import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { setSetting, setApiKey } from '../storage/settings.ts'
import { classifyTerminalSnapshot, terminalReadNeedsApproval } from './terminal-read-guard.ts'
import { classifyShellScope } from './safety-classifier.ts'
import { resolveSafetyScreeningModel } from './safety-screening-model.ts'
import {
  noteSafetyModelTimeout,
  resetSafetyModelCooldownsForTest,
} from './safety-model-cooldown.ts'
import { resetSafetyModelProblemReportsForTest } from './safety-model-availability.ts'
import { invalidateLmStudioModelsCache } from '../providers/provider-selection.ts'
import { setPlanUsageSnapshotFetcherForTest } from '../plan-usage-bridge.ts'
import { PROVIDER_ENV_VARS } from '../providers/env-key-detection.ts'
import { FETCH_TIMEOUTS } from '../fetch-timeouts.ts'

/**
 * A safety model can clear the intelligence bar and still be too slow to be
 * worth calling. `google/gemma-4-12b` scores 22.2 and needs ~13.6s on a full
 * 6000-character snapshot, so it missed the 8s budget on essentially every
 * `read_terminal` — and the user paid the whole budget each time before being
 * asked to approve the read anyway.
 *
 * These tests pin the three things that fixes it: the timeout is told apart
 * from every other failure, the model is routed around once it is established,
 * and screening still fails closed when there is nothing to route to.
 */

const SLOW = 'google/gemma-4-e4b'
const FAST = 'qwen/qwen3.6-35b-a3b'
const BUDGET = FETCH_TIMEOUTS.safetyClassification

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
  return address.port
}

/** The `model` field of an OpenAI-compatible completion request body. */
function requestedModel(body: string): string {
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null || !('model' in parsed)) return ''
  return typeof parsed.model === 'string' ? parsed.model : ''
}

let server: Server
/** Model ids the stub was asked to complete with, in order. */
let completionModels: string[] = []
/** Ids the stub server lists, and the one it deliberately never answers for. */
let listModels: string[] = [SLOW, FAST]
let stalledModel: string | null = null
/** Held open by a stalled request; released in `after` so the server can close. */
let stalled: ServerResponse[] = []
const savedEnv = new Map<string, string | undefined>()

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/v1/models') || url.endsWith('/api/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: listModels.map((id) => ({ id })) }))
      return
    }
    if (url.endsWith('/v1/chat/completions')) {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      req.on('end', () => {
        const model = requestedModel(body)
        completionModels.push(model)
        // The slow model behaves exactly like one that cannot finish inside the
        // budget: the request is accepted and simply never answered, so the
        // classifier's own timer is what ends it.
        if (model === stalledModel) {
          stalled.push(res)
          return
        }
        // The provider streams, so answer as one: a single content delta
        // carrying the verdict, then the usage frame and `[DONE]`.
        const content = '{"risk":"safe","confidence":0.9,"reason":"ordinary build output"}'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const frame of [
          { choices: [{ delta: { content } }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]) {
          res.write(`data: ${JSON.stringify(frame)}\n\n`)
        }
        res.end('data: [DONE]\n\n')
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const port = await listenOnLoopback(server)

  // `resolveLocalServerUrl` prefers these over the stored setting.
  delete process.env['COPSE_EVAL_LM_STUDIO_URL']
  delete process.env['LM_STUDIO_BASE_URL']
  // A cloud key in the developer's environment would put cloud routes in the
  // candidate pool and make "which model screens instead" depend on whose
  // machine ran the suite. Only the stub's two local models should be routable.
  for (const names of Object.values(PROVIDER_ENV_VARS)) {
    for (const name of names) {
      if (name.startsWith('LM')) continue
      savedEnv.set(name, process.env[name])
      process.env[name] = ''
    }
  }
  setPlanUsageSnapshotFetcherForTest(() =>
    Promise.resolve({ checkedAt: new Date().toISOString(), providers: [] }),
  )

  await setSetting('localServerUrl', `http://127.0.0.1:${String(port)}/v1`)
  await setSetting('safetyClassifierEnabled', true)
  // A non-default key pins the OpenAI-compatible HTTP path, which is what a
  // server configured with an API token uses.
  setApiKey('lmstudio', 'test-token')
})

after(async () => {
  for (const res of stalled) res.destroy()
  stalled = []
  setPlanUsageSnapshotFetcherForTest(null)
  for (const [name, value] of savedEnv) process.env[name] = value ?? ''
  await setSetting('safetyClassifierEnabled', false)
  server.close()
})

beforeEach(() => {
  completionModels = []
  listModels = [SLOW, FAST]
  stalledModel = null
  resetSafetyModelCooldownsForTest()
  resetSafetyModelProblemReportsForTest()
  invalidateLmStudioModelsCache()
})

describe('a safety model that misses its screening budget', () => {
  it('is reported as timed out rather than as a nameless screening failure', async () => {
    await setSetting('safetyModel', `lmstudio:${SLOW}`)
    stalledModel = SLOW

    const { verdict, problem } = await classifyTerminalSnapshot('$ npm run build\ndone\n')

    assert.equal(verdict, null)
    assert.equal(problem?.reason, 'timed-out')
    assert.equal(problem.model, `lmstudio:${SLOW}`)
    // The model and the budget it missed are both in the message: "could not
    // screen it" is what made a slow model look like a passing glitch.
    assert.match(problem.message, new RegExp(SLOW))
    assert.match(problem.message, new RegExp(`${String(BUDGET / 1000)}s`))
    // Fail-closed is untouched: no verdict still means the user is asked.
    assert.equal(terminalReadNeedsApproval(verdict), true)
  })

  it('screens on another model once it has struck out, instead of paying again', async () => {
    await setSetting('safetyModel', `lmstudio:${SLOW}`)
    stalledModel = SLOW
    // Two strikes is what opens the cooldown; the first is discounted because
    // it is indistinguishable from a just-in-time model load.
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)

    const { verdict, problem } = await classifyTerminalSnapshot('$ npm run build\ndone\n')

    assert.equal(problem, null)
    assert.deepEqual(verdict, {
      risky: false,
      confidence: 0.9,
      reason: 'ordinary build output',
    })
    // Screening happened, so the read is allowed without asking — the fallback
    // is a real screen, not a waiver.
    assert.equal(terminalReadNeedsApproval(verdict), false)
    // The whole point: the slow model was never asked, so nothing waited on it.
    assert.deepEqual(completionModels, [FAST])
  })

  it('overrides even a pinned model, because the pin is what is failing', async () => {
    await setSetting('safetyModel', `lmstudio:${SLOW}`)
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)

    const chosen = await resolveSafetyScreeningModel()
    assert.equal(chosen.problem, null)
    assert.equal(chosen.model, `lmstudio:${FAST}`)
  })

  it('leaves a model alone while it is only on one strike', async () => {
    await setSetting('safetyModel', `lmstudio:${SLOW}`)
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)

    const chosen = await resolveSafetyScreeningModel()
    assert.equal(chosen.model, `lmstudio:${SLOW}`)
  })

  it('fails closed when there is nothing else to screen with', async () => {
    // The one model the server offers is the one being routed around.
    listModels = [SLOW]
    invalidateLmStudioModelsCache()
    await setSetting('safetyModel', `lmstudio:${SLOW}`)
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)

    const { verdict, problem } = await classifyTerminalSnapshot('$ cat .env\nSECRET=hunter2\n')

    assert.equal(verdict, null)
    assert.equal(terminalReadNeedsApproval(verdict), true)
    assert.equal(problem?.reason, 'timed-out')
    assert.match(problem.message, /no other model is available/)
    // Fail-closed, not fail-slow: the budget is not spent a third time.
    assert.deepEqual(completionModels, [])
  })

  it('routes the shell classifier around the same model', async () => {
    // Both classifiers share the cooldown, so a model established as too slow
    // by terminal screening is not re-tried per shell command either.
    await setSetting('safetyModel', `lmstudio:${SLOW}`)
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)
    noteSafetyModelTimeout(`lmstudio:${SLOW}`, BUDGET)

    await classifyShellScope('ls -la')
    assert.deepEqual(completionModels, [FAST])
  })
})
