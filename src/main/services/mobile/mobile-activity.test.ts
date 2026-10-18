import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

describe('mobileActivity dirty-state inspection', () => {
  it('resolves checkouts without restoring retired worktrees', async () => {
    const source = await readFile(new URL('./mobile-activity.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function settledThreadHasChanges(')
    const end = source.indexOf('export async function mobileActivity(')
    assert.ok(start !== -1 && end > start, 'settledThreadHasChanges block not found')
    const block = source.slice(start, end)
    assert.match(block, /inspectThreadCheckoutRoot\(/)
    // Resolution restores a retired worktree with `git worktree add`, so an
    // activity poll must never go through it.
    assert.doesNotMatch(source, /resolveThreadExecutionContext/)
  })
})
