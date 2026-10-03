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

  it('accepts an object shared by several questions, which is not a cycle', () => {
    const options = { yes: 'it applies', no: 'it does not' }
    const shared = {
      state: 'text',
      questions: {
        first: { type: 'choice', instructions: 'First?', options },
        second: { type: 'choice', instructions: 'Second?', options },
      },
    }
    assert.equal(classifierRequestSchema.safeParse(shared).success, true)
    const leaf = { kind: 'leaf' }
    assert.equal(
      classifierRequestSchema.safeParse({
        ...CLASSIFIER_TEST_REQUEST,
        state: { a: leaf, b: [leaf, { again: leaf }] },
      }).success,
      true,
    )
  })

  it('still rejects a cycle nested below shared objects', () => {
    const inner: Record<string, unknown> = { kind: 'inner' }
    const outer = { first: inner, second: inner }
    inner['back'] = outer
    assert.equal(
      classifierRequestSchema.safeParse({ ...CLASSIFIER_TEST_REQUEST, state: outer }).success,
      false,
    )
  })

  it('counts every visit to a shared object towards the size limits', () => {
    // 15 levels of a two-way shared node is one object but 2^16 - 1 visits,
    // past the 20,000-node budget.
    let shared: unknown = 'leaf'
    for (let i = 0; i < 15; i++) shared = { left: shared, right: shared }
    assert.equal(
      classifierRequestSchema.safeParse({ ...CLASSIFIER_TEST_REQUEST, state: shared }).success,
      false,
    )
    // Shared text counts once per reference: 3 × 400,000 characters is over the limit.
    const big = 'x'.repeat(400_000)
    assert.equal(
      classifierRequestSchema.safeParse({
        ...CLASSIFIER_TEST_REQUEST,
        state: [big, big, big],
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
