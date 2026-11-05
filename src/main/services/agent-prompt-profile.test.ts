import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  BASE_SYSTEM_PROMPT,
  BASE_PROMPT_VARIANTS,
  BASE_SYSTEM_PROMPT_DIRECT_READS,
  BASE_SYSTEM_PROMPT_WITHOUT_INVESTIGATE_CI,
  baseSystemPromptFor,
  buildAblatedBasePrompt,
  EXPLORE_BASE_PROMPT_VARS,
  PROMPT_SECTION_IDS,
} from './agent-prompt.ts'
import { PROMPT_PROFILES, resolvePromptProfile } from './agent-prompt-profile.ts'
import { SECTION_PROFILES } from './agent-prompt-sections.ts'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('resolvePromptProfile', () => {
  it('maps GPT reasoning selections, however routed, to the gpt profile', () => {
    for (const model of [
      'gpt-5.5',
      'gpt-5-mini',
      'gpt-6-astra',
      'gpt-6.1-sol',
      'openrouter:openai/gpt-5',
      'my-proxy:gpt-5.5',
    ]) {
      assert.equal(resolvePromptProfile(model), 'gpt', model)
    }
  })

  it('keeps every other model, and an absent model, on the default profile', () => {
    for (const model of [
      'claude-sonnet-5-5',
      'claude-opus-5',
      'openrouter:anthropic/claude-opus-5',
      'gpt-4o',
      'o3',
      'lmstudio:gpt-5-distill-q4',
      'acp:codex#gpt-5.5',
      'gpt-oss-120b',
      'not-a-model',
    ]) {
      assert.equal(resolvePromptProfile(model), 'default', model)
    }
    assert.equal(resolvePromptProfile(undefined), 'default')
  })
})

describe('prompt profiles', () => {
  it('leaves the default prompts byte-stable (prompt-cache prefix)', () => {
    // A deliberate prompt edit updates these hashes; an accidental one fails here.
    assert.equal(
      sha256(BASE_SYSTEM_PROMPT),
      '60bbe7d98229e611d34c3e46ff892903eca6fd6595956a6e0a0d4775ac27128b',
    )
    assert.equal(
      sha256(BASE_SYSTEM_PROMPT_DIRECT_READS),
      '27eb232b9491f1fcdcd07fda129ea7748900f8f93d62e3a3b0107dcf2dda92db',
    )
    assert.equal(
      sha256(BASE_SYSTEM_PROMPT_WITHOUT_INVESTIGATE_CI),
      'c9ed04ea67ddd5750c36f1c596c6a56da447045cd323c1cde8d151dadf68ee8e',
    )
    assert.equal(baseSystemPromptFor('explore', 'default'), BASE_SYSTEM_PROMPT)
    assert.equal(
      baseSystemPromptFor('exploreWithoutInvestigateCi', 'default'),
      BASE_SYSTEM_PROMPT_WITHOUT_INVESTIGATE_CI,
    )
    assert.equal(baseSystemPromptFor('directReads', 'default'), BASE_SYSTEM_PROMPT_DIRECT_READS)
  })

  it('renders exactly the sections each profile declares', () => {
    for (const profile of PROMPT_PROFILES) {
      const declaredOut = PROMPT_SECTION_IDS.filter((id) => !SECTION_PROFILES[id].includes(profile))
      assert.equal(
        baseSystemPromptFor('explore', profile),
        buildAblatedBasePrompt(EXPLORE_BASE_PROMPT_VARS, declaredOut),
        profile,
      )
    }
  })

  it('returns the same string every call so a thread keeps one prompt prefix', () => {
    for (const profile of PROMPT_PROFILES) {
      for (const variant of BASE_PROMPT_VARIANTS) {
        assert.equal(baseSystemPromptFor(variant, profile), baseSystemPromptFor(variant, profile))
      }
    }
  })

  it('keeps the gpt profile equal to default until a measurement earns a difference', () => {
    // Update with the eval numbers when a section is dropped for gpt.
    for (const variant of BASE_PROMPT_VARIANTS) {
      assert.equal(baseSystemPromptFor(variant, 'gpt'), baseSystemPromptFor(variant, 'default'))
    }
  })
})
