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
      '34d30bc822d32a2e1251fdc640220cb57f34221d06436d3d976c863dd9e737e7',
    )
    assert.equal(
      sha256(BASE_SYSTEM_PROMPT_DIRECT_READS),
      '882c478365328548f624e0ae8613da2015810b4345f26a4c47b17ef1b2eeb3b9',
    )
    assert.equal(
      sha256(BASE_SYSTEM_PROMPT_WITHOUT_INVESTIGATE_CI),
      '571906222612d7ff791c8bfd9b99a6ede280851cbb2d42737e12a46cb14b6596',
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
