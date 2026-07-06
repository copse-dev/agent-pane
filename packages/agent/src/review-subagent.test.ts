import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EDIT_TOOL_NAMES,
  REVIEW_TOOL_NAMES,
  isEditTool,
  buildReviewPrompt,
  REVIEW_SYSTEM_PROMPT,
} from './review-subagent.ts'

describe('review-subagent helpers', () => {
  it('classifies mutating tools as edit tools', () => {
    assert.equal(isEditTool('write_file'), true)
    assert.equal(isEditTool('str_replace'), true)
    assert.equal(isEditTool('delete_file'), true)
  })

  it('does not classify read-only tools as edit tools', () => {
    assert.equal(isEditTool('read_file'), false)
    assert.equal(isEditTool('git_diff'), false)
    assert.equal(isEditTool('search_code'), false)
  })

  it('keeps the review tool set read-only (no edit tools leak in)', () => {
    for (const name of REVIEW_TOOL_NAMES) {
      assert.equal(isEditTool(name), false, `${name} must not be an edit tool`)
    }
    // The two sets must be disjoint.
    for (const edit of EDIT_TOOL_NAMES) {
      assert.equal(
        (REVIEW_TOOL_NAMES as readonly string[]).includes(edit),
        false,
        `${edit} must not be reviewable`,
      )
    }
  })

  it('embeds the parent goal and diff in the review prompt', () => {
    const prompt = buildReviewPrompt('Fix the login bug', 'diff --git a/x b/x\n+fixed')
    assert.match(prompt, /Fix the login bug/)
    assert.match(prompt, /\+fixed/)
    assert.match(prompt, /```diff/)
  })

  it('truncates very large diffs', () => {
    const huge = 'x'.repeat(50_000)
    const prompt = buildReviewPrompt('goal', huge)
    assert.ok(prompt.length < 20_000, 'prompt should be truncated well under the raw diff size')
    assert.match(prompt, /diff truncated/)
  })

  it('falls back to a hint when the diff is empty', () => {
    const prompt = buildReviewPrompt('goal', '   ')
    assert.match(prompt, /no textual diff/)
  })

  it('instructs the model to stay read-only', () => {
    assert.match(REVIEW_SYSTEM_PROMPT, /read-only/i)
    assert.match(REVIEW_SYSTEM_PROMPT, /Do NOT write files/i)
  })
})
