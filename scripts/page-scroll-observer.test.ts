import assert from 'node:assert/strict'
import { it } from 'node:test'
import { JSDOM } from 'jsdom'
import { observePageScrollAfterSetup } from '../tests/demo/helpers/page-scroll-observer.ts'

function fixture(): {
  start: () => Promise<unknown>
  scroll: (offset: number) => void
  deliver: () => void
  position: () => number
  jumps: () => number[] | undefined
  close: () => void
} {
  const dom = new JSDOM('', { runScripts: 'outside-only' })
  const { window } = dom
  let position = 0
  Object.defineProperty(window, 'scrollY', { get: () => position })
  Object.defineProperty(window, 'scrollTo', {
    value(_x: number, offset: number): void {
      // The real scroll offset changes before the browser dispatches its event.
      // Tests control that boundary explicitly instead of relying on a timer.
      position = offset
    },
  })
  return {
    start(): Promise<unknown> {
      // Exercise the same serialization boundary as browser.execute: no imported
      // bindings or surrounding test closures are available inside this callback.
      const result: unknown = window.eval(`(${observePageScrollAfterSetup.toString()})(1800)`)
      assert.ok(result instanceof window.Promise)
      return result
    },
    scroll(offset): void {
      window.scrollTo(0, offset)
    },
    deliver(): void {
      window.dispatchEvent(new window.Event('scroll'))
    },
    position: () => position,
    jumps: () => window.__pageJumps,
    close(): void {
      window.close()
    },
  }
}

it('waits for the queued setup scroll before arming the serialized observer', async () => {
  const page = fixture()
  try {
    let completed = false
    const setup = page.start().then((value) => {
      completed = true
      return value
    })
    assert.equal(page.position(), 1800)
    await Promise.resolve()
    assert.equal(completed, false, 'a synchronous offset read must not complete setup')
    assert.equal(page.jumps(), undefined)
    page.deliver()
    assert.equal(await setup, 1800)
    assert.deepEqual(Array.from(page.jumps() ?? []), [])
  } finally {
    page.close()
  }
})

it('detects post-arm movement away and back to the setup offset without filtering any events', async () => {
  const page = fixture()
  try {
    const setup = page.start()
    page.deliver()
    await setup
    page.scroll(1880)
    page.deliver()
    page.scroll(1800)
    page.deliver()
    // Retain even another delivered event at the same position.
    page.deliver()
    const jumps = Array.from(page.jumps() ?? [])
    assert.deepEqual(jumps, [1880, 1800, 1800])
    assert.throws(
      () => {
        assert.deepEqual(jumps, [])
      },
      { name: 'AssertionError' },
    )
  } finally {
    page.close()
  }
})

it('rejects a setup event delivered at the wrong position instead of arming', async () => {
  const page = fixture()
  try {
    const setup = page.start()
    page.scroll(1700)
    page.deliver()
    await assert.rejects(setup, /Setup scroll settled at 1700, expected 1800/)
    assert.equal(page.jumps(), undefined)
  } finally {
    page.close()
  }
})

it('rejects a setup that cannot produce a scroll event because the page is already there', () => {
  const page = fixture()
  try {
    page.scroll(1800)
    assert.throws(() => page.start(), /Expected the setup scroll to change the page position/)
    assert.equal(page.jumps(), undefined)
  } finally {
    page.close()
  }
})
