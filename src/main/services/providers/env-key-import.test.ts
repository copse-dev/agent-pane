import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  importDetectedEnvKeys,
  EnvKeyImportConsentError,
  type EnvKeyImportDeps,
} from './env-key-import.ts'
import type { DetectedKey } from './env-key-detection.ts'
import { hasApiKey, deleteApiKey, setSetting } from '../storage/settings.ts'

function key(provider: string, value = `${provider}-secret`, source = '~/.zshrc'): DetectedKey {
  return { provider, envVar: `${provider.toUpperCase()}_API_KEY`, value, source }
}

function deps(overrides: Partial<EnvKeyImportDeps> = {}): EnvKeyImportDeps {
  return {
    scan: () => [key('anthropic'), key('openai')],
    hasKey: () => false,
    setKey: () => ({ ok: true }),
    consentGranted: () => true,
    ...overrides,
  }
}

describe('importDetectedEnvKeys', () => {
  it('throws the consent error and writes nothing when consent is off', () => {
    const written: string[] = []
    assert.throws(
      () =>
        importDetectedEnvKeys(
          {},
          deps({
            consentGranted: () => false,
            setKey: (provider) => {
              written.push(provider)
              return { ok: true }
            },
          }),
        ),
      EnvKeyImportConsentError,
    )
    assert.deepEqual(written, [])
  })

  it('never overwrites an already-configured provider but still imports the rest', () => {
    const written: string[] = []
    const result = importDetectedEnvKeys(
      {},
      deps({
        hasKey: (provider) => provider === 'anthropic',
        setKey: (provider) => {
          written.push(provider)
          return { ok: true }
        },
      }),
    )
    assert.deepEqual(result.skipped, [{ provider: 'anthropic', reason: 'already-configured' }])
    assert.deepEqual(
      result.imported.map((entry) => entry.provider),
      ['openai'],
    )
    assert.deepEqual(written, ['openai'])
  })

  it('reports a refused plaintext write as skipped', () => {
    const result = importDetectedEnvKeys(
      {},
      deps({ setKey: (provider) => ({ ok: provider !== 'openai' }) }),
    )
    assert.deepEqual(result.skipped, [{ provider: 'openai', reason: 'plaintext-storage-refused' }])
    assert.deepEqual(
      result.imported.map((entry) => entry.provider),
      ['anthropic'],
    )
  })

  it('with a provider filter, unlisted detections are neither imported nor skipped', () => {
    const result = importDetectedEnvKeys({ providers: ['anthropic'] }, deps({ hasKey: () => true }))
    // anthropic is considered (and skipped as configured); openai is invisible.
    assert.deepEqual(result.skipped, [{ provider: 'anthropic', reason: 'already-configured' }])
    assert.deepEqual(result.imported, [])
  })

  it('an unknown slug in the filter is inert', () => {
    const result = importDetectedEnvKeys({ providers: ['nonexistent'] }, deps())
    assert.deepEqual(result, { imported: [], skipped: [] })
  })

  it('imports carry the provider and discovery source', () => {
    const result = importDetectedEnvKeys(
      {},
      deps({ scan: () => [key('anthropic', 'sk-ant-x', 'environment')] }),
    )
    assert.deepEqual(result.imported, [{ provider: 'anthropic', source: 'environment' }])
  })

  describe('against the real settings store', () => {
    beforeEach(() => {
      deleteApiKey('anthropic')
      deleteApiKey('openai')
      setSetting('envKeyAutoDetectEnabled', true)
    })

    it('round-trips: imported keys become visible to hasApiKey', () => {
      assert.equal(hasApiKey('anthropic'), false)
      const result = importDetectedEnvKeys({}, { scan: () => [key('anthropic')] })
      assert.deepEqual(
        result.imported.map((entry) => entry.provider),
        ['anthropic'],
      )
      assert.equal(hasApiKey('anthropic'), true)
    })

    it('a no-filter call imports every importable detection (old handler behavior)', () => {
      const result = importDetectedEnvKeys({}, { scan: () => [key('anthropic'), key('openai')] })
      assert.deepEqual(result.imported.map((entry) => entry.provider).sort(), [
        'anthropic',
        'openai',
      ])
      assert.equal(hasApiKey('openai'), true)
    })

    it('honours the stored consent flag through the default deps', () => {
      setSetting('envKeyAutoDetectEnabled', false)
      assert.throws(
        () => importDetectedEnvKeys({}, { scan: () => [key('anthropic')] }),
        EnvKeyImportConsentError,
      )
      assert.equal(hasApiKey('anthropic'), false)
    })
  })
})
