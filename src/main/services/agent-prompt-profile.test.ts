import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  BASE_SYSTEM_PROMPT,
  BASE_SYSTEM_PROMPT_DIRECT_READS,
  baseSystemPromptFor,
  buildAblatedBasePrompt,
  EXPLORE_BASE_PROMPT_VARS,
  PROMPT_SECTION_IDS,
} from './agent-prompt.ts'
import { PROMPT_PROFILES, resolvePromptProfile } from './agent-prompt-profile.ts'
import { SECTION_PROFILES } from './agent-prompt-sections.ts'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

describe('resolvePromptProfile', () => {
  it('maps OpenAI GPT selections, however routed, to the gpt profile', () => {
    for (const model of ['gpt-5.5', 'gpt-5-mini', 'openrouter:openai/gpt-5', 'my-proxy:gpt-5.5']) {
      assert.equal(resolvePromptProfile(model), 'gpt', model)
    }
  })

  it('keeps every other model, and an absent model, on the default profile', () => {
    for (const model of [
      'claude-sonnet-5-5',
      'claude-opus-5',
      'openrouter:anthropic/claude-opus-5',
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
      'f4cb08ce2ffbac5fdf3edce91472138c9040f2bcb4a22045c1ca8292ee1fcc3f',
    )
    assert.equal(
      sha256(BASE_SYSTEM_PROMPT_DIRECT_READS),
      '7f44bff96e68d5247cd522de84ed2e2e86006cdcff615053dd6a7bf8ae4debed',
    )
    assert.equal(baseSystemPromptFor(true, 'default'), BASE_SYSTEM_PROMPT)
    assert.equal(baseSystemPromptFor(false, 'default'), BASE_SYSTEM_PROMPT_DIRECT_READS)
  })

  it('renders exactly the sections each profile declares', () => {
    for (const profile of PROMPT_PROFILES) {
      const declaredOut = PROMPT_SECTION_IDS.filter((id) => !SECTION_PROFILES[id].includes(profile))
      assert.equal(
        baseSystemPromptFor(true, profile),
        buildAblatedBasePrompt(EXPLORE_BASE_PROMPT_VARS, declaredOut),
        profile,
      )
    }
  })

  it('returns the same string every call so a thread keeps one prompt prefix', () => {
    for (const profile of PROMPT_PROFILES) {
      assert.equal(baseSystemPromptFor(false, profile), baseSystemPromptFor(false, profile))
    }
  })

  it('keeps the gpt profile equal to default until a measurement earns a difference', () => {
    // Update with the eval numbers when a section is dropped for gpt.
    assert.equal(baseSystemPromptFor(true, 'gpt'), BASE_SYSTEM_PROMPT)
    assert.equal(baseSystemPromptFor(false, 'gpt'), BASE_SYSTEM_PROMPT_DIRECT_READS)
  })
})
