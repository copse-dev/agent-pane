import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  requestApproval,
  setApprovalHandler,
  startDockAttention,
  type ApprovalRequest,
  type DockAttention,
} from './approval.ts'

const req: ApprovalRequest = { title: 'Run shell', body: 'rm -rf build', type: 'shell' }

describe('requestApproval pluggable transport', () => {
  afterEach(() => {
    setApprovalHandler(null)
  })

  it('denies (without hanging) when no handler is registered', async () => {
    setApprovalHandler(null)
    assert.deepEqual(await requestApproval(req), { approved: false, remember: false })
  })

  it('routes the request to the registered handler', async () => {
    const seen: ApprovalRequest[] = []
    setApprovalHandler(async (r) => {
      seen.push(r)
      return { approved: true, remember: true }
    })
    assert.deepEqual(await requestApproval(req), { approved: true, remember: true })
    assert.deepEqual(seen, [req])
  })

  it('reverts to denying once the handler is cleared', async () => {
    setApprovalHandler(async () => ({ approved: true, remember: false }))
    assert.equal((await requestApproval(req)).approved, true)
    setApprovalHandler(null)
    assert.equal((await requestApproval(req)).approved, false)
  })
})

describe('startDockAttention', () => {
  function fakeDock(): {
    dock: DockAttention
    calls: { bounce: Array<string | undefined>; cancel: number[] }
  } {
    const calls: { bounce: Array<string | undefined>; cancel: number[] } = {
      bounce: [],
      cancel: [],
    }
    const dock: DockAttention = {
      bounce(type) {
        calls.bounce.push(type)
        return 42
      },
      cancelBounce(id) {
        calls.cancel.push(id)
      },
    }
    return { dock, calls }
  }

  it('bounces critically on start and cancels that bounce on stop', () => {
    const { dock, calls } = fakeDock()
    const stop = startDockAttention(dock)
    assert.deepEqual(calls.bounce, ['critical'])
    assert.deepEqual(calls.cancel, [])
    stop()
    assert.deepEqual(calls.cancel, [42])
  })

  it('cancels at most once even if stopped repeatedly', () => {
    const { dock, calls } = fakeDock()
    const stop = startDockAttention(dock)
    stop()
    stop()
    assert.deepEqual(calls.cancel, [42])
  })

  it('is a no-op (no throw) when there is no dock', () => {
    const stop = startDockAttention(undefined)
    assert.doesNotThrow(stop)
  })
})
