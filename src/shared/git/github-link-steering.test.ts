import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGithubLinkSteeringPrompt,
  parseGithubRepoSlug,
  shouldSteerGithubLinks,
} from './github-link-steering.ts'

describe('shouldSteerGithubLinks', () => {
  it('matches PR and issue discussion', () => {
    assert.equal(shouldSteerGithubLinks('Can you review pull request #201?'), true)
    assert.equal(shouldSteerGithubLinks('What is the status of GitHub issue 42?'), true)
    assert.equal(shouldSteerGithubLinks('Run gh pr view and summarize'), true)
    assert.equal(shouldSteerGithubLinks('Please merge this PR when CI passes'), true)
    assert.equal(shouldSteerGithubLinks('Link issue #118 in your reply'), true)
    assert.equal(
      shouldSteerGithubLinks(
        'Are there other open PRs that would benefit from manual review?',
      ),
      true,
    )
    assert.equal(shouldSteerGithubLinks('Can you make links for them?'), true)
  })

  it('does not match unrelated prompts', () => {
    assert.equal(shouldSteerGithubLinks('hi'), false)
    assert.equal(shouldSteerGithubLinks('Explain the parser'), false)
    assert.equal(shouldSteerGithubLinks('Review my diff'), false)
    assert.equal(shouldSteerGithubLinks('Fix the auth bug'), false)
  })
})

describe('parseGithubRepoSlug', () => {
  it('parses common GitHub remote URL forms', () => {
    assert.equal(parseGithubRepoSlug('https://github.com/org/repo.git'), 'org/repo')
    assert.equal(parseGithubRepoSlug('git@github.com:org/repo.git'), 'org/repo')
    assert.equal(parseGithubRepoSlug('ssh://git@github.com/org/repo'), 'org/repo')
  })

  it('returns null for non-GitHub remotes', () => {
    assert.equal(parseGithubRepoSlug('git@gitlab.com:org/repo.git'), null)
    assert.equal(parseGithubRepoSlug(''), null)
  })
})

describe('buildGithubLinkSteeringPrompt', () => {
  it('includes repo slug when available', () => {
    assert.match(buildGithubLinkSteeringPrompt('org/repo'), /Repo: org\/repo/)
    assert.match(buildGithubLinkSteeringPrompt('org/repo'), /tables and lists/)
  })

  it('falls back to git remote hint without a slug', () => {
    assert.match(buildGithubLinkSteeringPrompt(null), /git remote/)
    assert.match(buildGithubLinkSteeringPrompt(null), /tables and lists/)
  })
})
