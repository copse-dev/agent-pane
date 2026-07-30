/**
 * Prompt-section ablation pins (#744).
 *
 * Holds the explore-mode / direct-reads base prompts constant and drops one
 * named section at a time (including the tool list). Asserts:
 * 1. Full assembly stays byte-identical to the shipping BASE_SYSTEM_PROMPT*.
 * 2. Each omitted section removes its marker text.
 * 3. Sibling sections survive the omission.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASE_SYSTEM_PROMPT,
  BASE_SYSTEM_PROMPT_DIRECT_READS,
  buildAblatedBasePrompt,
  DIRECT_READS_BASE_PROMPT_VARS,
  EXPLORE_BASE_PROMPT_VARS,
  PROMPT_SECTION_IDS,
  SHARED_WORKING_STYLE,
  type PromptSectionId,
} from './agent-prompt.ts'

/** Distinctive substrings that identify each section in the assembled prompt. */
const SECTION_MARKERS: Record<PromptSectionId, RegExp> = {
  preamble: /You are a coding assistant with access to the user's local workspace\./,
  tools: /Available tools:/,
  workspace: /Working directory: \{WORKSPACE_ROOT\}/,
  openEnded: /When the user asks an open-ended question/,
  modifyingFiles: /When modifying files:/,
  toolChoice: /Tool choice:/,
  workingStyle: /Working style:/,
  gitBranchSafety: /Git branch safety:/,
}

describe('agent-prompt ablation', () => {
  it('full assembly matches shipping explore and direct-reads prompts', () => {
    assert.equal(buildAblatedBasePrompt(EXPLORE_BASE_PROMPT_VARS, []), BASE_SYSTEM_PROMPT)
    assert.equal(
      buildAblatedBasePrompt(DIRECT_READS_BASE_PROMPT_VARS, []),
      BASE_SYSTEM_PROMPT_DIRECT_READS,
    )
  })

  it('shipping prompts still carry the working-style doctrine verbatim', () => {
    assert.ok(BASE_SYSTEM_PROMPT.includes(SHARED_WORKING_STYLE))
    assert.ok(BASE_SYSTEM_PROMPT_DIRECT_READS.includes(SHARED_WORKING_STYLE))
  })

  for (const section of PROMPT_SECTION_IDS) {
    it(`omitting ${section} drops that section and keeps the others (explore mode)`, () => {
      const ablated = buildAblatedBasePrompt(EXPLORE_BASE_PROMPT_VARS, [section])
      assert.doesNotMatch(ablated, SECTION_MARKERS[section])
      for (const other of PROMPT_SECTION_IDS) {
        if (other === section) continue
        assert.match(
          ablated,
          SECTION_MARKERS[other],
          `expected sibling section ${other} to survive omitting ${section}`,
        )
      }
    })
  }

  it('omitting tools removes the tool list but keeps working style and tool choice', () => {
    const ablated = buildAblatedBasePrompt(EXPLORE_BASE_PROMPT_VARS, ['tools'])
    assert.doesNotMatch(ablated, /Available tools:/)
    assert.doesNotMatch(ablated, /- explore: Explore the codebase/)
    assert.match(ablated, /Working style:/)
    assert.match(ablated, /Tool choice:/)
    assert.match(ablated, /Working directory: \{WORKSPACE_ROOT\}/)
  })

  it('omitting workingStyle removes the doctrine only', () => {
    const ablated = buildAblatedBasePrompt(EXPLORE_BASE_PROMPT_VARS, ['workingStyle'])
    assert.doesNotMatch(ablated, /Working style:/)
    assert.doesNotMatch(ablated, /Lead with the outcome/)
    assert.match(ablated, /Available tools:/)
    assert.match(ablated, /Git branch safety:/)
  })
})
