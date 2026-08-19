import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  requestBackgroundCompletionWake,
  resolveBackgroundCompletionWakeHandler,
  runWithBackgroundCompletionWakeHandler,
  setBackgroundCompletionWakeHandler,
  type BackgroundCompletionWakeRequest,
} from './background-completion-wake.ts'

const REQUEST: BackgroundCompletionWakeRequest = {
  operationId: 'bg-1',
  owner: { projectId: 'project', threadId: 'thread' },
  turnTreeId: 'turn-tree',
  exitCode: 0,
  timedOut: false,
}

describe('background completion wake', () => {
  it('returns stale when no handler is armed', async () => {
    setBackgroundCompletionWakeHandler(null)
    assert.equal(await requestBackgroundCompletionWake(REQUEST, null), 'stale')
  })

  it('keeps an ALS-armed handler usable after the async scope ends', async () => {
    setBackgroundCompletionWakeHandler(null)
    const seen: string[] = []
    let armed = resolveBackgroundCompletionWakeHandler()

    await runWithBackgroundCompletionWakeHandler(
      async (request) => {
        seen.push(request.operationId)
        return 'completed'
      },
      async () => {
        armed = resolveBackgroundCompletionWakeHandler()
        assert.ok(armed)
      },
    )

    // Child-process exit callbacks resume outside the ALS scope that armed them.
    assert.equal(resolveBackgroundCompletionWakeHandler(), null)
    assert.equal(await requestBackgroundCompletionWake(REQUEST, armed), 'completed')
    assert.deepEqual(seen, ['bg-1'])
  })
})
