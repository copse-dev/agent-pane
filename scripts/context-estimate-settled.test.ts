import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  installCaptureSettle,
  withoutCaptureSettle,
  type CaptureSession,
} from '../tests/e2e/helpers/context-estimate-settled.ts'

type Wrapped = (
  this: unknown,
  origCommand: (...args: unknown[]) => Promise<unknown>,
  ...args: unknown[]
) => Promise<unknown>

function fakeSession(): { session: CaptureSession; overrides: Map<string, Wrapped> } {
  const overrides = new Map<string, Wrapped>()
  return {
    overrides,
    session: {
      overwriteCommand: (name, fn): void => {
        overrides.set(name, fn)
      },
    },
  }
}

function override(overrides: Map<string, Wrapped>, name: string): Wrapped {
  const fn = overrides.get(name)
  assert.ok(fn, `${name} is overridden`)
  return fn
}

describe('capture settle', () => {
  it('waits for the estimate before both screenshot commands', async () => {
    const { session, overrides } = fakeSession()
    const order: string[] = []
    installCaptureSettle(session, async () => {
      order.push('settle')
    })
    assert.deepEqual([...overrides.keys()], ['takeScreenshot', 'takeElementScreenshot'])

    const capture = async (...args: unknown[]): Promise<unknown> => {
      order.push(`capture:${args.join(',')}`)
      return 'png'
    }
    assert.equal(await override(overrides, 'takeScreenshot').call(null, capture), 'png')
    assert.equal(
      await override(overrides, 'takeElementScreenshot').call(null, capture, 'element-1'),
      'png',
    )
    assert.deepEqual(order, ['settle', 'capture:', 'settle', 'capture:element-1'])
  })

  it('fails the capture, without taking it, when the estimate never settles', async () => {
    const { session, overrides } = fakeSession()
    installCaptureSettle(session, async () => {
      throw new Error('context estimate still pending')
    })
    let captured = false
    await assert.rejects(
      override(overrides, 'takeScreenshot').call(null, async () => {
        captured = true
      }),
      /context estimate still pending/,
    )
    assert.equal(captured, false)
  })

  it('captures a failure dump as-is, without waiting', async () => {
    const { session, overrides } = fakeSession()
    let settles = 0
    installCaptureSettle(session, async () => {
      settles += 1
    })
    const shot = override(overrides, 'takeScreenshot')
    await withoutCaptureSettle(() => shot.call(null, async () => 'png'))
    assert.equal(settles, 0)
    // The skip ends with the dump: the next capture waits again.
    await shot.call(null, async () => 'png')
    assert.equal(settles, 1)
  })

  it('patches a session once', () => {
    const { session, overrides } = fakeSession()
    let installs = 0
    const counting: CaptureSession = {
      overwriteCommand: (name, fn): void => {
        installs += 1
        session.overwriteCommand?.(name, fn)
      },
    }
    installCaptureSettle(counting)
    installCaptureSettle(counting)
    assert.equal(installs, 2)
    assert.equal(overrides.size, 2)
  })
})
