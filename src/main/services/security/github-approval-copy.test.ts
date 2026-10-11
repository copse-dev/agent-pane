import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { githubShellActionAdvice } from './github-approval-copy.ts'

describe('GitHub shell action explanation', () => {
  it('names publication, repository, branch targets and draft state for a literal create', () => {
    const advice = githubShellActionAdvice(
      'gh pr create --draft -R acme/widgets --title "Fix parser" --body "Review this" --head fix/parser --base main',
    )
    assert.match(advice ?? '', /publishes a draft pull request/)
    assert.match(advice ?? '', /people with access to the repository/)
    for (const target of ['acme/widgets', 'Fix parser', 'fix/parser', 'main']) {
      assert.ok(advice?.includes(target))
    }
  })

  it('falls back rather than guessing the effects of compound, dynamic or unknown forms', () => {
    for (const command of [
      'gh pr create --title fix --body ok && rm -rf build',
      'gh pr create --title fix --body ok\ncat ~/.env',
      'gh pr create --title "$TITLE" --body ok',
      'gh pr create --title fix --body "$(cat notes)"',
      'gh pr create --title fix --body-file notes.md',
      'gh pr create --fill',
      'gh pr create --title fix --body ok --unknown',
      'gh pr create --title first --title second --body ok',
    ])
      assert.equal(githubShellActionAdvice(command), null, command)
  })
})
