import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createFakeApi } from '../fake-api.test-support.ts'
import type { ClientActionCommand, ClientActionOffer } from '@shared/client-actions.ts'
import { mountClientActionOffers, type OfferedClientAction } from './client-action-offers.ts'

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
describe('desktop action offer lifecycle', () => {
  it('shares callbacks, revalidates after authorization, and retires changed/expired offers', async () => {
    const base = createFakeApi()
    let command: (value: ClientActionCommand) => void = () => {}
    let offered: ClientActionOffer | null = null,
      claimed = true,
      calls = 0,
      visible = true
    const replies: boolean[] = []
    const actions: OfferedClientAction[] = [
      {
        id: 'next-step',
        label: 'Run tests',
        kind: 'next-step',
        run: (): void => {
          calls++
          visible = false
        },
      },
    ]
    const mount = mountClientActionOffers(
      {
        ...base,
        clientActions: {
          publish: async (value) => {
            offered = value
          },
          claim: async () => claimed,
          reply: async (_id, ok) => {
            replies.push(ok)
          },
          onInvoke: (handler) => {
            command = handler
            return (): void => {}
          },
        },
      },
      () => (visible ? { projectId: 'p', threadId: 't', turnKey: 'turn1', actions } : null),
    )
    assert.ok(offered)
    const reference = (): ClientActionCommand => {
      assert.ok(offered)
      return {
        id: randomUUID(),
        expiresAt: Date.now() + 1000,
        projectId: offered.projectId,
        threadId: offered.threadId,
        revision: offered.revision,
        actionId: 'next-step',
      }
    }
    const stale = reference()
    const firstAction = actions[0]
    assert.ok(firstAction)
    firstAction.label = 'Different action'
    mount.refresh()
    command(stale)
    await flush()
    assert.equal(calls, 0)
    command({ ...reference(), expiresAt: 0 })
    await flush()
    assert.equal(calls, 0)
    claimed = false
    command(reference())
    await flush()
    assert.equal(calls, 0)
    claimed = true
    const good = reference()
    command(good)
    await flush()
    assert.equal(calls, 1)
    assert.equal(offered, null)
    command(good)
    await flush()
    assert.equal(calls, 1)
    assert.deepEqual(replies, [false, false, false, true, false])
    mount.destroy()
  })
})
