import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  PROVIDER_DATA_POLICIES,
  PROVIDER_METADATA_LAST_VERIFIED,
  PROVIDER_PRESETS,
} from './provider-metadata.ts'
import { BUILTIN_EXTRA_PROVIDERS, isLocalBaseUrl } from './extra-providers.ts'
import { RESERVED_PROVIDER_SLUGS } from './provider-slug.ts'

// The loader is the enforcement point: zod parses the catalog at import (strict
// schemas, credential-URL floor on baseUrl, hosted-preset-must-have-policy),
// so a malformed edit fails the whole suite before these cases run. What is
// left to check here are cross-file invariants the loader cannot see.

function assertUnique(values: readonly string[], what: string): void {
  assert.deepEqual([...new Set(values)], values, `duplicate ${what} in the catalog`)
}

// Minimal schema for reading the raw file back in tests — loose on purpose
// (the loader owns strictness); it only types what these tests touch.
const record = z.record(z.string(), z.unknown())
const rawSchema = z.looseObject({
  lastVerified: z.string(),
  presets: z.array(record),
  dataPolicies: z.array(record),
})

function rawCatalog(): z.infer<typeof rawSchema> {
  return rawSchema.parse(
    JSON.parse(
      readFileSync(resolve(process.cwd(), 'packages/llm/data/provider-metadata.json'), 'utf8'),
    ),
  )
}

function strip(entry: Record<string, unknown>): Record<string, unknown> {
  const { comment: _comment, ...rest } = entry
  return rest
}

describe('provider catalog', () => {
  it('loads with a verification date and both sections populated', () => {
    assert.match(PROVIDER_METADATA_LAST_VERIFIED, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(PROVIDER_PRESETS.length > 0)
    assert.ok(PROVIDER_DATA_POLICIES.length > 0)
  })

  it('keeps preset ids, policy slugs and policy hosts unique', () => {
    assertUnique(
      PROVIDER_PRESETS.map((p) => p.id),
      'preset id',
    )
    assertUnique(
      PROVIDER_DATA_POLICIES.flatMap((p) => p.slugs),
      'policy slug',
    )
    assertUnique(
      PROVIDER_DATA_POLICIES.flatMap((p) => p.hosts ?? []),
      'policy host',
    )
  })

  it('ships every catalog field except comments (nothing silently dropped)', () => {
    // The loader strips `comment` with a destructure-rest; this guards the
    // whole projection: every other authored field must reach the runtime
    // arrays verbatim, so a future schema field can never be silently lost.
    assert.deepEqual(
      PROVIDER_PRESETS,
      rawCatalog().presets.map((preset) => ({
        ...strip(preset),
        models: z.array(record).parse(preset['models']).map(strip),
      })),
    )
    assert.deepEqual(PROVIDER_DATA_POLICIES, rawCatalog().dataPolicies.map(strip))
    assert.equal(PROVIDER_METADATA_LAST_VERIFIED, rawCatalog().lastVerified)
  })
})

describe('provider catalog: cross-file invariants', () => {
  it('reserves every preset id, so user customs can never collide with a preset', () => {
    // RESERVED_PROVIDER_SLUGS cannot import the catalog (it sits below it in
    // the module layering), so this parity check is what keeps a JSON-added
    // preset from silently sharing apiKey.<slug> with an existing custom.
    for (const preset of PROVIDER_PRESETS) {
      assert.ok(
        RESERVED_PROVIDER_SLUGS.includes(preset.id),
        `preset '${preset.id}' is missing from RESERVED_PROVIDER_SLUGS (provider-slug.ts)`,
      )
    }
  })

  it('rejects a catalog that tries to set the derived fields', () => {
    // `local` decides whether Settings tells the user data leaves the machine;
    // `prefix`/`builtin` are identity. They are computed in extra-providers.ts
    // and the strict schema is what stops data from overriding them.
    for (const provider of BUILTIN_EXTRA_PROVIDERS) {
      assert.equal(provider.local, isLocalBaseUrl(provider.baseUrl))
      assert.equal(provider.prefix, `${provider.id}:`)
      assert.equal(provider.builtin, true)
    }
    for (const derived of ['local', 'prefix', 'builtin']) {
      for (const preset of rawCatalog().presets) {
        assert.ok(!(derived in preset), `catalog must not author '${derived}'`)
      }
    }
  })
})
