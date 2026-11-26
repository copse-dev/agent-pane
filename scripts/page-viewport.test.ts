import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  DEMO_PAGE_SIZE,
  installPageViewport,
  type PageSize,
  type ViewportSession,
} from '../tests/demo/helpers/page-viewport.ts'

type Wrapped = (
  this: unknown,
  origCommand: (...args: unknown[]) => Promise<unknown>,
  ...args: unknown[]
) => Promise<unknown>

interface FakeWindow {
  outer: PageSize
  /** Browser UI and infobars above the page, as `frameFor` decides per outer size. */
  frameFor: (outer: PageSize) => PageSize
  resizes: PageSize[]
}

const globals: { window?: unknown } = globalThis

afterEach(() => {
  delete globals.window
})

/** A session whose window commands go through the installed overrides, as WDIO's do. */
function fakeSession(fake: FakeWindow): ViewportSession {
  const overrides = new Map<string, Wrapped>()
  const call = async (
    name: string,
    orig: (...args: unknown[]) => Promise<unknown>,
    ...args: unknown[]
  ): Promise<unknown> => {
    const fn = overrides.get(name)
    return fn ? await fn.call(null, orig, ...args) : await orig(...args)
  }
  const setOuter = async (...args: unknown[]): Promise<unknown> => {
    const [width, height] = args
    assert.equal(typeof width, 'number')
    assert.equal(typeof height, 'number')
    fake.outer = { width: Number(width), height: Number(height) }
    fake.resizes.push(fake.outer)
    return null
  }
  return {
    execute: async (script): Promise<PageSize> => {
      const frame = fake.frameFor(fake.outer)
      globals.window = {
        outerWidth: fake.outer.width,
        outerHeight: fake.outer.height,
        innerWidth: fake.outer.width - frame.width,
        innerHeight: fake.outer.height - frame.height,
      }
      return script()
    },
    setWindowSize: async (width, height) => await call('setWindowSize', setOuter, width, height),
    overwriteCommand: (name, fn): void => {
      overrides.set(name, fn)
    },
  }
}

function getWindowSize(session: ViewportSession): Promise<PageSize> {
  return session.execute(() => ({ width: window.innerWidth, height: window.innerHeight }))
}

describe('demo page viewport', () => {
  it('sizes the page, not the window, under a toolbar and infobars', async () => {
    const fake: FakeWindow = {
      outer: { width: 1280, height: 800 },
      frameFor: () => ({ width: 0, height: 200 }),
      resizes: [],
    }
    const session = fakeSession(fake)
    await installPageViewport(session)
    assert.deepEqual(await getWindowSize(session), DEMO_PAGE_SIZE)
    await session.setWindowSize(390, 844)
    assert.deepEqual(fake.outer, { width: 390, height: 1044 })
    assert.deepEqual(await getWindowSize(session), { width: 390, height: 844 })
  })

  it('measures again when the frame changes as the window resizes', async () => {
    // An infobar that only fits once the window is wide enough.
    const fake: FakeWindow = {
      outer: { width: 600, height: 600 },
      frameFor: (outer) => ({ width: 0, height: outer.width >= 1000 ? 140 : 80 }),
      resizes: [],
    }
    const session = fakeSession(fake)
    await installPageViewport(session)
    assert.deepEqual(await getWindowSize(session), DEMO_PAGE_SIZE)
    assert.deepEqual(fake.resizes, [
      { width: 1280, height: 880 },
      { width: 1280, height: 940 },
    ])
  })

  it('leaves a window without a frame at the size asked for', async () => {
    const fake: FakeWindow = {
      outer: { width: 800, height: 600 },
      frameFor: () => ({ width: 0, height: 0 }),
      resizes: [],
    }
    const session = fakeSession(fake)
    await installPageViewport(session)
    assert.deepEqual(fake.resizes, [DEMO_PAGE_SIZE])
  })

  it('fails the resize when the page never reaches the size asked for', async () => {
    // A frame that grows with every resize never lets the page settle.
    let growth = 0
    const fake: FakeWindow = {
      outer: { width: 1280, height: 800 },
      frameFor: () => ({ width: 0, height: (growth += 10) }),
      resizes: [],
    }
    await assert.rejects(
      installPageViewport(fakeSession(fake)),
      /setWindowSize\(1280, 800\) left a 1280x\d+ page after 3 attempts/,
    )
  })
})
