import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withoutMainOwnedThreadFields } from './thread-meta-guard.ts'

describe('withoutMainOwnedThreadFields', () => {
  it('drops a renderer-supplied remote-agent link and keeps everything else', () => {
    const forged = {
      title: 'Renamed',
      remoteAgentLink: { provider: 'cursor', agentId: 'bc-attacker', createdAt: 1 },
    }
    assert.deepEqual(withoutMainOwnedThreadFields(forged), { title: 'Renamed' })
  })

  it('drops an explicit undefined, so a stale renderer copy cannot erase the stored link', () => {
    const patch: Record<string, unknown> = { draft: 'x', remoteAgentLink: undefined }
    const guarded = withoutMainOwnedThreadFields(patch)
    assert.equal(Object.hasOwn(guarded, 'remoteAgentLink'), false)
    assert.deepEqual(guarded, { draft: 'x' })
  })

  it('leaves a payload without main-owned fields unchanged', () => {
    assert.deepEqual(withoutMainOwnedThreadFields({ a: 1, b: [2] }), { a: 1, b: [2] })
  })
})
