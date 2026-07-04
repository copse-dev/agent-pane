import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  getResolvedExtraProviders,
  getResolvedExtraProvider,
  saveExtraProvider,
  deleteExtraProvider,
} from './extra-providers-store.ts'
import { setSetting, setApiKey, hasApiKey } from './storage/settings.ts'
import { BUILTIN_EXTRA_PROVIDER_SLUGS } from '@shared/llm/extra-providers.ts'

const slugs = (): string[] => getResolvedExtraProviders().map((p) => p.id)
const PRESETS = [...BUILTIN_EXTRA_PROVIDER_SLUGS]

describe('extra-providers-store', () => {
  beforeEach(async () => {
    await setSetting('extraProviders', [])
  })

  it('resolves the shipped presets when nothing is stored', () => {
    const providers = getResolvedExtraProviders()
    assert.deepEqual(slugs(), PRESETS)
    assert.ok(providers.every((p) => p.builtin))
  })

  it('derives a slug from the base URL when none is given', async () => {
    await saveExtraProvider({ label: 'Together AI', baseUrl: 'https://api.together.xyz/v1' })
    const together = getResolvedExtraProvider('together')
    assert.ok(together)
    assert.equal(together.builtin, false)
    assert.equal(together.label, 'Together AI')
    assert.equal(together.prefix, 'together:')
  })

  it('disambiguates a second provider on the same host instead of clobbering', async () => {
    await saveExtraProvider({ baseUrl: 'https://api.together.xyz/v1' })
    await saveExtraProvider({ baseUrl: 'https://api.together.xyz/v1' })
    assert.deepEqual(slugs(), [...PRESETS, 'together', 'together-2'])
  })

  it('treats an explicit slug as an in-place edit (the frozen slug)', async () => {
    await saveExtraProvider({
      slug: 'together',
      baseUrl: 'https://api.together.xyz/v1',
      label: 'A',
    })
    await saveExtraProvider({
      slug: 'together',
      baseUrl: 'https://api.together.xyz/v1',
      label: 'B',
    })
    assert.equal(slugs().filter((s) => s === 'together').length, 1)
    assert.equal(getResolvedExtraProvider('together')?.label, 'B')
  })

  it('stores a built-in slug as an override, not a fourth provider', async () => {
    await saveExtraProvider({ slug: 'mistral', includeUsage: false, fallbackContextWindow: 4096 })
    assert.equal(getResolvedExtraProviders().length, PRESETS.length)
    const mistral = getResolvedExtraProvider('mistral')
    assert.ok(mistral)
    assert.equal(mistral.label, 'Mistral') // locked
    assert.equal(mistral.baseUrl, 'https://api.mistral.ai/v1') // locked
    assert.equal(mistral.includeUsage, false) // overridden
    assert.equal(mistral.fallbackContextWindow, 4096) // overridden
  })

  it('deletes a custom provider and its stored key', async () => {
    await saveExtraProvider({ slug: 'together', baseUrl: 'https://api.together.xyz/v1' })
    setApiKey('together', 'sk-secret')
    assert.ok(hasApiKey('together'))

    await deleteExtraProvider('together')
    assert.deepEqual(slugs(), PRESETS)
    assert.equal(hasApiKey('together'), false)
  })

  it('reverts a built-in override on delete but keeps its key', async () => {
    await saveExtraProvider({ slug: 'mistral', includeUsage: false })
    setApiKey('mistral', 'sk-mistral')
    assert.equal(getResolvedExtraProvider('mistral')?.includeUsage, false)

    await deleteExtraProvider('mistral')
    assert.equal(getResolvedExtraProvider('mistral')?.includeUsage, true) // back to shipped default
    assert.ok(hasApiKey('mistral')) // key preserved
  })
})
