import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeHarborTuning,
  decodeHarborWorkerTuning,
  harborTuningSchema,
  hostTuningOf,
  workerTuningOf,
} from './harbor-tuning.mts'

describe('Harbor benchmark tuning schema', () => {
  it('accepts every supported key', () => {
    const tuning = decodeHarborTuning(
      JSON.stringify({
        loopLimits: { maxSteps: 100, maxLlmCalls: 100, adaptiveExtensions: false },
        reasoningRecoveryMaxTokens: 8192,
        modelParametersMode: 'server',
        sampling: {
          temperature: 0.6,
          topP: 0.95,
          topK: 20,
          minP: 0,
          presencePenalty: 1,
          repetitionPenalty: 1.05,
          maxOutputTokens: 16384,
        },
        contextWindow: 131072,
      }),
    )
    assert.ok(tuning)
    assert.equal(tuning.loopLimits?.maxSteps, 100)
    assert.equal(tuning.sampling?.presencePenalty, 1)
  })

  it('accepts the empty tuning', () => {
    assert.deepEqual(decodeHarborTuning('{}'), {})
  })

  it('rejects unknown keys at every level', () => {
    assert.equal(decodeHarborTuning('{"reasoningCheckpointInterval":1024}'), null)
    assert.equal(decodeHarborTuning('{"loopLimits":{"maxTurns":3}}'), null)
    assert.equal(decodeHarborTuning('{"sampling":{"seed":1}}'), null)
  })

  it('rejects bad values', () => {
    for (const bad of [
      '{"loopLimits":{"maxSteps":0}}',
      '{"loopLimits":{"maxSteps":1.5}}',
      '{"loopLimits":{"adaptiveExtensions":"no"}}',
      '{"reasoningRecoveryMaxTokens":-1}',
      '{"reasoningRecoveryMaxTokens":"4096"}',
      '{"sampling":{"temperature":-0.1}}',
      '{"sampling":{"temperature":3}}',
      '{"sampling":{"topP":0}}',
      '{"sampling":{"topK":2.5}}',
      '{"sampling":{"presencePenalty":9}}',
      '{"modelParametersMode":"auto"}',
      '{"contextWindow":0}',
      '[]',
      'null',
      'not json',
    ]) {
      assert.equal(decodeHarborTuning(bad), null, bad)
    }
  })

  it('the worker schema refuses host-only keys', () => {
    assert.deepEqual(decodeHarborWorkerTuning('{"reasoningRecoveryMaxTokens":8192}'), {
      reasoningRecoveryMaxTokens: 8192,
    })
    assert.equal(decodeHarborWorkerTuning('{"sampling":{"temperature":1}}'), null)
    assert.equal(decodeHarborWorkerTuning('{"contextWindow":4096}'), null)
  })

  it('splits a tuning into the worker slice and the host slice without losing a key', () => {
    const tuning = harborTuningSchema.parse({
      loopLimits: { maxSteps: 50 },
      reasoningRecoveryMaxTokens: 12288,
      sampling: { temperature: 1 },
      contextWindow: 65536,
      modelParametersMode: 'client',
    })
    const worker = workerTuningOf(tuning)
    const host = hostTuningOf(tuning)
    assert.deepEqual(worker, { loopLimits: { maxSteps: 50 }, reasoningRecoveryMaxTokens: 12288 })
    assert.deepEqual(host, {
      sampling: { temperature: 1 },
      contextWindow: 65536,
      modelParametersMode: 'client',
    })
    assert.deepEqual({ ...worker, ...host }, tuning)
    assert.equal(decodeHarborWorkerTuning(JSON.stringify(worker))?.loopLimits?.maxSteps, 50)
  })
})
