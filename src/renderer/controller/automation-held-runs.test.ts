import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { heldAutomationRuns, heldRunsLabel, heldRunsTooltip } from './automation-held-runs.ts'
import type { SidebarThread } from './sidebar-thread.ts'

function run(id: string, overrides: Partial<SidebarThread> = {}): SidebarThread {
  return {
    id,
    title: 'Main check',
    status: 'idle',
    worktree: {
      path: `/worktrees/${id}`,
      branch: `codex/${id}`,
      baseBranch: 'main',
      baseCommit: 'a'.repeat(40),
      createdAt: 1,
      seededFromDirtyProject: false,
    },
    ...overrides,
  }
}

describe('heldAutomationRuns', () => {
  it('counts finished runs that still hold a checkout', () => {
    assert.deepEqual(
      heldAutomationRuns([run('a'), run('b')]).map((r) => r.id),
      ['a', 'b'],
    )
  })

  it('ignores running runs, retired checkouts and runs that never had one', () => {
    const retired = run('retired')
    assert.ok(retired.worktree)
    const runs = [
      run('running', { status: 'running' }),
      { ...retired, worktree: { ...retired.worktree, retiredAt: 5 } },
      run('none', { worktree: undefined }),
      run('held'),
    ]
    assert.deepEqual(
      heldAutomationRuns(runs).map((r) => r.id),
      ['held'],
    )
  })

  it('words the badge and tooltip for one and for several', () => {
    assert.equal(heldRunsLabel(2), '2 held')
    assert.match(heldRunsTooltip(1), /^1 finished run still holds a worktree/)
    assert.match(heldRunsTooltip(3), /^3 finished runs still hold a worktree/)
  })
})
