import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { recommendedModelParameters } from '@copse/llm/model-parameters.ts'
import type { LLMProvider } from '@copse/llm/wire-types.ts'
import {
  DEFAULT_TERMINAL_MODEL_PARAMETERS_MODE,
  TERMINAL_MODEL_PARAMETERS_ARTIFACT,
  buildTerminalProviders,
  resolveTerminalModelParameters,
  terminalMaxOutputTokens,
  terminalModelParametersMode,
  writeTerminalModelParametersRecord,
} from './terminal-bench-model-parameters.mts'
import { recordTerminalBenchProviderRequests } from './terminal-bench-provider-recorder.mts'

const QWEN = 'qwen3.6-35b-a3b'
const SAMPLING_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'repetition_penalty',
  'max_tokens',
]

describe('terminal bench model parameters', () => {
  const bodies: Record<string, unknown>[] = []
  let server: Server
  let baseUrl = ''
  let root = ''

  before(async () => {
    root = mkdtempSync(join(tmpdir(), 'tb-model-params-'))
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof parsed === 'object' && parsed !== null) {
          bodies.push(Object.fromEntries(Object.entries(parsed)))
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    baseUrl = `http://127.0.0.1:${String(address.port)}/v1`
  })

  after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  })

  async function drain(provider: LLMProvider): Promise<void> {
    const chunks: unknown[] = []
    for await (const chunk of provider.stream([{ role: 'user', content: 'hi' }], [])) {
      chunks.push(chunk)
    }
  }

  function sampling(body: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(SAMPLING_KEYS.map((key) => [key, body[key]]))
  }

  it('defaults to the client recipe and rejects unknown modes', () => {
    assert.equal(DEFAULT_TERMINAL_MODEL_PARAMETERS_MODE, 'client')
    assert.equal(terminalModelParametersMode(undefined), 'client')
    assert.equal(terminalModelParametersMode(' server '), 'server')
    assert.throws(() => terminalModelParametersMode('both'), /COPSE_TERMINAL_MODEL_PARAMETERS/)
  })

  it('resolves the curated recipe for qwen3.6-35b-a3b and nothing for an unknown model', () => {
    const qwen = resolveTerminalModelParameters('client', QWEN)
    assert.deepEqual(qwen.params, recommendedModelParameters('lmstudio:' + QWEN)?.params)
    assert.equal(qwen.params.presencePenalty, 1.5)
    assert.equal(qwen.params.temperature, 1)
    assert.equal(qwen.outputCeiling, 81_920)
    assert.ok(qwen.recipe)
    const unknown = resolveTerminalModelParameters('client', 'no-such-model')
    assert.deepEqual(unknown.params, {})
    assert.equal(unknown.recipe, null)
    assert.equal(unknown.outputCeiling, null)
  })

  it('server mode resolves nothing', () => {
    const record = resolveTerminalModelParameters('server', QWEN)
    assert.deepEqual(record.params, {})
    assert.equal(record.outputCeiling, null)
    assert.equal(record.mode, 'server')
  })

  it('sends identical sampling on the base and forced-write paths in client mode', async () => {
    bodies.length = 0
    const providers = buildTerminalProviders({
      baseUrl,
      model: QWEN,
      apiKey: 'test-key',
      forcesRequestedOutputRecovery: true,
      record: resolveTerminalModelParameters('client', QWEN),
    })
    assert.ok(providers.forcedWrite)
    await drain(providers.base)
    await drain(providers.forcedWrite)
    const [base, forced] = bodies
    assert.ok(base && forced)
    assert.deepEqual(sampling(base), {
      temperature: 1,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      presence_penalty: 1.5,
      repetition_penalty: 1,
      max_tokens: 81_920,
    })
    assert.deepEqual(sampling(forced), sampling(base))
    assert.equal(base['tool_choice'], undefined)
    assert.ok(forced['tool_choice'])
    assert.deepEqual(base['stream_options'], { include_usage: true })
  })

  it('routes the non-forcing profile through the compatible endpoint with the recipe', async () => {
    bodies.length = 0
    const { base } = buildTerminalProviders({
      baseUrl,
      model: QWEN,
      apiKey: 'lm-studio',
      forcesRequestedOutputRecovery: false,
      record: resolveTerminalModelParameters('client', QWEN),
    })
    await drain(base)
    const body = bodies[0]
    assert.ok(body)
    assert.equal(body['presence_penalty'], 1.5)
    assert.equal(body['top_k'], 20)
    assert.deepEqual(body['stream_options'], { include_usage: true })
  })

  it('server mode sends no sampling fields on either path', async () => {
    bodies.length = 0
    const providers = buildTerminalProviders({
      baseUrl,
      model: QWEN,
      apiKey: 'test-key',
      forcesRequestedOutputRecovery: true,
      record: resolveTerminalModelParameters('server', QWEN),
    })
    assert.ok(providers.forcedWrite)
    await drain(providers.base)
    await drain(providers.forcedWrite)
    assert.equal(bodies.length, 2)
    for (const body of bodies) {
      for (const key of SAMPLING_KEYS) assert.equal(body[key], undefined, key)
    }
  })

  it('writes the artifact and stamps provider requests with the sampling in force', async () => {
    const record = resolveTerminalModelParameters('client', QWEN)
    writeTerminalModelParametersRecord(root, record)
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, TERMINAL_MODEL_PARAMETERS_ARTIFACT), 'utf8')),
      record,
    )
    const path = join(root, 'provider-requests.jsonl')
    const empty: LLMProvider = {
      stream: () => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<never> {
          yield* []
        },
      }),
    }
    const recorded = recordTerminalBenchProviderRequests(empty, path, {
      mode: record.mode,
      params: record.params,
    })
    await drain(recorded)
    const line: unknown = JSON.parse(readFileSync(path, 'utf8').trim())
    assert.deepEqual(
      typeof line === 'object' && line !== null && 'sampling' in line ? line.sampling : undefined,
      { mode: 'client', params: record.params },
    )
  })
})

describe('terminal output ceiling cap', () => {
  it('parses a positive integer and treats blank as unset', () => {
    assert.equal(terminalMaxOutputTokens(undefined), undefined)
    assert.equal(terminalMaxOutputTokens('  '), undefined)
    assert.equal(terminalMaxOutputTokens('16384'), 16_384)
  })

  it('rejects values that are not positive integers', () => {
    for (const bad of ['0', '-5', '1.5', 'many']) {
      assert.throws(() => terminalMaxOutputTokens(bad), /COPSE_TERMINAL_MAX_OUTPUT_TOKENS/)
    }
  })

  it('adds nothing in server mode when no cap is set', () => {
    const record = resolveTerminalModelParameters('server', QWEN)
    assert.equal(record.outputCeiling, null)
    assert.deepEqual(record.params, {})
  })

  it('lets the cap replace the card ceiling in both modes', () => {
    for (const mode of ['server', 'client'] as const) {
      const record = resolveTerminalModelParameters(mode, QWEN, 16_384)
      assert.equal(record.outputCeiling, 16_384, mode)
      assert.equal(record.params.maxOutputTokens, 16_384, mode)
    }
  })

  it('keeps the sampling recipe when a cap is set in client mode', () => {
    const record = resolveTerminalModelParameters('client', QWEN, 16_384)
    assert.equal(record.params.presencePenalty, 1.5)
    assert.equal(record.params.topK, 20)
  })
})
