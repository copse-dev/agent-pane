import '../../../tests/setup-dom.ts'
import { afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { whenDiffHostVisible } from './git-diff-viewer.ts'

before(() => {
  if (!('ResizeObserver' in globalThis)) {
    class NoopResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = NoopResizeObserver
  }
})

afterEach(() => {
  document.body.replaceChildren()
})

function forceSize(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width })
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height })
}

describe('whenDiffHostVisible', () => {
  it('resolves true immediately when the host already has a layout box', async () => {
    const host = document.createElement('div')
    forceSize(host, 120, 80)
    document.body.append(host)
    await assert.doesNotReject(async () => {
      assert.equal(await whenDiffHostVisible(host), true)
    })
  })

  it('abandons a hidden-host wait when isCurrent flips false', async () => {
    const host = document.createElement('div')
    host.hidden = true
    forceSize(host, 0, 0)
    document.body.append(host)

    let current = true
    const pending = whenDiffHostVisible(host, () => current)
    // Superseded selection (panel still closed) must release the waiter —
    // otherwise the Changes pane's shared diffLoadQueue stalls forever and
    // flicking files never attaches a model.
    current = false
    const started = Date.now()
    assert.equal(await pending, false)
    assert.ok(Date.now() - started < 500, 'stale wait must not block on visibility')
  })

  it('resolves true after the host becomes visible', async () => {
    const host = document.createElement('div')
    host.hidden = true
    forceSize(host, 0, 0)
    document.body.append(host)

    const pending = whenDiffHostVisible(host)
    queueMicrotask(() => {
      host.hidden = false
      forceSize(host, 200, 100)
    })
    assert.equal(await pending, true)
  })
})
