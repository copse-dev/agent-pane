import { parseIpcArgs } from '../../ipc/ipc-guards.ts'
import { clientActionOfferSchema } from '@shared/client-actions.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ClientActions } from './client-actions.ts'
import { clientActionSubmissionSchema, type ClientActionOffer } from '@shared/client-actions.ts'

const offer = (): ClientActionOffer => ({
  projectId: 'p',
  threadId: 't',
  revision: randomUUID(),
  actions: [{ id: 'next-step', label: 'Run the tests', kind: 'next-step' }],
})
describe('desktop offered client actions', () => {
  it('decodes the single-payload IPC publication without wrapping it in a tuple', () => {
    const row = offer()
    assert.deepEqual(parseIpcArgs(clientActionOfferSchema.nullable(), [row]), row)
    assert.equal(parseIpcArgs(clientActionOfferSchema.nullable(), [null]), null)
  })
  it('consumes exact scope/revision/action once before dispatch and rejects stale references', async () => {
    const registry = new ClientActions(),
      row = offer()
    let calls = 0
    registry.publish(1, row, async () => {
      calls++
      return true
    })
    const reference = {
      projectId: 'p',
      threadId: 't',
      revision: row.revision,
      actionId: 'next-step',
    }
    for (const invalid of [
      { ...reference, projectId: 'other' },
      { ...reference, threadId: 'other' },
      { ...reference, revision: randomUUID() },
      { ...reference, actionId: 'unknown' },
    ])
      assert.equal(await registry.perform(invalid, () => true), false)
    assert.equal(await registry.perform(reference, () => false), false)
    assert.equal(calls, 0)
    assert.equal(await registry.perform(reference, () => true), true)
    assert.equal(await registry.perform(reference, () => true), false)
    assert.equal(calls, 1)
  })
  it('clones offers and clears only the owner that published them', () => {
    const registry = new ClientActions(),
      row = offer()
    registry.publish(1, row, async () => true)
    row.actions.length = 0
    registry.clear(2)
    assert.equal(registry.snapshot()?.actions.length, 1)
    const copy = registry.snapshot()
    assert.ok(copy)
    copy.actions.length = 0
    assert.equal(registry.snapshot()?.actions.length, 1)
    registry.clear(1)
    assert.equal(registry.snapshot(), null)
  })
  it('accepts references only, with no arbitrary prompt, command, path or grant', () => {
    const input = {
      version: 1,
      sessionId: randomUUID(),
      submissionId: randomUUID(),
      projectId: 'p',
      threadId: 't',
      revision: randomUUID(),
      actionId: 'next-step',
    }
    assert.ok(clientActionSubmissionSchema.safeParse(input).success)
    for (const key of ['prompt', 'command', 'path', 'remember', 'grantScope'])
      assert.equal(
        clientActionSubmissionSchema.safeParse({ ...input, [key]: 'arbitrary' }).success,
        false,
      )
  })
})
