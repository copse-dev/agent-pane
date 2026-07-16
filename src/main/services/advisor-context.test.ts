import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatAdvisorRepoState,
  formatAdvisorWorkingDiff,
  type AdvisorRepoState,
} from './advisor-context.ts'

const CLEAN: AdvisorRepoState = {
  branch: 'feature-x',
  base: 'main',
  ahead: 2,
  behind: 40,
  statusShort: '',
  changeStats: null,
}

describe('formatAdvisorRepoState', () => {
  it('leads with a verified, authoritative heading and the branch divergence', () => {
    const out = formatAdvisorRepoState(CLEAN)
    assert.match(out, /Repository state \(verified now — authoritative over the transcript\)/)
    assert.match(out, /Branch: `feature-x` — 2 ahead, 40 behind `main`/)
  })

  it('reports a clean working tree explicitly (the anti-hallucination case)', () => {
    const out = formatAdvisorRepoState(CLEAN)
    assert.match(out, /Working tree: clean \(no uncommitted changes\)/)
    // And clarifies that "behind" is not local edits — the exact confusion hit.
    assert.match(out, /"behind" counts commits on `main` not yet merged here — not local edits/)
  })

  it('quotes the short status and change stats when the tree is dirty', () => {
    const out = formatAdvisorRepoState({
      ...CLEAN,
      behind: 0,
      statusShort: ' M src/a.ts\n?? src/b.ts',
      changeStats: { additions: 12, deletions: 3 },
    })
    assert.match(out, /2 path\(s\) changed \(\+12 \/ -3\)/)
    assert.match(out, /M src\/a\.ts/)
    assert.match(out, /\?\? src\/b\.ts/)
    // No "behind" note when the branch is up to date.
    assert.doesNotMatch(out, /not local edits/)
  })

  it('truncates a very long status', () => {
    const status = Array.from({ length: 60 }, (_, i) => ` M f${String(i)}.ts`).join('\n')
    const out = formatAdvisorRepoState({ ...CLEAN, behind: 0, statusShort: status })
    assert.match(out, /60 path\(s\) changed/)
    assert.match(out, /… 20 more/)
  })

  it('renders a detached HEAD (clean) without a branch name — not an empty block', () => {
    // Field-identical to "no repo", so the formatter still renders; the
    // in-a-repo? gate lives in buildAdvisorRepoState (isInsideGitWorkTree).
    const out = formatAdvisorRepoState({
      branch: null,
      base: null,
      ahead: null,
      behind: null,
      statusShort: '',
      changeStats: null,
    })
    assert.match(out, /Branch: \(detached\)/)
    assert.match(out, /Working tree: clean/)
  })
})

describe('formatAdvisorWorkingDiff', () => {
  it('fences the combined diff', () => {
    const out = formatAdvisorWorkingDiff('diff --git a/x b/x\n+added')
    assert.match(out, /## Working diff \(staged \+ unstaged, verified now\)/)
    assert.match(out, /```diff\ndiff --git a\/x b\/x\n\+added\n```/)
  })

  it('reports a clean tree for empty or sentinel output', () => {
    assert.match(formatAdvisorWorkingDiff(''), /the working tree is clean/)
    assert.match(formatAdvisorWorkingDiff('(no output)'), /the working tree is clean/)
  })

  it('caps an oversized diff with a truncation marker', () => {
    const big = `diff --git a/x b/x\n${'+'.repeat(9000)}`
    const out = formatAdvisorWorkingDiff(big, 500)
    assert.match(out, /… \(diff truncated\)/)
    assert.ok(out.length < big.length)
  })
})
