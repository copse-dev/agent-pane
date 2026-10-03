import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeProviderDescription } from './provider-description.ts'

describe('decodeProviderDescription verbosity', () => {
  const base = { kind: 'openai', model: 'gpt-5', apiKeySlug: 'openai' }
  const rest = { serviceTier: null, forceChatCompletions: false }

  it('accepts a tuned verbosity so a container turn can build its provider', () => {
    const decoded = decodeProviderDescription({ ...base, params: { verbosity: 'low' }, ...rest })
    assert.deepEqual(decoded?.params, { verbosity: 'low' })
  })

  it('still rejects an unknown verbosity level', () => {
    assert.equal(
      decodeProviderDescription({ ...base, params: { verbosity: 'loud' }, ...rest }),
      null,
    )
  })
})
