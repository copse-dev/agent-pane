import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cdTargetOutsideRoot,
  isPathOutsideRoot,
  sandboxDenialAdvice,
} from './sandbox-denial-advice.ts'

const ROOT = '/Users/dev/.copse/worktrees/thread-a'
const HOME = '/Users/dev'

describe('isPathOutsideRoot', () => {
  it('treats the root and its descendants as inside', () => {
    assert.equal(isPathOutsideRoot(ROOT, ROOT), false)
    assert.equal(isPathOutsideRoot(ROOT, `${ROOT}/src/main`), false)
    assert.equal(isPathOutsideRoot(ROOT, `${ROOT}/./src/../src`), false)
  })

  it('treats a sibling checkout as outside', () => {
    assert.equal(isPathOutsideRoot(ROOT, '/Users/dev/debugging/agent-pane'), true)
    assert.equal(isPathOutsideRoot(ROOT, '/Users/dev/.copse/worktrees/thread-b'), true)
  })

  it('does not call a prefix-sharing sibling directory inside', () => {
    // `thread-a2` starts with the root's own string but is a different directory;
    // a naive startsWith test would call it contained.
    assert.equal(isPathOutsideRoot(ROOT, `${ROOT}2/src`), true)
  })

  it("does not mistake macOS's /private alias for an escape", () => {
    // `/var` is a symlink to `/private/var` on macOS, so the same directory has
    // two spellings; treating them as different roots was the trap #1157 calls out.
    assert.equal(isPathOutsideRoot('/var/folders/t/copse', '/private/var/folders/t/copse/x'), false)
    assert.equal(isPathOutsideRoot('/private/var/folders/t/copse', '/var/folders/t/copse/x'), false)
    assert.equal(isPathOutsideRoot('/private/var/a', '/private/var/b'), true)
  })
})

describe('cdTargetOutsideRoot (issue #1714)', () => {
  it('names the target of the exact command from the issue', () => {
    // Thread a47f13b5: the model `cd`d to the path it believed was the workspace
    // root, and everything after the `cd` failed with EPERM.
    const command =
      'cd /Users/dev/debugging/agent-pane && grep -ril "context" src/ | head -30; git status --short'
    assert.equal(cdTargetOutsideRoot(command, ROOT, HOME), '/Users/dev/debugging/agent-pane')
  })

  it('returns null when the command stays inside the root', () => {
    assert.equal(cdTargetOutsideRoot('grep -rln "mountFooter" src/', ROOT, HOME), null)
    assert.equal(cdTargetOutsideRoot('cd src/main && pnpm test', ROOT, HOME), null)
    assert.equal(cdTargetOutsideRoot(`cd ${ROOT}/packages && ls`, ROOT, HOME), null)
  })

  it('catches a relative cd that climbs out of the root', () => {
    assert.equal(
      cdTargetOutsideRoot('cd ../thread-b && ls', ROOT, HOME),
      '/Users/dev/.copse/worktrees/thread-b',
    )
  })

  it('expands a leading ~ against the supplied home directory', () => {
    assert.equal(
      cdTargetOutsideRoot('cd ~/.config/gh && cat config.yml', ROOT, HOME),
      `${HOME}/.config/gh`,
    )
    assert.equal(cdTargetOutsideRoot('cd ~ && ls', ROOT, HOME), HOME)
  })

  it('finds a cd that is not the first command in the line', () => {
    assert.equal(cdTargetOutsideRoot('pnpm build; cd /etc && ls', ROOT, HOME), '/etc')
  })

  it('handles quoted targets, including ones containing spaces', () => {
    assert.equal(cdTargetOutsideRoot('cd "/Users/dev/other" && ls', ROOT, HOME), '/Users/dev/other')
    assert.equal(cdTargetOutsideRoot("cd '/Users/dev/other' && ls", ROOT, HOME), '/Users/dev/other')
  })

  it('ignores forms with no literal destination to name', () => {
    // Reporting a guess for these would put a path in front of the model that the
    // shell never visited.
    assert.equal(cdTargetOutsideRoot('cd - && ls', ROOT, HOME), null)
    assert.equal(cdTargetOutsideRoot('cd "$REPO_ROOT" && ls', ROOT, HOME), null)
    assert.equal(cdTargetOutsideRoot('cd', ROOT, HOME), null)
  })

  it('does not fire on a command that merely contains the letters cd', () => {
    assert.equal(cdTargetOutsideRoot('rg "cd /etc" src/', ROOT, HOME), null)
    assert.equal(cdTargetOutsideRoot('./scripts/cdk deploy /etc', ROOT, HOME), null)
  })

  it('works without a home directory', () => {
    assert.equal(cdTargetOutsideRoot('cd ~/.config && ls', ROOT), null)
    assert.equal(cdTargetOutsideRoot('cd /etc && ls', ROOT), '/etc')
  })
})

describe('sandboxDenialAdvice', () => {
  it('says nothing for an ordinary failure inside the sandbox', () => {
    // A red test run must read as a red test run, not as a policy problem.
    assert.equal(sandboxDenialAdvice({ root: ROOT, cdTarget: null, blockedOperations: 0 }), null)
  })

  it('names both the cd target and the real root', () => {
    const advice = sandboxDenialAdvice({
      root: ROOT,
      cdTarget: '/Users/dev/debugging/agent-pane',
      blockedOperations: 0,
    })
    assert.ok(advice)
    assert.match(advice, /\/Users\/dev\/debugging\/agent-pane/)
    assert.match(advice, /\/Users\/dev\/\.copse\/worktrees\/thread-a/)
    // The two opaque strings the model actually saw, so grepping either the
    // transcript or this advice leads to the same explanation.
    assert.match(advice, /Operation not permitted/)
    assert.match(advice, /Unable to read current working directory/)
  })

  it('explains a runner-recorded block when no cd is involved', () => {
    const advice = sandboxDenialAdvice({ root: ROOT, cdTarget: null, blockedOperations: 3 })
    assert.ok(advice)
    assert.match(advice, /blocked 3 operations/)
    assert.match(advice, /\/Users\/dev\/\.copse\/worktrees\/thread-a/)
  })

  it('says "1 operation" rather than "1 operations"', () => {
    const advice = sandboxDenialAdvice({ root: ROOT, cdTarget: null, blockedOperations: 1 })
    assert.ok(advice)
    assert.match(advice, /blocked 1 operation\b/)
  })

  it('prefers the cd explanation, which is the specific one', () => {
    const advice = sandboxDenialAdvice({ root: ROOT, cdTarget: '/etc', blockedOperations: 2 })
    assert.ok(advice)
    assert.match(advice, /changed directory to \/etc/)
  })
})
