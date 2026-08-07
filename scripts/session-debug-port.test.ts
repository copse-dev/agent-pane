import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { describe, it } from 'node:test'
import {
  findFreePort,
  installReloadSessionPortRotation,
  withRotatedDebugPort,
} from '../tests/e2e/helpers/session-debug-port.ts'

describe('withRotatedDebugPort', () => {
  it('replaces an existing debug port rather than adding a second one', () => {
    const args = withRotatedDebugPort(
      ['--app=/shell', '--remote-debugging-port=9760', '--disable-gpu'],
      9999,
    )
    assert.deepEqual(args, ['--app=/shell', '--disable-gpu', '--remote-debugging-port=9999'])
    // A second flag would be worse than none: Chromium takes the first and the
    // driver probes the other, which is the hang this module exists to remove.
    assert.equal(args.filter((a) => a.startsWith('--remote-debugging-port=')).length, 1)
  })

  it('appends when no debug port is present', () => {
    assert.deepEqual(withRotatedDebugPort(['--disable-gpu'], 9100), [
      '--disable-gpu',
      '--remote-debugging-port=9100',
    ])
  })

  it('does not mutate the caller’s array', () => {
    const original = ['--remote-debugging-port=9760']
    withRotatedDebugPort(original, 9999)
    assert.deepEqual(original, ['--remote-debugging-port=9760'])
  })
})

describe('findFreePort', () => {
  it('returns a port that can actually be bound', async () => {
    const port = await findFreePort()
    assert.ok(port > 0 && port < 65536)
    // The point of asking the kernel rather than guessing: the result is free.
    await new Promise<void>((resolve, reject) => {
      const server = createServer()
      server.on('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.close(() => {
          resolve()
        })
      })
    })
  })

  it('does not hand out the same port twice in a row', async () => {
    const [a, b] = await Promise.all([findFreePort(), findFreePort()])
    assert.notEqual(a, b)
  })
})

describe('installReloadSessionPortRotation', () => {
  const makeSession = (): {
    requestedCapabilities: { 'goog:chromeOptions': { args: string[] } }
    reload: ((...args: unknown[]) => Promise<unknown>) | undefined
    overwriteCommand: (
      name: string,
      fn: (
        this: unknown,
        origCommand: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ) => unknown,
    ) => void
    overwrites: number
  } => {
    const session = {
      requestedCapabilities: {
        'goog:chromeOptions': { args: ['--app=/shell', '--remote-debugging-port=9760'] },
      },
      reload: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
      overwrites: 0,
      overwriteCommand(
        name: string,
        fn: (
          this: unknown,
          origCommand: (...args: unknown[]) => unknown,
          ...args: unknown[]
        ) => unknown,
      ): void {
        assert.equal(name, 'reloadSession')
        session.overwrites += 1
        const orig = async (): Promise<string> => 'reloaded'
        session.reload = async (...args: unknown[]): Promise<unknown> =>
          await fn.call(session, orig, ...args)
      },
    }
    return session
  }

  it('rotates the port before delegating to the real reloadSession', async () => {
    const session = makeSession()
    installReloadSessionPortRotation(session, { freePort: async () => 9321 })

    assert.ok(session.reload)
    assert.equal(await session.reload(), 'reloaded')
    assert.deepEqual(session.requestedCapabilities['goog:chromeOptions'].args, [
      '--app=/shell',
      '--remote-debugging-port=9321',
    ])
  })

  it('rotates to a different port on every reload', async () => {
    const session = makeSession()
    let next = 9400
    installReloadSessionPortRotation(session, {
      freePort: async () => {
        next += 1
        return next
      },
    })

    assert.ok(session.reload)
    await session.reload()
    const first = [...session.requestedCapabilities['goog:chromeOptions'].args]
    await session.reload()
    const second = session.requestedCapabilities['goog:chromeOptions'].args
    assert.notDeepEqual(first, second)
    assert.ok(second.includes('--remote-debugging-port=9402'))
  })

  it('leaves explicit capabilities alone', async () => {
    const session = makeSession()
    installReloadSessionPortRotation(session, {
      freePort: async () => {
        throw new Error('must not pick a port when the caller passed capabilities')
      },
    })

    assert.ok(session.reload)
    assert.equal(await session.reload({ browserName: 'chrome' }), 'reloaded')
    assert.deepEqual(session.requestedCapabilities['goog:chromeOptions'].args, [
      '--app=/shell',
      '--remote-debugging-port=9760',
    ])
  })

  it('is idempotent (does not wrap twice)', () => {
    const session = makeSession()
    installReloadSessionPortRotation(session, { freePort: async () => 9321 })
    installReloadSessionPortRotation(session, { freePort: async () => 9321 })
    assert.equal(session.overwrites, 1)
  })
})
