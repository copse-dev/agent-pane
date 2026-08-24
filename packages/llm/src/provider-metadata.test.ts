import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_DATA_POLICIES,
  PROVIDER_METADATA_LAST_VERIFIED,
  PROVIDER_PRESETS,
} from './provider-metadata.ts'
import { BUILTIN_EXTRA_PROVIDERS, isLocalBaseUrl } from './extra-providers.ts'
import { dataPolicyForProvider } from './data-policies.ts'

// The catalog is validated by zod at import time, so a malformed edit fails the
// whole suite before it reaches these cases. What is left to check are the
// rules zod cannot express: cross-entry uniqueness, the safety floor for a
// hosted endpoint, and the fields that must stay derived rather than data.

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated: string[] = []
  for (const value of values) {
    if (seen.has(value)) repeated.push(value)
    seen.add(value)
  }
  return repeated
}

describe('provider catalog', () => {
  it('loads with a verification date and both sections populated', () => {
    assert.match(PROVIDER_METADATA_LAST_VERIFIED, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(PROVIDER_PRESETS.length > 0)
    assert.ok(PROVIDER_DATA_POLICIES.length > 0)
  })

  it('keeps preset ids, policy slugs and policy hosts unique', () => {
    assert.deepEqual(duplicates(PROVIDER_PRESETS.map((p) => p.id)), [])
    assert.deepEqual(duplicates(PROVIDER_DATA_POLICIES.flatMap((p) => p.slugs)), [])
    assert.deepEqual(duplicates(PROVIDER_DATA_POLICIES.flatMap((p) => p.hosts ?? [])), [])
  })

  it('drops the catalog comments rather than shipping them as data', () => {
    for (const preset of PROVIDER_PRESETS) {
      assert.ok(!('comment' in preset), `${preset.id} leaked its comment into the runtime shape`)
      for (const model of preset.models) assert.ok(!('comment' in model))
    }
    for (const policy of PROVIDER_DATA_POLICIES) assert.ok(!('comment' in policy))
  })
})

describe('provider catalog: safety floor for a hosted preset', () => {
  it('requires https and a data policy for every non-loopback endpoint', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (isLocalBaseUrl(preset.baseUrl)) continue
      // A hosted preset carries an API key over the wire and shows a privacy
      // badge, so plaintext http and a missing policy are both bugs: without a
      // policy Settings would quietly read "Data policy unknown".
      assert.ok(preset.baseUrl.startsWith('https://'), `${preset.id} must use https`)
      assert.ok(dataPolicyForProvider(preset), `${preset.id} has no data policy`)
    }
  })

  it('does not take an API key from the environment for a local server', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (!isLocalBaseUrl(preset.baseUrl)) continue
      assert.equal(preset.envVar, undefined, `${preset.id} is local and needs no env key`)
    }
  })
})

describe('provider catalog: derived fields stay derived', () => {
  // `local` decides whether Settings tells the user data leaves the machine, so
  // it is computed from the base URL rather than read from the catalog — and
  // the strict schema rejects a catalog that tries to set it.
  it('computes local/prefix/builtin in code, not from data', () => {
    for (const provider of BUILTIN_EXTRA_PROVIDERS) {
      assert.equal(provider.local, isLocalBaseUrl(provider.baseUrl))
      assert.equal(provider.prefix, `${provider.id}:`)
      assert.equal(provider.builtin, true)
    }
  })

  it('preserves catalog order, so the picker and local-server chips do not reshuffle', () => {
    assert.deepEqual(
      BUILTIN_EXTRA_PROVIDERS.map((p) => p.id),
      PROVIDER_PRESETS.map((p) => p.id),
    )
  })

  it('keeps the xAI policy host-only, so grok model-id resolution is unchanged', () => {
    assert.equal(dataPolicyForProvider({ id: 'xai' }), null)
    assert.ok(dataPolicyForProvider({ id: 'custom', baseUrl: 'https://api.x.ai/v1' }))
  })
})
