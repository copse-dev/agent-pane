import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditablePaths,
  formatBypassedWriteAudit,
  MAX_AUDITED_GIT_STATE_FILES,
  type BypassedWrite,
} from './acp-edit-audit.ts'

const writes: BypassedWrite[] = [
  { path: 'docs/plan.md', status: 'untracked' },
  { path: 'src/a.ts', status: 'modified' },
  { path: 'old.txt', status: 'deleted' },
]

describe('formatBypassedWriteAudit (#4006)', () => {
  it('says which file is the only copy and which git can give back', () => {
    const text = formatBypassedWriteAudit(writes, new Set(['docs/plan.md']))
    assert.match(
      text,
      /- docs\/plan\.md \(new, untracked\): this version is in no commit, so the file on disk is the only copy/,
    )
    assert.match(text, /- src\/a\.ts \(edited\): git already has this exact content/)
    assert.match(text, /- old\.txt \(deleted\)\n/)
    assert.match(text, /live work, not a duplicate: deleting it loses it/)
    assert.match(text, /^Warning: these files changed on disk/)
    assert.match(text, /Review them \(e\.g\. git diff\) before relying on the workspace state\.$/)
  })

  it('makes no claim about git when git could not say', () => {
    const text = formatBypassedWriteAudit(writes, null)
    assert.match(text, /- docs\/plan\.md \(new, untracked\)\n/)
    assert.doesNotMatch(text, /only copy|already has|not a duplicate/)
  })

  it('leaves out the deletion warning when git holds every file', () => {
    assert.doesNotMatch(formatBypassedWriteAudit(writes, new Set()), /not a duplicate/)
  })

  it('asks git only about files still on disk, and not about thousands', () => {
    assert.deepEqual(auditablePaths(writes), ['docs/plan.md', 'src/a.ts'])
    const many = Array.from({ length: MAX_AUDITED_GIT_STATE_FILES + 1 }, (_, index) => ({
      path: `out/${String(index)}.js`,
      status: 'untracked' as const,
    }))
    assert.equal(auditablePaths(many), null)
    assert.equal(auditablePaths(many.slice(1))?.length, MAX_AUDITED_GIT_STATE_FILES)
  })
})
