import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CLASSIFIER_TEST_REQUEST,
  type ClassifierProfile,
  type ClassifierRequest,
} from '@copse/llm/classifiers/index.ts'
import { parseMachineClassifierResult } from './machine-classifier.ts'

const profile: ClassifierProfile = {
  id: 'paired-kev',
  label: 'Paired Kev',
  model: 'kev',
  timeoutMs: 5000,
  connection: {
    type: 'machine',
    machineId: '156d9a5e-9322-482d-8aa4-d4be5f21190e',
    profileId: 'kev',
  },
}
const choice = {
  type: 'choice',
  choice: 'red',
  probabilities: { red: 0.9, blue: 0.1 },
  confidence: 0.7,
}
const result = {
  model: 'kev-native',
  elapsedMs: 20,
  answers: { color: choice },
  metadata: { confidenceSemantics: 'native' },
  usage: { inputTokens: 12 },
}

test('machine results preserve typed answers and confidence while keeping the local profile identity', () => {
  const decoded = parseMachineClassifierResult(profile, CLASSIFIER_TEST_REQUEST, {
    ...result,
    profileId: 'host-profile',
    privateData: 'must not pass through',
  })
  assert.equal(decoded.profileId, 'paired-kev')
  assert.equal(decoded.requestedModel, 'kev')
  assert.equal(decoded.adapter, 'machine/systemone@1')
  assert.deepEqual(decoded.answers['color'], choice)
  assert.deepEqual(decoded.usage, { inputTokens: 12 })
  assert.deepEqual(decoded.metadata, { confidenceSemantics: 'native' })
  assert.equal(Object.hasOwn(decoded, 'privateData'), false)
  const request: ClassifierRequest = {
    state: 'fixture',
    questions: {
      allowed: { type: 'boolean', instructions: 'Allowed?' },
      quality: { type: 'score', instructions: 'Quality?', levels: ['low', 'high'] },
    },
  }
  const answers = {
    allowed: { type: 'boolean', probability: 0.6 },
    quality: {
      type: 'score',
      score: 0.8,
      levels: ['low', 'high'],
      probabilities: { '0': 0.2, '1': 0.8 },
      confidence: 0.5,
    },
  }
  assert.deepEqual(
    parseMachineClassifierResult(profile, request, { ...result, answers }).answers,
    answers,
  )
  assert.throws(
    () =>
      parseMachineClassifierResult(profile, request, {
        ...result,
        answers: { ...answers, quality: { ...answers.quality, levels: ['high', 'low'] } },
      }),
    /Invalid score/,
  )
})

test('machine results reject missing answers, wrong types, invented choices and malformed probabilities', () => {
  for (const answers of [
    {},
    { other: choice },
    { color: choice, extra: choice },
    { color: { type: 'boolean', probability: 0.9 } },
    { color: { ...choice, choice: 'invented' } },
    { color: { ...choice, probabilities: { red: 0.9, blue: 0.8 } } },
    { color: { ...choice, probabilities: { red: 0.9, invented: 0.1 } } },
    { color: { ...choice, confidence: 2 } },
    { color: { ...choice, probabilities: { red: -1, blue: 2 } } },
  ])
    assert.throws(() =>
      parseMachineClassifierResult(profile, CLASSIFIER_TEST_REQUEST, { ...result, answers }),
    )
})
