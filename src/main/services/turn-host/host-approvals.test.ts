import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HostToApp } from './turn-host-protocol.ts'
import { HostApprovals } from './host-approvals.ts'

const request = { title: 'Run ls?', body: 'ls', type: 'shell' as const }

function approvals(): { approvals: HostApprovals; sent: HostToApp[] } {
  const sent: HostToApp[] = []
  let next = 0
  return {
    approvals: new HostApprovals(
      (message) => sent.push(message),
      () => `a${String(++next)}`,
    ),
    sent,
  }
}

describe('HostApprovals', () => {
  it('settles a prompt with the first answer and takes it down everywhere', async () => {
    const { approvals: prompts, sent } = approvals()
    const asked = prompts.ask('p1', 't1', request)
    assert.deepEqual(sent, [{ t: 'approval', id: 'a1', projectId: 'p1', threadId: 't1', request }])
    prompts.answer('a1', { approved: true, remember: true, grantScope: 'turn-tree' })
    prompts.answer('a1', { approved: false, remember: false })
    assert.deepEqual(await asked, {
      approved: true,
      remember: true,
      grantScope: 'turn-tree',
      resolution: 'user',
    })
    assert.deepEqual(sent.at(-1), { t: 'approval-cancel', id: 'a1' })
    assert.equal(prompts.pendingCount(), 0)
  })

  it('denies a prompt whose turn was stopped', async () => {
    const { approvals: prompts, sent } = approvals()
    const controller = new AbortController()
    const asked = prompts.ask('p1', 't1', request, controller.signal)
    controller.abort()
    assert.equal((await asked).approved, false)
    assert.deepEqual(sent.at(-1), { t: 'approval-cancel', id: 'a1' })
    controller.abort()
    assert.equal((await prompts.ask('p1', 't1', request, controller.signal)).approved, false)
    assert.equal(sent.length, 2, 'a stopped turn asks nothing')
  })

  it('asks an app that attaches every prompt still open', () => {
    const { approvals: prompts } = approvals()
    void prompts.ask('p1', 't1', request)
    void prompts.ask('p1', 't2', request)
    prompts.answer('a1', { approved: false, remember: false })
    const replayed: HostToApp[] = []
    prompts.replay((message) => replayed.push(message))
    assert.deepEqual(
      replayed.map((m) => (m.t === 'approval' ? m.threadId : m.t)),
      ['t2'],
    )
  })
})
