import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  DEFAULT_HARBOR_CONTEXT_WINDOW,
  assertNoStepLimitConflict,
  buildAppliedTuning,
  parseTuningText,
  readTuningFile,
  resolveHostTuning,
  tuningFromEnvValue,
  workerTuningFileText,
} from './harbor-tuning-host.mts'

const MODEL = 'qwen3.6-35b-a3b'

describe('Harbor tuning, host side', () => {
  it('without a tuning, resolves what the driver did before tunings existed', () => {
    const resolved = resolveHostTuning({
      tuning: null,
      model: MODEL,
      specMaxSteps: null,
      contextWindowFlag: DEFAULT_HARBOR_CONTEXT_WINDOW,
    })
    assert.equal(resolved.record.mode, 'client')
    assert.equal(resolved.record.params.presencePenalty, 1.5)
    assert.equal(resolved.contextWindow, DEFAULT_HARBOR_CONTEXT_WINDOW)
  })

  it('server mode sends nothing, and sampling overrides land on top of the base', () => {
    const resolved = resolveHostTuning({
      tuning: parseTuningText(
        JSON.stringify({
          modelParametersMode: 'server',
          sampling: { temperature: 0.6, presencePenalty: 1, maxOutputTokens: 8192 },
          contextWindow: 65536,
        }),
        'test',
      ),
      model: MODEL,
      specMaxSteps: null,
      contextWindowFlag: DEFAULT_HARBOR_CONTEXT_WINDOW,
    })
    assert.deepEqual(resolved.record.params, {
      maxOutputTokens: 8192,
      temperature: 0.6,
      presencePenalty: 1,
    })
    assert.equal(resolved.record.outputCeiling, 8192)
    assert.equal(resolved.contextWindow, 65536)
  })

  it('server mode with no sampling overrides sends no sampling fields', () => {
    const resolved = resolveHostTuning({
      tuning: parseTuningText('{"modelParametersMode":"server"}', 'test'),
      model: MODEL,
      specMaxSteps: null,
      contextWindowFlag: 1000,
    })
    assert.deepEqual(resolved.record.params, {})
  })

  it('client mode lets a sampling override replace one recipe field and keeps the rest', () => {
    const resolved = resolveHostTuning({
      tuning: parseTuningText(JSON.stringify({ sampling: { temperature: 0.6 } }), 'test'),
      model: MODEL,
      specMaxSteps: null,
      contextWindowFlag: 1000,
    })
    assert.equal(resolved.record.params.temperature, 0.6)
    assert.equal(resolved.record.params.presencePenalty, 1.5)
    assert.equal(resolved.contextWindow, 1000)
  })

  it('refuses a step limit set twice', () => {
    const tuning = parseTuningText('{"loopLimits":{"maxSteps":100}}', 'test')
    assert.throws(() => {
      assertNoStepLimitConflict(tuning, 50)
    }, /use only one/)
    assert.doesNotThrow(() => {
      assertNoStepLimitConflict(tuning, null)
    })
    assert.doesNotThrow(() => {
      assertNoStepLimitConflict(null, 50)
    })
  })

  it('rejects an invalid tuning with a message naming the source', () => {
    assert.throws(
      () => parseTuningText('{"bogus":1}', 'tuning.json'),
      /tuning\.json is not a valid/,
    )
  })

  it('reads COPSE_HARBOR_TUNING as JSON or @path, and treats unset as none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuning-host-'))
    try {
      const path = join(dir, 't.json')
      writeFileSync(path, '{"reasoningRecoveryMaxTokens":8192}')
      assert.deepEqual(tuningFromEnvValue(`@${path}`), { reasoningRecoveryMaxTokens: 8192 })
      assert.deepEqual(readTuningFile(path), { reasoningRecoveryMaxTokens: 8192 })
      assert.deepEqual(tuningFromEnvValue('{"contextWindow":4096}'), { contextWindow: 4096 })
      assert.equal(tuningFromEnvValue(undefined), null)
      assert.equal(tuningFromEnvValue('  '), null)
      assert.throws(() => tuningFromEnvValue('{"nope":1}'))
      assert.throws(() => tuningFromEnvValue(`@${join(dir, 'missing.json')}`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes only the worker keys into the container file', () => {
    const tuning = parseTuningText(
      '{"reasoningRecoveryMaxTokens":8192,"sampling":{"temperature":1},"contextWindow":4096}',
      'test',
    )
    const written: unknown = JSON.parse(workerTuningFileText(tuning))
    assert.deepEqual(written, { reasoningRecoveryMaxTokens: 8192 })
  })

  it('records the applied tuning with the worker report merged in', () => {
    const tuning = parseTuningText('{"reasoningRecoveryMaxTokens":8192}', 'test')
    const resolved = resolveHostTuning({
      tuning,
      model: MODEL,
      specMaxSteps: null,
      contextWindowFlag: 1000,
    })
    const applied = buildAppliedTuning({
      tuning,
      resolved,
      specMaxSteps: null,
      workerAppliedText: '{"effective":{"reasoningRecoveryMaxTokens":8192}}',
    })
    assert.deepEqual(applied.requested, tuning)
    assert.equal(applied.host.contextWindow, 1000)
    assert.deepEqual(applied.worker, { effective: { reasoningRecoveryMaxTokens: 8192 } })
    assert.equal(
      buildAppliedTuning({ tuning: null, resolved, specMaxSteps: null, workerAppliedText: null })
        .worker,
      null,
    )
  })
})
