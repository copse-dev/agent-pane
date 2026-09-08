import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EDIT_TOOL_NAMES,
  REVIEW_TOOL_NAMES,
  isEditTool,
  buildReviewPrompt,
  parseReviewVerdict,
  proseRequestsFollowUp,
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

// #2506. The system prompt asks for follow-up on two grounds — "code fixes are
// needed OR open todos were left incorrectly incomplete" — and only the first
// was ever inferred. A review that said the work was not done in plain words
// produced `requestFollowUp: false`, so the remediation loop broke on its first
// check and the turn ended having been told the work was unfinished.
describe('an unfinished verdict asks for follow-up', () => {
  it('reads incompleteness that carries no defect word at all', () => {
    for (const summary of [
      'The refactor is incomplete: three call sites still use the old helper.',
      'This is unfinished — the migration only covers the read path.',
      'Task not done: the CLI flag was never wired up.',
      'The plan item is not yet complete.',
      'Not implemented for the SSH workspace case.',
      'Two items still need work before this is finished.',
      'One acceptance criterion remains outstanding.',
      'Left incomplete: the rollback path.',
      'Partially implemented — the happy path only.',
    ]) {
      assert.equal(proseRequestsFollowUp(summary), true, summary)
    }
  })

  it('does not read an approving review as unfinished', () => {
    // Each of these contains a word the pattern matches, while saying the
    // opposite. Firing here would spend a remediation turn arguing with a
    // reviewer that already agreed.
    for (const summary of [
      'Looks correct; nothing incomplete and no todos remaining.',
      'No unfinished work — the plan is reconciled.',
      'None of the plan items remain outstanding.',
      'The changes look correct and the plan is reconciled.',
      'Clean diff, tests updated alongside.',
    ]) {
      assert.equal(proseRequestsFollowUp(summary), false, summary)
    }
  })

  it('still reads a defect as follow-up, unchanged', () => {
    assert.equal(proseRequestsFollowUp('Likely bug in the retry path.'), true)
    assert.equal(proseRequestsFollowUp('Missing null check on the parsed id.'), true)
  })

  it('asks for follow-up on free-text incompleteness, without claiming a defect', () => {
    // `issuesFound` drives the review card's badge, and an unfinished-but-correct
    // diff has not found a bug. The two flags are deliberately not the same.
    const verdict = parseReviewVerdict('The task is incomplete: the CLI flag was never wired up.')
    assert.equal(verdict.requestFollowUp, true)
    assert.equal(verdict.issuesFound, false)
    assert.equal(verdict.followUpPrompt, 'The task is incomplete: the CLI flag was never wired up.')
  })

  it('carries the prose into the follow-up prompt so the parent is told why', () => {
    // Without this the remediation nudge is the generic one and the parent never
    // learns what the reviewer said was missing.
    const verdict = parseReviewVerdict('Not done: the rollback path is still a stub.')
    assert.equal(verdict.followUpPrompt, 'Not done: the rollback path is still a stub.')
  })

  it('infers follow-up from the prose when the JSON omits the flag', () => {
    const verdict = parseReviewVerdict(
      [
        'The migration is incomplete — two call sites remain.',
        'REVIEW_JSON: {"issuesFound":false}',
      ].join('\n'),
    )
    assert.equal(verdict.requestFollowUp, true)
    assert.equal(verdict.issuesFound, false)
  })

  it('honours an explicit requestFollowUp:false even when the prose sounds unfinished', () => {
    // The reviewer said no. A structured decision is not something to second-guess
    // with a regex.
    const verdict = parseReviewVerdict(
      [
        'Some items are incomplete but intentionally deferred.',
        'REVIEW_JSON: {"issuesFound":false,"requestFollowUp":false}',
      ].join('\n'),
    )
    assert.equal(verdict.requestFollowUp, false)
  })

  it('leaves an approving structured verdict alone', () => {
    const verdict = parseReviewVerdict(
      ['Looks good, plan reconciled.', 'REVIEW_JSON: {"issuesFound":false}'].join('\n'),
    )
    assert.equal(verdict.requestFollowUp, false)
    assert.equal(verdict.issuesFound, false)
  })
})
