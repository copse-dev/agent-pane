import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SidebarThread } from './sidebar-thread.ts'
import { compactSidebarThread } from './sidebar-thread.ts'
import { foldAutomationRuns } from './automation-fold.ts'

function run(id: string, status: SidebarThread['status'] = 'idle'): SidebarThread {
  return {
    id,
    title: id,
    status,
    automation: { scheduleId: 'checks', scheduleName: 'Checks', triggeredAt: 1 },
  }
}

const describeEntries = (entries: ReturnType<typeof foldAutomationRuns>): string[] =>
  entries.map((e) =>
    e.kind === 'run' ? e.run.id : `${e.kind}:${e.runs.map((r) => r.id).join(',')}`,
  )

describe('foldAutomationRuns', () => {
  it('shows nothing for runs that finished cleanly', () => {
    assert.deepEqual(
      foldAutomationRuns([run('a'), run('b')], () => false),
      [],
    )
  })

  it('keeps needs-you, working and a single failed run as their own rows, in that order', () => {
    const entries = foldAutomationRuns(
      [run('fail', 'error'), run('work', 'running'), run('ask'), run('done')],
      (id) => id === 'ask',
    )
    assert.deepEqual(describeEntries(entries), ['ask', 'work', 'fail'])
  })

  it('keeps three waiting runs separate and collapses a fourth', () => {
    const three = ['p1', 'p2', 'p3'].map((id) => run(id))
    assert.deepEqual(describeEntries(foldAutomationRuns(three, () => true)), ['p1', 'p2', 'p3'])
    const four = [...three, run('p4')]
    assert.deepEqual(describeEntries(foldAutomationRuns(four, () => true)), ['pending:p1,p2,p3,p4'])
  })

  it('collates two or more failed runs but not one', () => {
    assert.deepEqual(
      describeEntries(foldAutomationRuns([run('f1', 'error'), run('f2', 'error')], () => false)),
      ['failed:f1,f2'],
    )
    assert.deepEqual(describeEntries(foldAutomationRuns([run('f1', 'error')], () => false)), ['f1'])
  })

  it('counts a failed run that needs the user as waiting, not failed', () => {
    const entries = foldAutomationRuns(
      [run('f1', 'error'), run('f2', 'error')],
      (id) => id === 'f1',
    )
    assert.deepEqual(describeEntries(entries), ['f1', 'f2'])
  })

  it('keeps a run pending its first start as its own row, like a running one', () => {
    const starting: SidebarThread = { ...run('starting'), automationPendingStart: true }
    const entries = foldAutomationRuns([run('done'), starting], () => false)
    assert.deepEqual(describeEntries(entries), ['starting'])
  })

  it('keeps a real pending automation visible after sidebar compaction', () => {
    const starting = compactSidebarThread({ ...run('starting'), draftPrompt: 'Check the project.' })
    assert.equal(starting.automation?.scheduleId, 'checks')
    assert.equal(starting.automationPendingStart, true)
    assert.deepEqual(describeEntries(foldAutomationRuns([starting], () => false)), ['starting'])
  })

  it('does not treat an ordinary editable draft as an automation waiting to start', () => {
    const draft = compactSidebarThread({
      id: 'ordinary',
      title: 'Discuss this PR',
      status: 'idle',
      draftPrompt: 'Review this change.',
    })
    assert.equal(draft.automation, undefined)
    assert.equal(draft.automationPendingStart, undefined)
    assert.deepEqual(
      foldAutomationRuns([draft], () => false),
      [],
    )
  })
})
