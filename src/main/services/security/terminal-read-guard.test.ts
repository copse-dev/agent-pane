import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { setSetting, setApiKey } from '../storage/settings.ts'
import { classifyTerminalSnapshot, terminalReadNeedsApproval } from './terminal-read-guard.ts'
import { resetSafetyModelProblemReportsForTest } from './safety-model-availability.ts'
import { invalidateLmStudioModelsCache } from '../providers/provider-selection.ts'

/**
 * A safety model can be configured, enabled, and simply absent — that is the
 * default state of a fresh install whose model download never finished, since
 * `LM_STUDIO_MODEL_IDS.safety` is pre-selected before anything is downloaded.
 *
 * The gate stays fail-closed in that state (good), but it used to be silent:
 * every `read_terminal` spent a doomed request, hit the bare `catch`, and
 * raised a prompt worded exactly like a transient timeout. These tests pin the
 * distinction — and pin that the doomed request is no longer sent.
 */

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
let listModels: string[] = [INSTALLED]
let modelsReachable = true

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.endsWith('/v1/models') || url.endsWith('/api/v1/models')) {
      if (!modelsReachable) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'server down' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: listModels.map((id) => ({ id })) }))
      return
    }
    if (url.endsWith('/v1/chat/completions')) {
      completionCalls += 1
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `Model "${MISSING}" not found.` }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  const port = await listenOnLoopback(server)

  // `resolveLocalServerUrl` prefers these over the stored setting.
  delete process.env['COPSE_EVAL_LM_STUDIO_URL']
  delete process.env['LM_STUDIO_BASE_URL']
  await setSetting('localServerUrl', `http://127.0.0.1:${String(port)}/v1`)
  await setSetting('safetyClassifierEnabled', true)
  // A non-default key pins the OpenAI-compatible HTTP path, which is what a
  // server configured with an API token uses.
  setApiKey('lmstudio', 'test-token')
})

after(() => {
  server.close()
})

beforeEach(() => {
  completionCalls = 0
  listModels = [INSTALLED]
  modelsReachable = true
  resetSafetyModelProblemReportsForTest()
  invalidateLmStudioModelsCache()
})

describe('classifyTerminalSnapshot with an unavailable safety model', () => {
  it('reports a configured-but-absent model instead of a bare null', async () => {
    await setSetting('safetyModel', `lmstudio:${MISSING}`)
    const { verdict, problem } = await classifyTerminalSnapshot('$ echo hi\nhi\n')

    assert.equal(verdict, null)
    assert.ok(problem)
    assert.equal(problem.reason, 'not-available')
    assert.equal(problem.model, `lmstudio:${MISSING}`)
    assert.match(problem.message, /not available/)
    // The id the user has to install must be in the message; "could not screen
    // it" is what made this indistinguishable from a timeout.
    assert.match(problem.message, new RegExp(MISSING))
  })

  it('does not spend a request it already knows will fail', async () => {
    await setSetting('safetyModel', `lmstudio:${MISSING}`)
    await classifyTerminalSnapshot('$ echo hi\nhi\n')
    assert.equal(completionCalls, 0)
  })

  it('distinguishes an unreachable server from an absent model', async () => {
    await setSetting('safetyModel', `lmstudio:${MISSING}`)
    modelsReachable = false
    invalidateLmStudioModelsCache()
    const { problem } = await classifyTerminalSnapshot('$ echo hi\nhi\n')
    assert.equal(problem?.reason, 'server-unreachable')
  })

  it('still fails closed: no verdict means the user is asked', async () => {
    await setSetting('safetyModel', `lmstudio:${MISSING}`)
    const { verdict } = await classifyTerminalSnapshot('$ echo hi\nhi\n')
    assert.equal(terminalReadNeedsApproval(verdict), true)
  })

  it('reports no problem for an installed model, and does screen it', async () => {
    await setSetting('safetyModel', `lmstudio:${INSTALLED}`)
    const { problem } = await classifyTerminalSnapshot('$ echo hi\nhi\n')
    // The stub 404s completions, so there is no verdict — but that is a
    // screening failure, not a configuration fault, and must not be reported
    // as one.
    assert.equal(problem, null)
    assert.equal(completionCalls, 1)
  })

  it('reports nothing when the classifier is switched off', async () => {
    await setSetting('safetyClassifierEnabled', false)
    await setSetting('safetyModel', `lmstudio:${MISSING}`)
    const result = await classifyTerminalSnapshot('$ echo hi\nhi\n')
    assert.deepEqual(result, { verdict: null, problem: null })
    assert.equal(completionCalls, 0)
    await setSetting('safetyClassifierEnabled', true)
  })
})
