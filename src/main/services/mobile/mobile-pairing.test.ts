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
  assert.equal(requests.respond('control', '654321', current.id, true), false)
  assert.equal(requests.respond('control', current.code, current.id, true), true)
  assert.equal(await second, 'control')
  assert.equal(requests.current(), null)
  assert.equal(requests.respond('control', current.code, current.id, true), false)
})

it('grants control over the LAN IP only with the local-root acknowledgement', async () => {
  const requests = new MobilePairing()
  const result = requests.request('Phone', '123456', new AbortController().signal)
  const current = requests.current()
  assert.ok(current)
  assert.equal(current.trustedName, false)
  assert.equal(requests.respond('control', current.code, current.id), false)
  assert.deepEqual(requests.current(), current)
  assert.equal(requests.respond('control', current.code, current.id, true), true)
  assert.equal(await result, 'control')
})

it('grants control on desktop approval alone over the trusted name', async () => {
  const requests = new MobilePairing()
  const result = requests.request('Phone', '123456', new AbortController().signal, {
    trustedName: true,
    relayed: false,
  })
  const current = requests.current()
  assert.ok(current)
  assert.equal(current.trustedName, true)
  assert.equal(current.relayed, false)
  assert.equal(requests.respond('control', current.code, current.id), true)
  assert.equal(await result, 'control')
})

it('shows the desktop that a phone asked through the relay', async () => {
  const requests = new MobilePairing()
  const result = requests.request('Phone', '123456', new AbortController().signal, {
    trustedName: true,
    relayed: true,
  })
  const current = requests.current()
  assert.ok(current)
  assert.equal(current.relayed, true)
  // The relay serves only the publicly trusted name, so approval alone grants control.
  assert.equal(requests.respond('control', current.code, current.id), true)
  assert.equal(await result, 'control')
})

it('never lets a relayed request displace one from the local network', async () => {
  const requests = new MobilePairing()
  const lan = requests.request('Desk phone', '111111', new AbortController().signal, {
    trustedName: true,
    relayed: false,
  })
  const atDesk = requests.current()
  assert.ok(atDesk)
  // A relayed request while the LAN one is pending is refused at once.
  const relayed = requests.request('Elsewhere', '222222', new AbortController().signal, {
    trustedName: true,
    relayed: true,
  })
  assert.equal(await relayed, null)
  assert.deepEqual(requests.current(), atDesk)
  assert.equal(requests.respond('control', atDesk.code, atDesk.id), true)
  assert.equal(await lan, 'control')
})

it('lets a request from the local network replace a relayed one', async () => {
  const requests = new MobilePairing()
  const relayed = requests.request('Elsewhere', '222222', new AbortController().signal, {
    trustedName: true,
    relayed: true,
  })
  const lan = requests.request('Desk phone', '111111', new AbortController().signal, {
    trustedName: true,
    relayed: false,
  })
  assert.equal(await relayed, null)
  const current = requests.current()
  assert.equal(current?.label, 'Desk phone')
  assert.equal(current.relayed, false)
  assert.equal(requests.respond('read', current.code, current.id), true)
  assert.equal(await lan, 'read')
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
