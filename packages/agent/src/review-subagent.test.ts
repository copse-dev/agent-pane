import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EDIT_TOOL_NAMES,
  REVIEW_TOOL_NAMES,
  isEditTool,
  buildReviewPrompt,
  parseReviewVerdict,
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

  it('includes the task plan when todos are provided', () => {
    const prompt = buildReviewPrompt('Fix bug', '+change', [
      { id: 't1', content: 'Add tests', status: 'pending' },
    ])
    assert.match(prompt, /Task plan to verify/)
    assert.match(prompt, /Add tests/)
    assert.match(prompt, /id: t1/)
  })

  it('parses structured REVIEW_JSON verdicts', () => {
    const parsed = parseReviewVerdict(`1 likely bug

- missing unregister

REVIEW_JSON: {"issuesFound":true,"requestFollowUp":true,"todoUpdates":[{"id":"t1","content":"Fix leak","status":"pending"}],"followUpPrompt":"Unregister on close"}`)
    assert.equal(parsed.issuesFound, true)
    assert.equal(parsed.requestFollowUp, true)
    assert.equal(parsed.todoUpdates.length, 1)
    assert.equal(parsed.followUpPrompt, 'Unregister on close')
    assert.doesNotMatch(parsed.summary, /REVIEW_JSON/)
  })

  it('infers follow-up from free-text when JSON is missing', () => {
    const parsed = parseReviewVerdict('1 likely bug: globalShortcut never unregistered')
    assert.equal(parsed.requestFollowUp, true)
    assert.equal(parsed.todoUpdates.length, 0)
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
