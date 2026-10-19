import assert from 'node:assert/strict'
import { it } from 'node:test'
import { MobilePairing } from './mobile-pairing.ts'

it('rejects delayed decisions when a replacement reuses the display code and label', async () => {
  const requests = new MobilePairing()
  const first = requests.request('Phone', '123456', new AbortController().signal)
  const old = requests.current()
  assert.ok(old)
  const second = requests.request('Phone', '123456', new AbortController().signal)
  const current = requests.current()
  assert.ok(current)
  assert.notEqual(current.id, old.id)
  assert.equal(await first, null)
  for (const decision of ['control', 'read', 'deny'] as const) {
    assert.equal(requests.respond(decision, old.code, old.id), false)
    assert.deepEqual(requests.current(), current)
  }
  assert.equal(requests.respond('control', '654321', current.id), false)
  assert.equal(requests.respond('control', current.code, current.id), true)
  assert.equal(await second, 'control')
  assert.equal(requests.current(), null)
  assert.equal(requests.respond('control', current.code, current.id), false)
})

it('allows read-only and denial for the matching request', async () => {
  const requests = new MobilePairing()
  for (const decision of ['read', 'deny'] as const) {
    const result = requests.request('Phone', '123456', new AbortController().signal)
    const current = requests.current()
    assert.ok(current)
    assert.equal(requests.respond(decision, current.code, current.id), true)
    assert.equal(await result, decision === 'deny' ? null : 'read')
  }
})

it('clears expired or stopped consent and rejects a delayed desktop response', async () => {
  const requests = new MobilePairing()
  const controller = new AbortController()
  const result = requests.request('Phone', '123456', controller.signal)
  const pending = requests.current()
  assert.ok(pending)
  controller.abort()
  assert.equal(requests.current(), null)
  assert.equal(await result, null)
  assert.equal(requests.respond('control', pending.code, pending.id), false)
  assert.equal(await requests.request('Phone', '123456', controller.signal), null)
  assert.equal(requests.current(), null)
})

it('does not let cancellation from a replaced request remove the current prompt', async () => {
  const requests = new MobilePairing()
  const first = new AbortController()
  const old = requests.request('Phone', '123456', first.signal)
  const next = requests.request('Phone', '123456', new AbortController().signal)
  const current = requests.current()
  assert.ok(current)
  first.abort()
  assert.deepEqual(requests.current(), current)
  assert.equal(await old, null)
  requests.respond('read', current.code, current.id)
  assert.equal(await next, 'read')
})
