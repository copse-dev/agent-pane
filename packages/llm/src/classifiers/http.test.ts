import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { ClassifierError } from './error.ts'
import { classifyHttp } from './http.ts'
import { CLASSIFIER_PRESETS, CLASSIFIER_TEST_REQUEST } from './presets.ts'
import type { ClassifierProfile, ClassifierRequest } from './types.ts'

function profile(id = 'kev'): ClassifierProfile {
  const found = CLASSIFIER_PRESETS.find((entry) => entry.id === id)
  assert.ok(found)
  return found
}

function success(): object {
  return {
    model: 'jev-1.13.0',
    answers: {
      color: {
        type: 'choice',
        choice: 'red',
        confidence: 0.78,
        probabilities: { blue: 0.15, red: 0.85 },
      },
    },
    usage: { input_tokens: 392, output_tokens: 65 },
  }
}

describe('classifier HTTP adapters', () => {
  it('encodes named questions and preserves confidence separately from probabilities', async () => {
    let attempts = 0
    const result = await classifyHttp(profile('typesafe'), CLASSIFIER_TEST_REQUEST, {
      apiKey: 'secret-key',
      fetchImpl: async (url, init) => {
        attempts++
        assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
        assert.equal(init?.redirect, 'manual')
        const headers = new Headers(init.headers)
        assert.equal(headers.get('Authorization'), 'Bearer secret-key')
        assert.equal(typeof init.body, 'string')
        if (typeof init.body !== 'string') assert.fail('expected JSON body')
        assert.deepEqual(safeJsonParse(init.body), {
          model: 'jev-latest',
          state: 'The bicycle is red.',
          questions: {
            color: {
              type: 'choice',
              instructions: 'What color is the bicycle?',
              criteria: { red: null, blue: null },
            },
          },
        })
        return Response.json(success(), { headers: { 'x-request-id': 'req-42' } })
      },
    })
    assert.equal(attempts, 1)
    assert.equal(result.model, 'jev-1.13.0')
    assert.equal(result.requestedModel, 'jev-latest')
    assert.equal(result.requestId, 'req-42')
    assert.deepEqual(result.usage, { inputTokens: 392, outputTokens: 65 })
    assert.deepEqual(result.answers['color'], {
      type: 'choice',
      choice: 'red',
      probabilities: { red: 0.85, blue: 0.15 },
      confidence: 0.78,
    })
    assert.ok(result.elapsedMs >= 0)
  })

  it('sends no Authorization for a keyless local profile, even if given a key', async () => {
    await classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, {
      apiKey: 'never-send-me',
      fetchImpl: async (url, init) => {
        assert.equal(url, 'http://127.0.0.1:8009/v1/systemone')
        assert.equal(new Headers(init?.headers).has('Authorization'), false)
        return Response.json(success())
      },
    })
  })

  it('scrubs reflected keys from provider text while preserving semantic identifiers', async () => {
    const apiKey = 'private-classifier-key-123456789'
    const questionId = `ghp_${'a'.repeat(36)}`
    const optionId = `sk-proj-${'b'.repeat(32)}`
    const request: ClassifierRequest = {
      state: 'Choose the first option.',
      questions: {
        [questionId]: {
          type: 'choice',
          instructions: 'Which option?',
          options: { [optionId]: null, other: null },
        },
      },
    }
    for (const includeBodyId of [true, false]) {
      const result = await classifyHttp(profile('typesafe'), request, {
        apiKey,
        fetchImpl: async () =>
          Response.json(
            {
              model: `server-${apiKey}`,
              model_revision: `revision-${apiKey}`,
              checkpoint: `/checkpoint/${apiKey}`,
              prompt_version: `prompt-${apiKey}`,
              ...(includeBodyId ? { request_id: `request-${apiKey}` } : {}),
              answers: {
                [questionId]: {
                  type: 'choice',
                  choice: optionId,
                  probabilities: { [optionId]: 0.9, other: 0.1 },
                },
              },
            },
            { headers: { 'x-request-id': `header-${apiKey}` } },
          ),
      })
      assert.equal(JSON.stringify(result).includes(apiKey), false)
      assert.equal(result.model, 'server-[REDACTED_SECRET]')
      assert.equal(result.requestId, `${includeBodyId ? 'request' : 'header'}-[REDACTED_SECRET]`)
      assert.equal(result.metadata?.['modelRevision'], 'revision-[REDACTED_SECRET]')
      assert.equal(result.metadata['checkpoint'], '/checkpoint/[REDACTED_SECRET]')
      assert.equal(result.metadata['promptVersion'], 'prompt-[REDACTED_SECRET]')
      assert.deepEqual(result.answers[questionId], {
        type: 'choice',
        choice: optionId,
        probabilities: { [optionId]: 0.9, other: 0.1 },
      })
    }
  })

  it('maps boolean to noul and score to zero-based levels for Featherless', async () => {
    const request: ClassifierRequest = {
      state: { ticket: 'Please refund' },
      questions: {
        refund: {
          type: 'boolean',
          instructions: 'Refund requested?',
          criteria: { true: 'Explicit request' },
        },
        urgency: {
          type: 'score',
          instructions: 'Urgency',
          levels: ['Routine', 'Important', 'Critical'],
        },
      },
    }
    const result = await classifyHttp(profile('featherless'), request, {
      apiKey: 'key',
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://api.featherless.ai/v1/classifier')
        assert.equal(typeof init?.body, 'string')
        if (typeof init?.body !== 'string') assert.fail('expected JSON body')
        assert.deepEqual(safeJsonParse(init.body), {
          model: profile('featherless').model,
          state: request.state,
          questions: {
            refund: {
              type: 'noul',
              instructions: 'Refund requested?',
              criteria: { true: 'Explicit request' },
            },
            urgency: {
              type: 'score',
              instructions: 'Urgency',
              criteria: ['Routine', 'Important', 'Critical'],
            },
          },
        })
        return Response.json({
          model: 'fixture',
          answers: {
            refund: { type: 'noul', noul: 0.9 },
            urgency: {
              type: 'score',
              score: 1.75,
              probabilities: { '0': 0.05, '1': 0.15, '2': 0.8 },
              legend: { '0': 'Routine', '1': 'Important', '2': 'Critical' },
            },
          },
        })
      },
    })
    assert.deepEqual(result.answers['refund'], { type: 'boolean', probability: 0.9 })
    assert.deepEqual(result.answers['urgency'], {
      type: 'score',
      score: 1.75,
      levels: ['Routine', 'Important', 'Critical'],
      probabilities: { '0': 0.05, '1': 0.15, '2': 0.8 },
    })
    assert.equal(result.usage, undefined)
  })

  it('rejects unsafe destinations, missing keys, invalid requests and protocol limits before sending', async () => {
    const fetchImpl: typeof fetch = async () => {
      assert.fail('must not send')
    }
    for (const baseUrl of [
      'http://remote.example/v1',
      'https://user:pass@example.com/v1',
      'https://169.254.169.254/v1',
      'https://example.com/v1?key=secret',
    ]) {
      const invalid: ClassifierProfile = {
        ...profile(),
        connection: { type: 'http', protocol: 'systemone', auth: 'none', baseUrl },
      }
      await assert.rejects(classifyHttp(invalid, CLASSIFIER_TEST_REQUEST, { fetchImpl }), {
        code: 'invalid-request',
      })
    }
    await assert.rejects(
      classifyHttp(profile('typesafe'), CLASSIFIER_TEST_REQUEST, { fetchImpl }),
      { code: 'authentication' },
    )
    await assert.rejects(classifyHttp(profile(), { state: '', questions: {} }, { fetchImpl }), {
      code: 'invalid-request',
    })
    await assert.rejects(
      classifyHttp(
        profile(),
        {
          state: '',
          questions: {
            score: {
              type: 'score',
              instructions: '',
              levels: Array.from({ length: 11 }, (_, i) => String(i)),
            },
          },
        },
        { fetchImpl },
      ),
      { code: 'invalid-request' },
    )
    await assert.rejects(
      classifyHttp(
        profile('featherless'),
        {
          state: '',
          questions: {
            choice: {
              type: 'choice',
              instructions: '',
              options: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [String(i), null])),
            },
          },
        },
        { fetchImpl, apiKey: 'key' },
      ),
      { code: 'invalid-request' },
    )
  })

  it('reports status classes without including provider bodies or keys and never retries', async () => {
    for (const [status, code] of [
      [401, 'authentication'],
      [403, 'authentication'],
      [429, 'rate-limit'],
      [529, 'rate-limit'],
      [422, 'invalid-request'],
      [500, 'connectivity'],
      [302, 'invalid-response'],
    ]) {
      assert.equal(typeof status, 'number')
      if (typeof status !== 'number') assert.fail('invalid fixture')
      let count = 0
      await assert.rejects(
        classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, {
          fetchImpl: async () => {
            count++
            return new Response('reflected secret-key input', { status })
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ClassifierError)
          assert.equal(error.code, code)
          assert.equal(error.message.includes('secret-key'), false)
          return true
        },
      )
      assert.equal(count, 1)
    }
  })

  it('rejects malformed, incomplete and inconsistent responses', async () => {
    const invalid = [
      {},
      { model: 'fixture', answers: {} },
      { model: 'fixture', answers: { color: { type: 'noul', noul: 0.9 } } },
      {
        model: 'fixture',
        answers: {
          color: { type: 'choice', choice: 'green', probabilities: { red: 0.8, blue: 0.2 } },
        },
      },
      {
        model: 'fixture',
        answers: { color: { type: 'choice', choice: 'red', probabilities: { red: 0.8 } } },
      },
      {
        model: 'fixture',
        answers: {
          color: { type: 'choice', choice: 'red', probabilities: { red: 0.8, blue: 0.8 } },
        },
      },
      {
        model: 'fixture',
        answers: {
          color: {
            type: 'choice',
            choice: 'red',
            confidence: 2,
            probabilities: { red: 0.8, blue: 0.2 },
          },
        },
      },
    ]
    for (const body of invalid)
      await assert.rejects(
        classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, {
          fetchImpl: async () => Response.json(body),
        }),
        { code: 'invalid-response' },
      )
    await assert.rejects(
      classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, {
        fetchImpl: async () => new Response('<html>bad gateway</html>'),
      }),
      { code: 'invalid-response' },
    )
    await assert.rejects(
      classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, {
        fetchImpl: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)),
      }),
      { code: 'invalid-response' },
    )
  })

  it('honors cancellation before a call, during fetch and while reading a response', async () => {
    await assert.rejects(
      classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, {
        signal: AbortSignal.abort(),
        fetchImpl: async () => {
          assert.fail('must not send')
        },
      }),
      { code: 'cancelled' },
    )
    const controller = new AbortController()
    const cancelled = classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, {
      signal: controller.signal,
      fetchImpl: async () => new Promise<Response>(() => {}),
    })
    controller.abort()
    await assert.rejects(cancelled, { code: 'cancelled' })
    await assert.rejects(
      classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, {
        timeoutMs: 5,
        fetchImpl: async () => new Response(new ReadableStream()),
      }),
      { code: 'timeout' },
    )
  })
})
