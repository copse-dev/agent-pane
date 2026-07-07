import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractGithubPrUrls, githubPrKey, parseGithubPrUrl } from './github-pr-url.ts'

describe('parseGithubPrUrl', () => {
  it('parses standard GitHub PR URLs', () => {
    assert.deepEqual(parseGithubPrUrl('https://github.com/org/repo/pull/42'), {
      owner: 'org',
      repo: 'repo',
      number: 42,
      url: 'https://github.com/org/repo/pull/42',
    })
  })

  it('parses www and trailing slash variants', () => {
    assert.deepEqual(parseGithubPrUrl('https://www.github.com/org/repo/pull/7/'), {
      owner: 'org',
      repo: 'repo',
      number: 7,
      url: 'https://www.github.com/org/repo/pull/7/',
    })
  })

  it('parses a link to a PR sub-tab as the PR itself', () => {
    assert.deepEqual(parseGithubPrUrl('https://github.com/org/repo/pull/99/files'), {
      owner: 'org',
      repo: 'repo',
      number: 99,
      url: 'https://github.com/org/repo/pull/99/files',
    })
    assert.equal(parseGithubPrUrl('https://github.com/org/repo/pull/99/commits')?.number, 99)
  })

  it('returns null for non-PR GitHub URLs', () => {
    assert.equal(parseGithubPrUrl('https://github.com/org/repo/issues/1'), null)
    assert.equal(parseGithubPrUrl('https://gitlab.com/org/repo/pull/1'), null)
    assert.equal(parseGithubPrUrl('not a url'), null)
  })
})

describe('extractGithubPrUrls', () => {
  it('finds unique PR links in markdown text', () => {
    const text =
      'See [PR #204](https://github.com/org/repo/pull/204) and https://github.com/org/repo/pull/204 again.\n' +
      'Also https://github.com/other/app/pull/9.'
    const refs = extractGithubPrUrls(text)
    assert.equal(refs.length, 2)
    const [first, second] = refs
    assert.ok(first && second)
    assert.equal(githubPrKey(first), 'org/repo#204')
    assert.equal(githubPrKey(second), 'other/app#9')
  })
})
