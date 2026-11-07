import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DesktopSession, type DesktopTransport, type DesktopInput } from './desktop-session.ts'

const owner = { projectId: 'project', threadId: 'thread' }
interface Fixture {
  session: DesktopSession
  controller: AbortController
  sent: DesktopInput[]
  cleanupErrors: unknown[]
  receive(value: unknown): void
  exit(error: Error): void
  readonly removed: number
  readonly admitted: boolean
  readonly revoked: boolean
  failRemoval: boolean
}
function fixture(lifetimeMs?: number): Fixture {
  let admitted = true
  let receive: (line: string) => void = () => {}
  let exit: (error: Error) => void = () => {}
  let removed = 0
  let revoked = false
  let failRemoval = false
  const sent: DesktopInput[] = []
  const controller = new AbortController()
  const transport: DesktopTransport = {
    async start(onLine, onExit) {
      receive = onLine
      exit = onExit
    },
    async send(request) {
      sent.push(request)
    },
    async remove() {
      removed++
      if (failRemoval) throw new Error('delete failed')
    },
    revoke() {
      revoked = true
    },
  }
  const cleanupErrors: unknown[] = []
  const session = new DesktopSession(
    owner,
    transport,
    controller.signal,
    (error) => cleanupErrors.push(error),
    () => {
      admitted = false
    },
    lifetimeMs,
  )
  return {
    session,
    controller,
    sent,
    cleanupErrors,
    receive(value: unknown): void {
      receive(JSON.stringify(value))
    },
    exit(error: Error): void {
      exit(error)
    },
    get admitted(): boolean {
      return admitted
    },
    get removed(): number {
      return removed
    },
    get revoked(): boolean {
      return revoked
    },
    set failRemoval(value: boolean) {
      failRemoval = value
    },
  }
}
async function start(f: Fixture): Promise<void> {
  const ready = f.session.start()
  f.receive({ event: 'ready', title: 'Copse', width: 1280, height: 800 })
  assert.equal(await ready, 'Copse')
}

describe('isolated desktop authority and lifecycle', () => {
  it('requires exact project and thread ownership before sending input', async () => {
    const f = fixture()
    try {
      await start(f)
      for (const other of [
        { ...owner, threadId: 'other' },
        { ...owner, projectId: 'other' },
      ]) {
        await assert.rejects(
          f.session.execute(other, { action: 'key', key: 'Tab' }),
          /another thread/,
        )
      }
      assert.deepEqual(f.sent, [])
      const input = f.session.execute(owner, { action: 'key', key: 'Tab' })
      f.receive({ event: 'input-complete' })
      await input
      assert.deepEqual(f.sent, [{ action: 'key', key: 'Tab' }])
    } finally {
      await f.session.stop()
    }
  })

  it('cancels startup and deletes even when readiness never arrives', async () => {
    const f = fixture()
    const ready = f.session.start()
    f.controller.abort()
    await assert.rejects(ready, /revoked/)
    assert.equal(f.revoked, true)
    assert.equal(f.removed, 1)
    await assert.rejects(f.session.execute(owner, { action: 'screenshot' }), /revoked/)
  })

  it('releases admission after parent cancellation and expiry delete the guest', async () => {
    for (const expires of [false, true]) {
      const f = fixture(expires ? 1 : undefined)
      await start(f)
      assert.equal(f.admitted, true)
      if (!expires) f.controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(f.revoked, true)
      assert.equal(f.removed, 1)
      assert.equal(f.admitted, false)
      await f.session.stop()
      assert.equal(f.removed, 1)
    }
  })

  it('revokes synchronously before deletion, retains failed cleanup for retry', async () => {
    const f = fixture()
    await start(f)
    f.failRemoval = true
    const stopped = f.session.stop()
    assert.equal(f.revoked, true)
    assert.equal(f.admitted, true)
    await assert.rejects(f.session.execute(owner, { action: 'key', key: 'Tab' }), /revoked/)
    await assert.rejects(stopped, /delete failed/)
    assert.equal(f.admitted, true)
    f.failRemoval = false
    await f.session.stop()
    assert.equal(f.removed, 2)
    assert.equal(f.admitted, false)
  })

  it('revokes on malformed or out-of-order guest messages', async () => {
    for (const message of [
      { event: 'ready', title: 'Copse', width: 1, height: 1 },
      { event: 'input-complete' },
    ]) {
      const f = fixture()
      const ready = f.session.start()
      f.receive(message)
      await assert.rejects(ready)
      assert.equal(f.revoked, true)
      assert.equal(f.removed, 1)
    }
  })

  it('permits one operation and rejects a late response after cancellation', async () => {
    const f = fixture()
    await start(f)
    const screenshot = f.session.execute(owner, { action: 'screenshot' })
    await assert.rejects(
      f.session.execute(owner, { action: 'key', key: 'Tab' }),
      /already in progress/,
    )
    f.controller.abort()
    f.receive({ event: 'screenshot', png: 'AAAA' })
    await assert.rejects(screenshot, /revoked/)
    assert.equal(f.revoked, true)
  })

  it('rejects a corrupt screenshot and destroys the guest', async () => {
    const f = fixture()
    await start(f)
    const screenshot = f.session.execute(owner, { action: 'screenshot' })
    f.receive({ event: 'screenshot', png: Buffer.from('not a png').toString('base64') })
    await assert.rejects(screenshot, /Invalid guest desktop PNG/)
    assert.equal(f.removed, 1)
  })

  it('handles process failure between requests by revoking future access', async () => {
    const f = fixture()
    await start(f)
    f.exit(new Error('guest crashed'))
    assert.equal(f.revoked, true)
    await assert.rejects(f.session.execute(owner, { action: 'screenshot' }), /revoked/)
    await f.session.stop()
    assert.equal(f.removed, 1)
  })
})
