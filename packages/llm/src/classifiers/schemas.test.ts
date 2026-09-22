import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { safeJsonParse } from '@copse/std/safe-json.ts'
import { classifierProfileSchema, classifierRequestSchema } from './schemas.ts'
import { CLASSIFIER_PRESETS, CLASSIFIER_TEST_REQUEST, classifierCredentialId } from './presets.ts'

describe('classifier schemas and presets', () => {
  it('validates presets, isolates credentials, and forbids hidden profile fields', () => {
    for (const profile of CLASSIFIER_PRESETS) {
      assert.equal(classifierProfileSchema.safeParse(profile).success, true)
      assert.equal(classifierCredentialId(profile.id), `classifier-${profile.id}`)
      assert.equal(
        classifierProfileSchema.safeParse({ ...profile, apiKey: 'secret' }).success,
        false,
      )
    }
    assert.equal(classifierCredentialId('a'.repeat(53)).length, 64)
    assert.throws(() => classifierCredentialId('a'.repeat(54)))
    assert.throws(() => classifierCredentialId('../typesafe'))
  })

  it('rejects malformed JSON state, prototype keys, cycles, deep nesting, and oversized requests', () => {
    assert.equal(classifierRequestSchema.safeParse(CLASSIFIER_TEST_REQUEST).success, true)
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    let deep: unknown = 'leaf'
    for (let i = 0; i < 40; i++) deep = { nested: deep }
    for (const state of [
      NaN,
      Infinity,
      { bad: undefined },
      { bad: (): boolean => true },
      new Date(),
      circular,
      deep,
      'x'.repeat(1_048_577),
      safeJsonParse('{"nested":{"__proto__":1}}'),
    ]) {
      assert.equal(
        classifierRequestSchema.safeParse({ ...CLASSIFIER_TEST_REQUEST, state }).success,
        false,
      )
    }
    assert.equal(
      classifierRequestSchema.safeParse({
        ...CLASSIFIER_TEST_REQUEST,
        questions: safeJsonParse('{"__proto__":{"type":"boolean","instructions":"ok"}}'),
      }).success,
      false,
    )
  })

  it('validates SemIf executable as a specific scorer instead of a shell command', () => {
    const profile = CLASSIFIER_PRESETS.find((entry) => entry.id === 'semif')
    assert.ok(profile)
    for (const executable of ['sh', 'semif-score --unsafe', './semif-score', '/usr/bin/python']) {
      assert.equal(
        classifierProfileSchema.safeParse({
          ...profile,
          connection: { ...profile.connection, executable },
        }).success,
        false,
      )
    }
    for (const executable of [
      'semif-score',
      '/usr/local/bin/semif-score',
      'C:\\Python\\Scripts\\semif-score.exe',
    ]) {
      assert.equal(
        classifierProfileSchema.safeParse({
          ...profile,
          connection: { ...profile.connection, executable },
        }).success,
        true,
      )
    }
  })

  it('requires a pinned Hub revision or absolute local model, and local GGUF for llamacpp', () => {
    const profile = CLASSIFIER_PRESETS.find((entry) => entry.id === 'semif')
    assert.ok(profile)
    const unpinned = { ...profile, connection: { ...profile.connection, revision: 'main' } }
    assert.equal(classifierProfileSchema.safeParse(unpinned).success, false)
    assert.equal(
      classifierProfileSchema.safeParse({ ...unpinned, model: '/models/local-semif' }).success,
      true,
    )
    assert.equal(
      classifierProfileSchema.safeParse({ ...profile, model: './relative-model' }).success,
      false,
    )
    assert.equal(
      classifierProfileSchema.safeParse({
        ...profile,
        connection: { ...profile.connection, backend: 'llamacpp' },
      }).success,
      false,
    )
    assert.equal(
      classifierProfileSchema.safeParse({
        ...profile,
        connection: { ...profile.connection, backend: 'llamacpp', gguf: '/models/model.gguf' },
      }).success,
      true,
    )
    assert.equal(
      classifierProfileSchema.safeParse({
        ...profile,
        connection: { ...profile.connection, gguf: '/models/model.gguf' },
      }).success,
      false,
    )
  })
})
