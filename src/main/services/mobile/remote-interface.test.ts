import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RemoteInterface } from './remote-interface.ts'
import type { RemoteRead } from '../../../shared/remote-interface.ts'

const request: RemoteRead = { version: 1, channel: 'agent:running-thread-ids', args: [] }

describe('remote desktop relay', () => {
  it('rejects unauthenticated reads before desktop dispatch', async () => {
    const host = new RemoteInterface()
    let delivered = 0
    host.attach(() => {
      delivered++
    })
    await assert.rejects(
      host.read(request, () => false),
      /revoked/,
    )
    assert.equal(delivered, 0)
  })

  it('correlates replies and rechecks revocation before returning data', async () => {
    const host = new RemoteInterface()
    let allowed = true
    let replyId = ''
    host.attach((id) => {
      replyId = id
    })
    const read = host.read(request, () => allowed)
    allowed = false
    host.reply({ id: replyId, ok: true, value: ['private-thread'] })
    await assert.rejects(read, /revoked/)
  })

  it('rejects in-flight reads when the owning desktop closes', async () => {
    const host = new RemoteInterface()
    const detach = host.attach(() => {})
    const pending = host.read(request, () => true)
    detach()
    await assert.rejects(pending, /closed/)
    await assert.rejects(
      host.read(request, () => true),
      /Open the Copse/,
    )
  })

  it('replies exactly once and ignores a late or unknown response', async () => {
    const host = new RemoteInterface()
    let replyId = ''
    host.attach((id) => {
      replyId = id
    })
    const pending = host.read(request, () => true)
    host.reply({ id: 'unknown', ok: true, value: 'wrong' })
    host.reply({ id: replyId, ok: true, value: ['t'] })
    host.reply({ id: replyId, ok: true, value: ['duplicate'] })
    assert.deepEqual(await pending, ['t'])
  })

  it('changes session identity and clears snapshots when the owner changes', () => {
    const host = new RemoteInterface()
    host.attach(() => {})
    host.publish({ projectId: 'p', threads: [] })
    const before = host.snapshot()
    host.attach(() => {})
    const after = host.snapshot()
    assert.notEqual(before.sessionId, after.sessionId)
    assert.deepEqual(after.views, [])
    assert.ok(after.revision > before.revision)
  })
})
