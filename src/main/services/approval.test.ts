import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { requestApproval, setApprovalHandler, type ApprovalRequest } from './approval.ts'

const req: ApprovalRequest = { title: 'Run shell', body: 'rm -rf build', type: 'shell' }

describe('requestApproval pluggable transport', () => {
  afterEach(() => setApprovalHandler(null))

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
