import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COPSE_COAUTHOR,
  appendCommitAttribution,
  appendPrBodyAttribution,
  buildCommitAttribution,
} from './commit-attribution.ts'

describe('buildCommitAttribution', () => {
  it('lists the co-author and the models used', () => {
    assert.equal(
      buildCommitAttribution(['claude-opus-4-8', 'gpt-4o']),
      `${COPSE_COAUTHOR}\nCopse-Models: claude-opus-4-8, gpt-4o`,
    )
  })

  it('omits the models line when no models are known', () => {
    assert.equal(buildCommitAttribution([]), COPSE_COAUTHOR)
  })

  it('de-duplicates and drops blank model ids, preserving first-seen order', () => {
    assert.equal(
      buildCommitAttribution(['gpt-4o', '', ' claude-opus-4-8 ', 'gpt-4o']),
      `${COPSE_COAUTHOR}\nCopse-Models: gpt-4o, claude-opus-4-8`,
    )
  })
})

describe('appendCommitAttribution', () => {
  it('appends the trailer after a blank line', () => {
    assert.equal(
      appendCommitAttribution('Fix the bug', ['claude-opus-4-8']),
      `Fix the bug\n\n${COPSE_COAUTHOR}\nCopse-Models: claude-opus-4-8\n`,
    )
  })

  it('normalizes trailing whitespace before appending', () => {
    assert.equal(
      appendCommitAttribution('Subject\n\n', ['gpt-4o']),
      `Subject\n\n${COPSE_COAUTHOR}\nCopse-Models: gpt-4o\n`,
    )
  })

  it('is idempotent when the co-author trailer is already present', () => {
    const once = appendCommitAttribution('Subject', ['gpt-4o'])
    assert.equal(appendCommitAttribution(once, ['gpt-4o', 'claude-opus-4-8']), once)
  })
})

describe('appendPrBodyAttribution', () => {
  it('appends the same block a commit gets, after a blank line', () => {
    assert.equal(
      appendPrBodyAttribution('Why this change.', ['claude-opus-4-8']),
      `Why this change.\n\n${COPSE_COAUTHOR}\nCopse-Models: claude-opus-4-8\n`,
    )
  })

  it('emits the trailer alone for an empty body, with no leading blank line', () => {
    assert.equal(
      appendPrBodyAttribution('', ['gpt-4o']),
      `${COPSE_COAUTHOR}\nCopse-Models: gpt-4o\n`,
    )
  })

  it('is idempotent so a retried create cannot stack trailers', () => {
    const once = appendPrBodyAttribution('Body', ['gpt-4o'])
    assert.equal(appendPrBodyAttribution(once, ['gpt-4o']), once)
  })
})
