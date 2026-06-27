import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  providerSlugFromBaseUrl,
  uniqueProviderSlug,
  RESERVED_PROVIDER_SLUGS,
} from './provider-slug.ts'

describe('providerSlugFromBaseUrl', () => {
  it('uses the primary domain label, dropping a leading api./www.', () => {
    assert.equal(providerSlugFromBaseUrl('https://api.mistral.ai/v1'), 'mistral')
    assert.equal(providerSlugFromBaseUrl('https://api.deepseek.com'), 'deepseek')
    assert.equal(providerSlugFromBaseUrl('https://www.openai.com/v1'), 'openai')
    assert.equal(providerSlugFromBaseUrl('https://openrouter.ai/api/v1'), 'openrouter')
  })

  it('slugs loopback and IP hosts whole (no domain-label logic)', () => {
    assert.equal(providerSlugFromBaseUrl('http://localhost:1234/v1'), 'localhost')
    assert.equal(providerSlugFromBaseUrl('http://127.0.0.1:8080/v1'), '127-0-0-1')
  })

  it('predicts googleapis for the Gemini compatibility host (editable default)', () => {
    assert.equal(
      providerSlugFromBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'),
      'googleapis',
    )
  })

  it('is deterministic for the same host regardless of path', () => {
    assert.equal(
      providerSlugFromBaseUrl('https://api.together.xyz/v1'),
      providerSlugFromBaseUrl('https://api.together.xyz/v1/chat'),
    )
  })

  it('returns empty for an unparseable URL', () => {
    assert.equal(providerSlugFromBaseUrl('not a url'), '')
    assert.equal(providerSlugFromBaseUrl(''), '')
  })
})

describe('uniqueProviderSlug', () => {
  it('returns the base when it is free', () => {
    assert.equal(uniqueProviderSlug('together'), 'together')
  })

  it('suffixes when colliding with a reserved built-in slug', () => {
    assert.equal(uniqueProviderSlug('mistral'), 'mistral-2')
    for (const reserved of RESERVED_PROVIDER_SLUGS) {
      assert.notEqual(uniqueProviderSlug(reserved), reserved)
    }
  })

  it('suffixes past slugs already taken by other customs', () => {
    assert.equal(uniqueProviderSlug('together', ['together']), 'together-2')
    assert.equal(uniqueProviderSlug('together', ['together', 'together-2']), 'together-3')
  })

  it('falls back to "provider" for empty/garbage input', () => {
    assert.equal(uniqueProviderSlug(''), 'provider')
    assert.equal(uniqueProviderSlug('!!!'), 'provider')
  })
})
