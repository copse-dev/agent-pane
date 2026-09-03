import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  approveRemoteAcpInstall,
  setRemoteAcpInstallApprover,
} from './acp-remote-install-approval.ts'

describe('approveRemoteAcpInstall', () => {
  afterEach(() => {
    setRemoteAcpInstallApprover(null)
  })

  it('cancels a pending install approval when the run aborts', { timeout: 500 }, async () => {
    let approverSignal: AbortSignal | undefined
    setRemoteAcpInstallApprover(
      (_request, signal) =>
        new Promise((resolve) => {
          approverSignal = signal
          signal?.addEventListener(
            'abort',
            () => {
              resolve(false)
            },
            { once: true },
          )
        }),
    )
    const controller = new AbortController()
    const pending = approveRemoteAcpInstall(
      { title: 'Install?', body: 'Install the adapter remotely.' },
      controller.signal,
    )
    await Promise.resolve()

    controller.abort()

    assert.equal(await pending, false)
    assert.equal(approverSignal?.aborted, true)
  })
})
