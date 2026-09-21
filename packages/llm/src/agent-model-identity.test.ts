import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAgentModelIdentity } from './agent-model-identity.ts'
import { getIntellectScore } from './model-intellect.ts'

describe('resolveAgentModelIdentity', () => {
  it('resolves the first form the measurement alias map covers', () => {
    // Claude Code advertises `{ value: 'opus', description: 'Opus 5 with …' }`:
    // the value names no version, the described name does.
    assert.equal(resolveAgentModelIdentity('opus', 'Opus 5', 'Opus (1M context)'), 'claude-opus-5')
    assert.equal(resolveAgentModelIdentity('gpt-5.6-sol', 'GPT-5.6 Sol'), 'gpt-5.6-sol')
  })

  it('falls back to the id a plain family + version denotes when no alias covers it', () => {
    // Cursor's word order. The alias map has no entry for it, but the name
    // says exactly which model it is.
    assert.equal(resolveAgentModelIdentity('Claude 5 Sonnet'), 'claude-sonnet-5')
  })

  it('prefers an aliased later form over an earlier form it can only guess at', () => {
    // The alias pass runs over every form before the label pass runs over any,
    // so a precise later spelling is not beaten by an earlier approximation.
    assert.equal(resolveAgentModelIdentity('Claude 5 Sonnet', 'claude-opus-5'), 'claude-opus-5')
  })

  it('resolves Grok Build routes to their own measurement, not Grok 4.5', () => {
    const measured = 'grok-build-0-1-06-16'
    for (const form of [
      'grok-build-0.1',
      'x-ai/grok-build-0.1',
      'Grok Build 0.1',
      'xAI: Grok Build 0.1',
      'SpaceXAI: Grok Build 0.1',
      'acp:cursor#grok-build-0.1',
      'openrouter:x-ai/grok-build-0.1',
    ]) {
      assert.equal(resolveAgentModelIdentity(form), measured, form)
      assert.deepEqual(getIntellectScore(form), getIntellectScore(measured), form)
    }
    assert.equal(resolveAgentModelIdentity('grok-4.5'), 'grok-4.5')
    assert.notDeepEqual(getIntellectScore(measured), getIntellectScore('grok-4.5'))
    // A model name alone does not tell us which configurable reasoning effort
    // was used; do not silently attach the high-effort measurement.
    assert.equal(resolveAgentModelIdentity('grok-4.3'), null)
  })

  it('returns null for names that denote no measured model', () => {
    // Family alone names no version, so there is nothing to resolve to.
    assert.equal(resolveAgentModelIdentity('opus', 'Opus'), null)
    assert.equal(resolveAgentModelIdentity('Default (recommended)'), null)
    assert.equal(resolveAgentModelIdentity(null, undefined, ''), null)
    // A well-formed name for a model nobody has measured is still null: a
    // resolvable id with no score would put an unplaceable row on the frontier.
    assert.equal(getIntellectScore('claude-opus-99'), null)
    assert.equal(resolveAgentModelIdentity('Opus 99'), null)
  })
})
