import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scopedSshCommitSigningAdvice } from './git-commit-signing-advice.ts'

const SIGNING_ERROR =
  "error: Couldn't load public key /Users/example/.ssh/id_ed25519: No such file or directory?\n\nfatal: failed to write commit object"

describe('scoped SSH commit signing advice', () => {
  const eligible = { macOS: true, sandboxed: true, permissionEnabled: false }

  it('explains the Copse setting after the matching commit failure', () => {
    const advice = scopedSshCommitSigningAdvice(SIGNING_ERROR, eligible)
    assert.match(advice ?? '', /Settings → Permissions → Commit signing/)
    assert.match(advice ?? '', /ssh-agent/)
    assert.match(advice ?? '', /Do not request a password, disable signing/)
  })

  it('also handles Git failures to reach or find the configured key in ssh-agent', () => {
    for (const reason of ["Couldn't get agent socket?", "Couldn't find key in agent?"]) {
      const output = `error: ${reason}\n\nfatal: failed to write commit object`
      assert.match(scopedSshCommitSigningAdvice(output, eligible) ?? '', /Commit signing/)
    }
  })

  it('does not misdiagnose other failures or an already enabled permission', () => {
    assert.equal(
      scopedSshCommitSigningAdvice('fatal: failed to write commit object', eligible),
      null,
    )
    assert.equal(
      scopedSshCommitSigningAdvice("error: Couldn't load public key key.pub", eligible),
      null,
    )
    assert.equal(scopedSshCommitSigningAdvice('fatal: not a git repository', eligible), null)
    assert.equal(
      scopedSshCommitSigningAdvice(SIGNING_ERROR, { ...eligible, permissionEnabled: true }),
      null,
    )
    assert.equal(scopedSshCommitSigningAdvice(SIGNING_ERROR, { ...eligible, macOS: false }), null)
    assert.equal(
      scopedSshCommitSigningAdvice(SIGNING_ERROR, { ...eligible, sandboxed: false }),
      null,
    )
  })
})
