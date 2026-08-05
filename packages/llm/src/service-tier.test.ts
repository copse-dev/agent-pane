import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { serviceTierBody } from './service-tier.ts'

describe('serviceTierBody', () => {
  it('adds nothing when no tier is configured', () => {
    assert.deepEqual(serviceTierBody(undefined), {})
    // Spreading the empty result must leave a request untouched.
    assert.deepEqual({ model: 'gpt-5', ...serviceTierBody(undefined) }, { model: 'gpt-5' })
  })

  it('treats an empty string as unset rather than sending service_tier: ""', () => {
    // OpenAI rejects a blank tier, so a cleared setting must omit the field.
    assert.deepEqual(serviceTierBody(''), {})
  })

  it('emits the tier verbatim', () => {
    assert.deepEqual(serviceTierBody('flex'), { service_tier: 'flex' })
    assert.deepEqual(serviceTierBody('priority'), { service_tier: 'priority' })
  })

  it('passes through a tier the SDK union does not know', () => {
    // `fast` is what llm 0.32 documents, and it is absent from the installed
    // SDK's `"scale" | "default" | "auto" | "flex" | "priority"` union. Pinning
    // to that union would reject tiers the API already accepts.
    assert.deepEqual(serviceTierBody('fast'), { service_tier: 'fast' })
  })
})
