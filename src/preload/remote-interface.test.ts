import assert from 'node:assert/strict'
import { test } from 'node:test'
import { replyToRemoteRead } from './remote-interface.ts'

interface Reply {
  id: string
  ok: boolean
  value?: unknown
  error?: string
}

/** A `remote:reply` channel whose first `failures` sends are rejected with `reason`. */
function fixture(
  failures = 0,
  reason = 'not sent',
): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  attempts: Reply[]
} {
  const attempts: Reply[] = []
  return {
    attempts,
    invoke: (channel, ...args): Promise<unknown> => {
      assert.equal(channel, 'remote:reply')
      const reply: unknown = args[0]
      assert.ok(typeof reply === 'object' && reply !== null && 'id' in reply && 'ok' in reply)
      assert.ok(typeof reply.id === 'string' && typeof reply.ok === 'boolean')
      attempts.push({
        id: reply.id,
        ok: reply.ok,
        ...('value' in reply ? { value: reply.value } : {}),
        ...('error' in reply && typeof reply.error === 'string' ? { error: reply.error } : {}),
      })
      return attempts.length <= failures ? Promise.reject(new Error(reason)) : Promise.resolve(null)
    },
  }
}

test('a read that succeeds is answered with its value', async () => {
  const { invoke, attempts } = fixture()
  await replyToRemoteRead(invoke, 'r1', Promise.resolve(['thread']))
  assert.deepEqual(attempts, [{ id: 'r1', ok: true, value: ['thread'] }])
})

test('a read that fails is answered with its reason', async () => {
  const { invoke, attempts } = fixture()
  await replyToRemoteRead(invoke, 'r1', Promise.reject(new Error('Thread unavailable.')))
  assert.deepEqual(attempts, [{ id: 'r1', ok: false, error: 'Thread unavailable.' }])
})

test('a result that cannot be sent is answered with why, not left to time out', async () => {
  const refusal = 'Too large to send in one request: more than 960 MB (remote:reply).'
  const { invoke, attempts } = fixture(1, refusal)
  await replyToRemoteRead(invoke, 'r1', Promise.resolve('a very large result'))
  assert.deepEqual(attempts, [
    { id: 'r1', ok: true, value: 'a very large result' },
    { id: 'r1', ok: false, error: refusal },
  ])
})

test('a reply that can never be sent settles quietly', async () => {
  const { invoke, attempts } = fixture(2)
  await replyToRemoteRead(invoke, 'r1', Promise.resolve('value'))
  assert.equal(attempts.length, 2)
})

test('a long reason is cut to what main accepts', async () => {
  const { invoke, attempts } = fixture()
  await replyToRemoteRead(invoke, 'r1', Promise.reject(new Error('x'.repeat(5_000))))
  assert.equal(attempts[0]?.error?.length, 2_000)
})
