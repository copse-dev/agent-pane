import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseClassifierEvalArgs,
  parseClassifierEvalProfile,
  parseClassifierFixtures,
  runClassifierEval,
} from './classifier-eval.ts'
import { ClassifierError } from '@copse/llm/classifiers/error.ts'
import type {
  ClassifierProfile,
  ClassifierRequest,
  ClassifierResult,
} from '@copse/llm/classifiers/types.ts'

const profile: ClassifierProfile = {
  id: 'local',
  label: 'Local',
  model: 'pinned-model',
  timeoutMs: 1000,
  connection: {
    type: 'http',
    protocol: 'systemone',
    baseUrl: 'http://127.0.0.1:8080',
    auth: 'none',
  },
}
const fixture = {
  id: 'delivered',
  state: 'It arrived.',
  questions: { arrived: { type: 'boolean', instructions: 'Did the package arrive?' } },
  expected: { arrived: true },
}
const fixtures = parseClassifierFixtures(JSON.stringify([fixture, { ...fixture, id: 'second' }]))
function result(_request: ClassifierRequest): ClassifierResult {
  return {
    profileId: profile.id,
    adapter: 'systemone/v1',
    requestedModel: profile.model,
    model: 'checkpoint-sha',
    answers: { arrived: { type: 'boolean', probability: 0.9 } },
    elapsedMs: 5,
    usage: { inputTokens: 12 },
  }
}

test('classifier eval parses JSON and JSONL with strict validation and unique IDs', () => {
  assert.deepEqual(
    parseClassifierFixtures(JSON.stringify([fixture])),
    parseClassifierFixtures(JSON.stringify(fixture) + '\n'),
  )
  assert.throws(() => parseClassifierFixtures(JSON.stringify([fixture, fixture])), /unique/)
  assert.throws(
    () => parseClassifierFixtures(JSON.stringify({ ...fixture, questions: {} })),
    /valid classifier/,
  )
  assert.throws(
    () => parseClassifierFixtures(JSON.stringify({ ...fixture, apiKey: 'never-accepted' })),
    /valid classifier/,
  )
})

test('classifier eval arguments select one credential mode and reject malformed concurrency', () => {
  assert.deepEqual(parseClassifierEvalArgs(['--profile', 'local', '--input', 'fixtures.jsonl']), {
    profile: 'local',
    input: 'fixtures.jsonl',
    concurrency: 1,
  })
  assert.throws(
    () =>
      parseClassifierEvalArgs(['--profile', 'local', '--config', 'file', '--input', 'fixtures']),
    /exactly one/,
  )
  assert.throws(
    () =>
      parseClassifierEvalArgs(['--config', 'file', '--input', 'fixtures', '--concurrency', '0']),
    /between/,
  )
  assert.throws(
    () =>
      parseClassifierEvalArgs(['--config', 'file', '--input', 'fixtures', '--config', 'duplicate']),
    /Use/,
  )
})

test('classifier eval configuration never accepts inline API keys', () => {
  assert.deepEqual(parseClassifierEvalProfile(JSON.stringify(profile)), profile)
  assert.throws(
    () => parseClassifierEvalProfile(JSON.stringify({ ...profile, apiKey: 'secret' })),
    /credentials only/,
  )
  assert.throws(
    () =>
      parseClassifierEvalProfile(
        JSON.stringify({ ...profile, connection: { ...profile.connection, apiKey: 'secret' } }),
      ),
    /credentials only/,
  )
})

test('classifier eval hashes nonsecret config and fixtures while preserving returned versions and usage', async () => {
  const records = await runClassifierEval(fixtures, profile, async (requests) =>
    requests.map(result),
  )
  const repeat = await runClassifierEval(fixtures, profile, async (requests) =>
    requests.map(result),
  )
  assert.equal(records.length, 2)
  const first = records[0]
  assert.ok(first)
  assert.equal(first.fixtureHash, repeat[0]?.fixtureHash)
  assert.equal(first.configHash, repeat[0]?.configHash)
  assert.notEqual(first.fixtureHash, records[1]?.fixtureHash)
  assert.deepEqual(first.expected, { arrived: true })
  const output = first.result
  assert.ok(output)
  assert.equal(output.model, 'checkpoint-sha')
  assert.equal(output.usage?.inputTokens, 12)
  const changed = await runClassifierEval(
    fixtures,
    { ...profile, model: 'new-checkpoint' },
    async (requests) => requests.map(result),
  )
  assert.notEqual(first.configHash, changed[0]?.configHash)
})

test('classifier eval bounds concurrent calls and preserves fixture order', async () => {
  let running = 0
  let maximum = 0
  const records = await runClassifierEval(
    fixtures,
    profile,
    async (requests) => {
      running++
      maximum = Math.max(maximum, running)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running--
      return requests.map(result)
    },
    { concurrency: 2 },
  )
  assert.equal(maximum, 2)
  assert.deepEqual(
    records.map((record) => record.id),
    ['delivered', 'second'],
  )
})

test('classifier eval reports every SemIf batch failure and only starts one process invocation', async () => {
  const local: ClassifierProfile = {
    ...profile,
    model: '/cached/model',
    connection: {
      type: 'semif',
      executable: 'semif-score',
      backend: 'torch',
      revision: 'pinned',
      mode: 'direct',
    },
  }
  let calls = 0
  const records = await runClassifierEval(fixtures, local, async (requests) => {
    calls++
    assert.equal(requests.length, 2)
    throw new ClassifierError('process', 'The cached model could not be loaded.')
  })
  assert.equal(calls, 1)
  assert.deepEqual(
    records.map((record) => record.error?.code),
    ['process', 'process'],
  )
})

test('classifier eval cancellation and unexpected failures produce explicit safe errors', async () => {
  const controller = new AbortController()
  controller.abort()
  const cancelled = await runClassifierEval(
    fixtures,
    profile,
    async () => {
      throw new Error('must not run')
    },
    { signal: controller.signal },
  )
  assert.ok(cancelled.every((record) => record.error?.code === 'cancelled'))
  const failed = await runClassifierEval(fixtures, profile, async () => {
    throw new Error('SECRET-PROVIDER-RESPONSE')
  })
  assert.ok(failed.every((record) => record.error?.code === 'failed'))
  assert.ok(!JSON.stringify(failed).includes('SECRET'))
  const missing = await runClassifierEval(fixtures, profile, async () => [])
  assert.ok(missing.every((record) => record.error?.code === 'invalid-response'))
})

test('headless CLI calls a local fixture server with environment credentials and emits safe JSONL', async () => {
  const { createServer } = await import('node:http')
  const { once } = await import('node:events')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { safeJsonParse } = await import('@copse/std/safe-json.ts')
  const server = createServer((request, response) => {
    assert.equal(request.url, '/v1/systemone')
    assert.equal(request.headers.authorization, 'Bearer classifier-eval-test-key')
    request.resume()
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        model: 'fixture-checkpoint',
        answers: { arrived: { type: 'noul', noul: 0.9 } },
      }),
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const directory = await mkdtemp(join(tmpdir(), 'classifier-eval-cli-'))
  try {
    const configPath = join(directory, 'profile.json')
    const fixturePath = join(directory, 'fixtures.jsonl')
    await writeFile(
      configPath,
      JSON.stringify({
        ...profile,
        connection: {
          type: 'http',
          protocol: 'systemone',
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          auth: 'bearer',
          apiKeyEnv: 'COPSE_CLASSIFIER_EVAL_TEST_KEY',
        },
      }),
    )
    await writeFile(fixturePath, JSON.stringify(fixture) + '\n')
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [resolve('scripts/run-classifier-eval.mts'), '--config', configPath, '--input', fixturePath],
      {
        env: { ...process.env, COPSE_CLASSIFIER_EVAL_TEST_KEY: 'classifier-eval-test-key' },
        timeout: 30_000,
      },
    )
    assert.ok(!stdout.includes('classifier-eval-test-key'))
    assert.ok(!stderr.includes('classifier-eval-test-key'))
    const record = safeJsonParse(stdout.trim())
    assert.ok(typeof record === 'object' && record !== null && 'result' in record)
    assert.ok(
      typeof record.result === 'object' && record.result !== null && 'model' in record.result,
    )
    assert.equal(record.result.model, 'fixture-checkpoint')
  } finally {
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
