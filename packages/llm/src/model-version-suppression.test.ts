import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TRACKED_MODELS } from './model-catalog.ts'
import { supersedingModel } from './model-version-suppression.ts'

/** Every tracked id paired with the tracked successor that hides it, if any. */
function trackedSuccessors(): Record<string, string | null> {
  const result: Record<string, string | null> = {}
  for (const model of TRACKED_MODELS) result[model] = supersedingModel(model, TRACKED_MODELS)
  return result
}

describe('supersedingModel', () => {
  it('names the newest same-family Claude release as the successor', () => {
    assert.equal(supersedingModel('claude-opus-4-8', TRACKED_MODELS), 'claude-opus-5-5')
    assert.equal(supersedingModel('claude-opus-5', TRACKED_MODELS), 'claude-opus-5-5')
    assert.equal(supersedingModel('claude-opus-5-5', TRACKED_MODELS), null)
    assert.equal(supersedingModel('claude-sonnet-4-6', TRACKED_MODELS), 'claude-sonnet-5-5')
    assert.equal(supersedingModel('claude-sonnet-5', TRACKED_MODELS), 'claude-sonnet-5-5')
    assert.equal(supersedingModel('claude-sonnet-5-5', TRACKED_MODELS), null)
    assert.equal(supersedingModel('claude-fable-5', TRACKED_MODELS), 'claude-fable-5-1')
    assert.equal(supersedingModel('claude-fable-5-1', TRACKED_MODELS), null)
  })

  it('never crosses Claude families', () => {
    // Opus 5.5 is newer than Haiku 4.5 but is not a Haiku.
    assert.equal(supersedingModel('claude-haiku-4-5', TRACKED_MODELS), null)
    assert.equal(supersedingModel('claude-sonnet-5', ['claude-opus-5-5']), null)
  })

  it('replaces an OpenAI model only with a newer release of the same tier', () => {
    assert.equal(supersedingModel('gpt-5', TRACKED_MODELS), 'gpt-5.5')
    assert.equal(supersedingModel('gpt-5.5', TRACKED_MODELS), null)
    assert.equal(supersedingModel('gpt-5.6-sol', TRACKED_MODELS), 'gpt-6.1-sol')
    assert.equal(supersedingModel('gpt-6.1-sol', TRACKED_MODELS), null)
  })

  it('does not let a different OpenAI tier stand in for an older one', () => {
    // GPT-6.1 Sol is newer than GPT-6 Astra, but Astra is its own tier.
    assert.equal(supersedingModel('gpt-6-astra', TRACKED_MODELS), null)
    // The small tiers have no newer small release, so a frontier model never hides them.
    assert.equal(supersedingModel('gpt-5-mini', TRACKED_MODELS), null)
    assert.equal(supersedingModel('gpt-5-nano', TRACKED_MODELS), null)
    assert.equal(supersedingModel('gpt-5.6-terra', TRACKED_MODELS), null)
    assert.equal(supersedingModel('gpt-5.6-luna', TRACKED_MODELS), null)
    // A same-tier successor would hide them.
    assert.equal(supersedingModel('gpt-5-mini', ['gpt-5.5-mini']), 'gpt-5.5-mini')
    assert.equal(supersedingModel('gpt-6-astra', ['gpt-6.1-astra']), 'gpt-6.1-astra')
  })

  it('leaves ids without a numeric version alone', () => {
    assert.equal(supersedingModel('gpt-4o', TRACKED_MODELS), null)
    assert.equal(supersedingModel('gpt-4o-mini', TRACKED_MODELS), null)
    assert.equal(supersedingModel('gpt-5', ['gpt-4o', 'gpt-6o']), null)
    assert.equal(supersedingModel('unknown-model', TRACKED_MODELS), null)
    assert.equal(supersedingModel('llama-3', ['llama-4']), null)
  })

  it('does not claim dated snapshots or qualified ids on either side', () => {
    assert.equal(supersedingModel('claude-haiku-4-5-20251001', ['claude-haiku-5']), null)
    assert.equal(supersedingModel('claude-haiku-4-5', ['claude-haiku-5-20270101']), null)
    assert.equal(supersedingModel('gpt-5-2025-08-07', ['gpt-5.5']), null)
    assert.equal(supersedingModel('gpt-5', ['gpt-5.5-2026-01-01', 'gpt-5-chat-latest']), null)
    assert.equal(supersedingModel('claude-mythos-preview', ['claude-mythos-5']), null)
  })

  it('compares namespaced routes with nothing', () => {
    assert.equal(supersedingModel('openrouter:anthropic/claude-opus-5', TRACKED_MODELS), null)
    assert.equal(supersedingModel('acp:claude-acp#sonnet', TRACKED_MODELS), null)
    assert.equal(supersedingModel('claude-opus-5', ['openrouter:anthropic/claude-opus-5-5']), null)
  })

  it('only counts a successor the caller is actually offering', () => {
    assert.equal(supersedingModel('claude-opus-5', ['claude-opus-5', 'claude-haiku-4-5']), null)
    assert.equal(supersedingModel('gpt-5.6-sol', ['gpt-5.6-sol', 'gpt-5.6-terra']), null)
    assert.equal(supersedingModel('gpt-5.6-sol', ['gpt-6.1-sol']), 'gpt-6.1-sol')
  })

  it('picks the newest offered successor and reads a bare major as .0', () => {
    assert.equal(
      supersedingModel('claude-sonnet-4-6', ['claude-sonnet-5', 'claude-sonnet-5-5']),
      'claude-sonnet-5-5',
    )
    assert.equal(supersedingModel('claude-sonnet-5', ['claude-sonnet-5-5']), 'claude-sonnet-5-5')
    assert.equal(supersedingModel('claude-sonnet-5-5', ['claude-sonnet-5']), null)
    assert.equal(supersedingModel('gpt-5.5', ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5']), null)
  })

  it('pins the tracked catalog outcome so a new release is a deliberate change', () => {
    assert.deepEqual(trackedSuccessors(), {
      'claude-sonnet-5-5': null,
      'claude-fable-5-1': null,
      'claude-fable-5': 'claude-fable-5-1',
      'claude-sonnet-5': 'claude-sonnet-5-5',
      'claude-sonnet-4-6': 'claude-sonnet-5-5',
      'claude-opus-5-5': null,
      'claude-opus-5': 'claude-opus-5-5',
      'claude-opus-4-8': 'claude-opus-5-5',
      'claude-haiku-4-5': null,
      'gpt-5.6-sol': 'gpt-6.1-sol',
      'gpt-5.6-terra': null,
      'gpt-5.6-luna': null,
      'gpt-6.1-sol': null,
      'gpt-6-astra': null,
      'gpt-5.5': null,
      'gpt-5': 'gpt-5.5',
      'gpt-5-mini': null,
      'gpt-5-nano': null,
      'gpt-4o': null,
      'gpt-4o-mini': null,
    })
  })
})
