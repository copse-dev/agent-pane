import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseIssueRef, issueRefToUrl, resolveIssueRef } from './issue-ref.ts'

describe('parseIssueRef', () => {
  it('canonicalizes the forms people paste', () => {
    assert.equal(parseIssueRef('123'), '#123')
    assert.equal(parseIssueRef('#123'), '#123')
    assert.equal(parseIssueRef(' #123 '), '#123')
    assert.equal(parseIssueRef('octo/hello-world#7'), 'octo/hello-world#7')
    assert.equal(
      parseIssueRef('https://github.com/octo/hello-world/issues/7'),
      'octo/hello-world#7',
    )
    assert.equal(
      parseIssueRef('https://github.com/octo/hello-world/issues/7#issuecomment-1'),
      'octo/hello-world#7',
    )
  })

  it('rejects what it cannot understand', () => {
    assert.equal(parseIssueRef(''), null)
    assert.equal(parseIssueRef('not an issue'), null)
    assert.equal(parseIssueRef('#12a'), null)
    assert.equal(parseIssueRef('https://github.com/octo/hello-world/pull/7'), null)
    assert.equal(parseIssueRef('https://example.com/octo/hello/issues/7'), null)
  })
})

describe('resolveIssueRef', () => {
  it('anchors short refs on the workspace slug', () => {
    assert.deepEqual(resolveIssueRef('#12', 'octo/hello'), {
      owner: 'octo',
      repo: 'hello',
      number: 12,
    })
    assert.equal(resolveIssueRef('#12', null), null)
  })

  it('reads full refs directly', () => {
    assert.deepEqual(resolveIssueRef('a/b#3', null), { owner: 'a', repo: 'b', number: 3 })
  })

  it('rejects malformed refs', () => {
    assert.equal(resolveIssueRef('nope', 'octo/hello'), null)
  })
})

describe('issueRefToUrl', () => {
  it('resolves short refs against the workspace slug', () => {
    assert.equal(issueRefToUrl('#123', 'octo/hello'), 'https://github.com/octo/hello/issues/123')
    assert.equal(issueRefToUrl('#123', null), null)
  })

  it('resolves full refs regardless of slug', () => {
    assert.equal(issueRefToUrl('octo/other#9', null), 'https://github.com/octo/other/issues/9')
  })

  it('returns null for malformed refs', () => {
    assert.equal(issueRefToUrl('nonsense', 'octo/hello'), null)
  })
})
