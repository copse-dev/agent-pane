import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { setSetting, setApiKey } from '../storage/settings.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import {
  TERMINAL_READ_SCREEN_MAX_CHARS,
  classifyTerminalSnapshot,
  ensureTerminalReadPermitted,
  setTerminalSnapshotClassifierForTest,
  terminalReadNeedsApproval,
  type TerminalReadVerdict,
} from './terminal-read-guard.ts'
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

/**
 * The safety model is shown only the trailing slice of a snapshot, so its
 * verdict can only vouch for that slice. These tests pin the gate's side of
 * that contract: a confident "safe" never auto-shares a snapshot larger than
 * the screened window (#2280), and the explanation the user sees says how much
 * the model actually looked at. The model itself is replaced by a scripted
 * verdict, so the stub server above is not involved.
 */
describe('read_terminal gate', () => {
  const CONFIDENT_SAFE: TerminalReadVerdict = {
    risky: false,
    confidence: 0.95,
    reason: 'ordinary build output',
  }

  /** `count` numbered lines of roughly `width` characters each. */
  function scrollback(count: number, width = 80): string {
    const lines: string[] = []
    for (let i = 1; i <= count; i++) {
      lines.push(`[${String(i).padStart(5, '0')}] ${'build output '.repeat(width)}`.slice(0, width))
    }
    return lines.join('\n')
  }

  let classifierCalls: string[] = []
  let prompts: ApprovalRequest[] = []
  let promptAnswer: { approved: boolean; remember: boolean } = { approved: true, remember: false }

  beforeEach(() => {
    classifierCalls = []
    prompts = []
    promptAnswer = { approved: true, remember: false }
    setTerminalSnapshotClassifierForTest((text) => {
      classifierCalls.push(text)
      return Promise.resolve({ verdict: CONFIDENT_SAFE, problem: null })
    })
    setApprovalHandler((req) => {
      prompts.push(req)
      return Promise.resolve(promptAnswer)
    })
  })

  afterEach(() => {
    setTerminalSnapshotClassifierForTest(null)
    setApprovalHandler(null)
  })

  describe('a snapshot that fits the screened window', () => {
    it('auto-shares on a confident safe verdict, having screened the whole snapshot', async () => {
      const text = scrollback(40)
      assert.ok(text.length <= TERMINAL_READ_SCREEN_MAX_CHARS)

      const result = await ensureTerminalReadPermitted(null, 'Build', text)

      assert.deepEqual(result, { allowed: true })
      assert.deepEqual(classifierCalls, [text])
      assert.equal(prompts.length, 0)
    })

    it('still asks the user when the verdict is risky, naming the reason', async () => {
      setTerminalSnapshotClassifierForTest(() =>
        Promise.resolve({
          verdict: { risky: true, confidence: 0.8, reason: 'looks like an API token' },
          problem: null,
        }),
      )
      promptAnswer = { approved: false, remember: false }

      const result = await ensureTerminalReadPermitted(null, 'Build', scrollback(40))

      assert.equal(result.allowed, false)
      assert.match(result.deniedMessage ?? '', /declined to share/)
      assert.equal(prompts.length, 1)
      assert.match(prompts[0]?.body ?? '', /flagged it: looks like an API token/)
    })

    it('names a reported model problem rather than a generic failure', async () => {
      setTerminalSnapshotClassifierForTest(() =>
        Promise.resolve({
          verdict: null,
          problem: {
            reason: 'not-available',
            model: `lmstudio:${MISSING}`,
            message: `The safety model ${MISSING} is not available on the local server.`,
          },
        }),
      )

      await ensureTerminalReadPermitted(null, 'Build', scrollback(40))

      assert.equal(prompts.length, 1)
      assert.match(prompts[0]?.body ?? '', /is not available on the local server/)
    })
  })

  describe('a snapshot larger than the screened window', () => {
    it('never auto-shares on a safe verdict — the model did not see all of it', async () => {
      const text = scrollback(200)
      assert.ok(text.length > TERMINAL_READ_SCREEN_MAX_CHARS)
      promptAnswer = { approved: false, remember: false }

      const result = await ensureTerminalReadPermitted(null, 'Build', text)

      assert.equal(result.allowed, false)
      assert.match(result.deniedMessage ?? '', /declined to share/)
      assert.equal(prompts.length, 1)
      assert.equal(prompts[0]?.cause, 'terminal-output-share')
    })

    it('goes to the user without spending a screening call that could not change the outcome', async () => {
      await ensureTerminalReadPermitted(null, 'Build', scrollback(200))

      assert.equal(classifierCalls.length, 0)
      assert.equal(prompts.length, 1)
    })

    it('tells the user how many lines the model actually saw whole', async () => {
      // 200 lines of 80 chars + newline: the window holds 74 whole lines plus
      // six characters of a 75th. The model saw only a scrap of that one, so
      // it is not reported as screened.
      await ensureTerminalReadPermitted(null, 'Build', scrollback(200))

      const body = prompts[0]?.body ?? ''
      assert.match(body, /"Build" shell/)
      assert.match(body, /larger than the safety model screens/)
      assert.match(body, /only the most recent 74 of its 200 lines were fully screened/)
    })

    it('counts a single whole line in the singular', async () => {
      const text = 'hidden-prefix' + 'V\n' + 'y'.repeat(TERMINAL_READ_SCREEN_MAX_CHARS - 2)

      await ensureTerminalReadPermitted(null, 'Build', text)

      assert.match(
        prompts[0]?.body ?? '',
        /only the most recent 1 of its 2 lines was fully screened/,
      )
    })

    it('shares it once the user approves', async () => {
      const result = await ensureTerminalReadPermitted(null, 'Build', scrollback(200))

      assert.deepEqual(result, { allowed: true })
      assert.equal(prompts.length, 1)
    })

    it('honours "Always allow for this chat" for later reads in that chat only', async () => {
      promptAnswer = { approved: true, remember: true }
      await ensureTerminalReadPermitted('thread-remembered', 'Build', scrollback(200))
      assert.equal(prompts.length, 1)

      await ensureTerminalReadPermitted('thread-remembered', 'Build', scrollback(300))
      assert.equal(prompts.length, 1)

      await ensureTerminalReadPermitted('thread-other', 'Build', scrollback(300))
      assert.equal(prompts.length, 2)
    })

    it('explains an oversized snapshot with no line breaks without a bogus line count', async () => {
      const text = 'x'.repeat(TERMINAL_READ_SCREEN_MAX_CHARS + 1)

      await ensureTerminalReadPermitted(null, 'Build', text)

      const body = prompts[0]?.body ?? ''
      assert.match(body, /part of it was not screened/)
      assert.doesNotMatch(body, /of its/)
    })
  })
})
