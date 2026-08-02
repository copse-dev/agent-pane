import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_ATTRIBUTION_HEADERS,
  APP_ATTRIBUTION_TITLE,
  APP_ATTRIBUTION_URL,
  OPENROUTER_ATTRIBUTION_HEADERS,
  withAppAttribution,
} from './app-attribution.ts'

describe('app attribution headers', () => {
  it('sends the cross-router HTTP-Referer + X-Title pair', () => {
    assert.deepEqual(
      { ...APP_ATTRIBUTION_HEADERS },
      {
        'HTTP-Referer': APP_ATTRIBUTION_URL,
        'X-Title': APP_ATTRIBUTION_TITLE,
      },
    )
  })

  it('carries no user, key, or install identifier', () => {
    const values = Object.values(OPENROUTER_ATTRIBUTION_HEADERS).join(' ')
    assert.equal(values.includes('sk-'), false)
    assert.match(APP_ATTRIBUTION_URL, /^https:\/\//)
  })

  it('adds OpenRouter’s renamed title header with the same value, so precedence cannot matter', () => {
    assert.equal(
      OPENROUTER_ATTRIBUTION_HEADERS['X-OpenRouter-Title'],
      OPENROUTER_ATTRIBUTION_HEADERS['X-Title'],
    )
    assert.equal(OPENROUTER_ATTRIBUTION_HEADERS['HTTP-Referer'], APP_ATTRIBUTION_URL)
  })

  it('lets caller headers override an attribution value', () => {
    const merged = withAppAttribution({ 'X-Title': 'Copse Nightly', 'X-Other': 'keep' })
    assert.equal(merged['X-Title'], 'Copse Nightly')
    assert.equal(merged['HTTP-Referer'], APP_ATTRIBUTION_URL)
    assert.equal(merged['X-Other'], 'keep')
  })

  it('returns a fresh object so a caller cannot mutate the shared constants', () => {
    const merged = withAppAttribution()
    merged['X-Title'] = 'mutated'
    assert.equal(APP_ATTRIBUTION_HEADERS['X-Title'], APP_ATTRIBUTION_TITLE)
  })
})
