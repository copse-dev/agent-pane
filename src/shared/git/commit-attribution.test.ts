import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  COPSE_COAUTHOR,
  appendCommitAttribution,
  buildCommitAttribution,
  shouldSteerCommit,
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

describe('shouldSteerCommit', () => {
  it('fires on commit intent in its various forms', () => {
    for (const text of [
      'commit this',
      'please commit the changes',
      'stage and commit',
      'you committed too early',
      'committing now',
      'squash the commits',
    ]) {
      assert.equal(shouldSteerCommit(text), true, text)
    }
  })

  it('does not fire on unrelated text or the word commitment', () => {
    for (const text of ['fix the bug', 'a strong commitment to quality', 'review the PR']) {
      assert.equal(shouldSteerCommit(text), false, text)
    }
  })
})
