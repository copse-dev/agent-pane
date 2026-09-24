import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyBatch } from './index.ts'
import { classifyHttp } from './http.ts'
import { CLASSIFIER_PRESETS, CLASSIFIER_TEST_REQUEST } from './presets.ts'
import { classifierProfileSchema, classifierRequestSchema } from './schemas.ts'
import { parseClassifierBatch, parseClassifierRequests } from './validation.ts'
import { runValidatedClassifierBatch } from './validated.ts'
import type { ClassifierProfile, ClassifierRequest } from './types.ts'

function profile(id = 'kev'): ClassifierProfile {
  const found = CLASSIFIER_PRESETS.find((entry) => entry.id === id)
  assert.ok(found)
  return found
}

const fetchFixture: typeof fetch = async () =>
  Response.json({
    model: 'fixture',
    answers: { color: { type: 'choice', choice: 'red', probabilities: { red: 0.9, blue: 0.1 } } },
  })

test('public batch parses each profile and request once before invoking transports', async (context) => {
  const profiles = context.mock.method(
    classifierProfileSchema,
    'safeParse',
    classifierProfileSchema.safeParse.bind(classifierProfileSchema),
  )
  const requests = context.mock.method(
    classifierRequestSchema,
    'safeParse',
    classifierRequestSchema.safeParse.bind(classifierRequestSchema),
  )
  const results = await classifyBatch(
    profile(),
    [CLASSIFIER_TEST_REQUEST, CLASSIFIER_TEST_REQUEST],
    { fetchImpl: fetchFixture },
  )
  assert.equal(results.length, 2)
  assert.equal(profiles.mock.callCount(), 1)
  assert.equal(requests.mock.callCount(), 2)
})

test('standalone HTTP entry point retains one complete validation boundary', async (context) => {
  const profiles = context.mock.method(
    classifierProfileSchema,
    'safeParse',
    classifierProfileSchema.safeParse.bind(classifierProfileSchema),
  )
  const requests = context.mock.method(
    classifierRequestSchema,
    'safeParse',
    classifierRequestSchema.safeParse.bind(classifierRequestSchema),
  )
  await classifyHttp(profile(), CLASSIFIER_TEST_REQUEST, { fetchImpl: fetchFixture })
  assert.equal(profiles.mock.callCount(), 1)
  assert.equal(requests.mock.callCount(), 1)
})

test('invalid later requests and protocol limits reject an entire batch before the first call', async () => {
  const fetchImpl: typeof fetch = async () => {
    assert.fail('No request should be sent')
  }
  const overLimit: ClassifierRequest = {
    state: 'Fixture',
    questions: {
      score: {
        type: 'score',
        instructions: 'Rate',
        levels: Array.from({ length: 11 }, (_, index) => String(index)),
      },
    },
  }
  for (const invalid of [{ state: '', questions: {} }, overLimit]) {
    await assert.rejects(
      classifyBatch(profile(), [CLASSIFIER_TEST_REQUEST, invalid], { fetchImpl }),
      { code: 'invalid-request' },
    )
  }
})

test('validated dispatch accepts host-redacted copies without repeating schema walks', async (context) => {
  const original: ClassifierProfile = { ...profile(), label: ' Padded label ', model: ' fixture ' }
  const parsed = parseClassifierBatch(original, [CLASSIFIER_TEST_REQUEST])
  assert.equal(parsed.profile.label, 'Padded label')
  assert.equal(original.label, ' Padded label ')
  assert.notEqual(parsed.requests[0], CLASSIFIER_TEST_REQUEST)
  context.mock.method(classifierProfileSchema, 'safeParse', () => {
    assert.fail('Profile was already validated')
  })
  context.mock.method(classifierRequestSchema, 'safeParse', () => {
    assert.fail('Request was already validated')
  })
  const requests = parsed.requests.map((request) => ({ ...request, state: '[REDACTED_SECRET]' }))
  const results = await runValidatedClassifierBatch(parsed.profile, requests, {
    fetchImpl: fetchFixture,
  })
  assert.equal(results[0]?.requestedModel, 'fixture')
})

test('saved sessions validate new request batches without reparsing the selected profile', (context) => {
  const parsed = parseClassifierBatch(profile(), [])
  context.mock.method(classifierProfileSchema, 'safeParse', () => {
    assert.fail('Session profile was already validated')
  })
  const requests = context.mock.method(
    classifierRequestSchema,
    'safeParse',
    classifierRequestSchema.safeParse.bind(classifierRequestSchema),
  )
  assert.equal(parseClassifierRequests(parsed.profile, [CLASSIFIER_TEST_REQUEST]).length, 1)
  assert.equal(requests.mock.callCount(), 1)
  assert.throws(() => parseClassifierRequests(parsed.profile, [{ state: '', questions: {} }]), {
    code: 'invalid-request',
  })
})
