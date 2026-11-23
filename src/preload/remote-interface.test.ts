import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteReply } from '../shared/remote-interface.ts'
import { replyToRemoteRead } from './remote-interface.ts'

/** A reply channel whose first `failures` sends are rejected with `reason`. */
function fixture(
  failures = 0,
  reason = 'not sent',
): {
  sendReply: (reply: RemoteReply) => Promise<unknown>
  attempts: RemoteReply[]
} {
  const attempts: RemoteReply[] = []
  return {
    attempts,
    sendReply: (reply): Promise<unknown> => {
      attempts.push(reply)
      return attempts.length <= failures ? Promise.reject(new Error(reason)) : Promise.resolve(null)
    },
  }
}

test('a read that succeeds is answered with its value', async () => {
  const { sendReply, attempts } = fixture()
  await replyToRemoteRead(sendReply, 'r1', Promise.resolve(['thread']))
  assert.deepEqual(attempts, [{ id: 'r1', ok: true, value: ['thread'] }])
})

test('a read that fails is answered with its reason', async () => {
  const { sendReply, attempts } = fixture()
  await replyToRemoteRead(sendReply, 'r1', Promise.reject(new Error('Thread unavailable.')))
  assert.deepEqual(attempts, [{ id: 'r1', ok: false, error: 'Thread unavailable.' }])
})

test('a result that cannot be sent is answered with why, not left to time out', async () => {
  const refusal = 'Too large to send in one request: more than 960 MB (remote:reply).'
  const { sendReply, attempts } = fixture(1, refusal)
  await replyToRemoteRead(sendReply, 'r1', Promise.resolve('a very large result'))
  assert.deepEqual(attempts, [
    { id: 'r1', ok: true, value: 'a very large result' },
    { id: 'r1', ok: false, error: refusal },
  ])
})

test('a reply that can never be sent settles quietly', async () => {
  const { sendReply, attempts } = fixture(2)
  await replyToRemoteRead(sendReply, 'r1', Promise.resolve('value'))
  assert.equal(attempts.length, 2)
})

test('a long reason is cut to what main accepts', async () => {
  const { sendReply, attempts } = fixture()
  await replyToRemoteRead(sendReply, 'r1', Promise.reject(new Error('x'.repeat(5_000))))
  const [reply] = attempts
  assert.ok(reply && !reply.ok)
  assert.equal(reply.error.length, 2_000)
})
