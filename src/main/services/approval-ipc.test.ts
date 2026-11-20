import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  confirmDesktopProposal,
  proposedDesktopApproval,
  type ApprovalRequest,
} from './approval.ts'

const request: ApprovalRequest = {
  title: 'Run outside sandbox?',
  body: 'example command',
  type: 'shell',
  allowRemember: true,
  allowTurnTreeLease: true,
  turnTreeLeaseLabel: 'Allow bounded retries',
}

describe('desktop approval IPC decision', () => {
  it('requires independent confirmation before a renderer approval settles', async () => {
    let finish: ((approved: boolean) => void) | undefined
    const proposed = proposedDesktopApproval(request, true, true, 'turn-tree')
    const pending = confirmDesktopProposal(
      request,
      proposed,
      new AbortController().signal,
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    assert.equal(settled, false)
    finish?.(false)
    assert.deepEqual(await pending, { approved: false, remember: false, resolution: 'user' })
  })

  it('passes the main-owned request and scope to confirmation', async () => {
    const proposed = proposedDesktopApproval(request, true, true, 'turn-tree')
    const seen: Array<{ request: ApprovalRequest; remember: boolean; scope: string | undefined }> =
      []
    const confirmed = await confirmDesktopProposal(
      request,
      proposed,
      new AbortController().signal,
      async (original, answer) => {
        seen.push({ request: original, remember: answer.remember, scope: answer.grantScope })
        return true
      },
    )
    assert.equal(confirmed.approved, true)
    assert.deepEqual(seen, [{ request, remember: true, scope: 'turn-tree' }])
  })

  it('rejects grants the main-owned request did not offer', () => {
    const single = { ...request, allowRemember: false, allowTurnTreeLease: false }
    assert.throws(() => proposedDesktopApproval(single, true, true, 'once'))
    assert.throws(() => proposedDesktopApproval(single, true, false, 'turn-tree'))
    assert.deepEqual(proposedDesktopApproval(single, false, true, 'turn-tree'), {
      approved: false,
      remember: false,
      resolution: 'user',
    })
  })

  it('denies if confirmation fails or the request is cancelled', async () => {
    const proposed = proposedDesktopApproval(request, true, false, 'once')
    const aborted = new AbortController()
    aborted.abort()
    assert.equal(
      (await confirmDesktopProposal(request, proposed, aborted.signal, async () => true)).approved,
      false,
    )
    assert.equal(
      (
        await confirmDesktopProposal(request, proposed, new AbortController().signal, async () => {
          throw new Error('dialog closed')
        })
      ).approved,
      false,
    )
  })
})
