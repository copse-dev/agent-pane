import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSuppressedByNewerVersion, debugSuppressedModels } from './model-version-suppression.ts'

describe('model-version-suppression', () => {
  describe('isSuppressedByNewerVersion', () => {
    it('suppresses older Claude Opus versions when newer ones exist', () => {
      assert.strictEqual(isSuppressedByNewerVersion('claude-opus-4-8'), true)
      assert.strictEqual(isSuppressedByNewerVersion('claude-opus-5'), true)
      assert.strictEqual(isSuppressedByNewerVersion('claude-opus-5-5'), false)
    })

    it('suppresses older Claude Sonnet versions when newer ones exist', () => {
      assert.strictEqual(isSuppressedByNewerVersion('claude-sonnet-4-6'), true)
      assert.strictEqual(isSuppressedByNewerVersion('claude-sonnet-5'), true)
      assert.strictEqual(isSuppressedByNewerVersion('claude-sonnet-5-5'), false)
    })

    it('suppresses older Claude Fable versions when newer ones exist', () => {
      assert.strictEqual(isSuppressedByNewerVersion('claude-fable-5'), true)
      assert.strictEqual(isSuppressedByNewerVersion('claude-fable-5-1'), false)
    })

    it('does not suppress newer Claude Haiku (only one version tracked)', () => {
      assert.strictEqual(isSuppressedByNewerVersion('claude-haiku-4-5'), false)
    })

    it('suppresses older GPT-5.x versions when GPT-5.6 exists', () => {
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5'), true)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5-mini'), true)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5-nano'), true)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5.5'), true)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5.6-sol'), false)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5.6-terra'), false)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5.6-luna'), false)
    })

    it('suppresses older GPT-6 variants', () => {
      assert.strictEqual(isSuppressedByNewerVersion('gpt-6-astra'), true)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-6.1-sol'), false)
    })

    it('keeps all GPT-4o variants (single generation)', () => {
      assert.strictEqual(isSuppressedByNewerVersion('gpt-4o'), false)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-4o-mini'), false)
    })

    it('keeps variants of the same version', () => {
      // All GPT-5.6 variants are kept (no version difference)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5.6-sol'), false)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5.6-terra'), false)
      assert.strictEqual(isSuppressedByNewerVersion('gpt-5.6-luna'), false)
    })

    it('handles unknown models gracefully', () => {
      assert.strictEqual(isSuppressedByNewerVersion('unknown-model'), false)
      assert.strictEqual(isSuppressedByNewerVersion('llama-2'), false)
    })

    it('handles namespaced models (ignores namespace for suppression)', () => {
      // Suppression is based only on the base model ID
      assert.strictEqual(isSuppressedByNewerVersion('openrouter:claude-opus-5'), false)
      assert.strictEqual(isSuppressedByNewerVersion('lmstudio:something'), false)
    })
  })

  describe('debugSuppressedModels', () => {
    it('returns list of suppressed models with reasons', () => {
      const suppressed = debugSuppressedModels()
      assert.ok(suppressed.length > 0)

      const opusSuppressed = suppressed.filter((m) => m.family === 'claude-opus')
      assert.strictEqual(opusSuppressed.length, 2) // 4.8 and 5 are suppressed
      assert.deepStrictEqual(
        opusSuppressed.map((m) => m.model).sort(),
        ['claude-opus-4-8', 'claude-opus-5'],
      )

      const sonnetSuppressed = suppressed.filter((m) => m.family === 'claude-sonnet')
      assert.strictEqual(sonnetSuppressed.length, 2) // 4.6 and 5 are suppressed
      assert.deepStrictEqual(
        sonnetSuppressed.map((m) => m.model).sort(),
        ['claude-sonnet-4-6', 'claude-sonnet-5'],
      )

      const gpt5Suppressed = suppressed.filter((m) => m.family === 'gpt-5')
      assert.ok(gpt5Suppressed.length > 0) // All GPT-5.x except 5.6 are suppressed
      assert.ok(
        gpt5Suppressed.map((m) => m.model).includes('gpt-5.5'),
        'gpt-5.5 should be suppressed',
      )
    })
  })
})
