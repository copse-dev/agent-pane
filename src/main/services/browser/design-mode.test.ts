import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import {
  DESIGN_MODE_WORLD_ID,
  cancelBrowserElementPick,
  pickBrowserElement,
  syncBrowserDesignMarkers,
  type DesignModeContents,
} from './design-mode.ts'

interface NavigationStart {
  isMainFrame: boolean
  isSameDocument: boolean
}

interface FakeImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width?: number }): FakeImage
  toDataURL(): string
}

function fakeImage(width: number, height: number): FakeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (options) => fakeImage(options.width ?? width, height),
    toDataURL: () => `data:image/png;base64,${String(width)}x${String(height)}`,
  }
}

/**
 * A guest backed by happy-dom: both worlds run against the same document, as
 * they do in Chromium, with a separate global object for the isolated world.
 */
function guest(html: string): {
  window: Window
  contents: DesignModeContents
  events: EventEmitter
  crops: Array<{ x: number; y: number; width: number; height: number } | undefined>
  worlds: number[]
} {
  const window = new Window({ url: 'https://app.test/pricing', width: 800, height: 600 })
  window.document.write(html)
  window.document.title = 'Pricing'
  const events = new EventEmitter()
  const crops: Array<{ x: number; y: number; width: number; height: number } | undefined> = []
  const worlds: number[] = []
  const isolated: Record<string, unknown> = {}
  const globals = (scope: Record<string, unknown>): Record<string, unknown> =>
    Object.assign(scope, {
      document: window.document,
      location: window.location,
      getComputedStyle: window.getComputedStyle.bind(window),
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
      innerWidth: 800,
      innerHeight: 600,
      setInterval,
      clearInterval,
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
    })
  function on(event: 'did-start-navigation', listener: (details: NavigationStart) => void): unknown
  function on(event: 'destroyed', listener: () => void): unknown
  function on(event: string, listener: (details: NavigationStart) => void): unknown {
    return events.on(event, listener)
  }
  function off(event: 'did-start-navigation', listener: (details: NavigationStart) => void): unknown
  function off(event: 'destroyed', listener: () => void): unknown
  function off(event: string, listener: (details: NavigationStart) => void): unknown {
    return events.off(event, listener)
  }
  const isolatedScope = globals(isolated)
  isolatedScope['window'] = isolatedScope
  const contents: DesignModeContents = {
    executeJavaScript: (code) => Promise.resolve(runInNewContext(code, globals({}))),
    executeJavaScriptInIsolatedWorld: (worldId, scripts) => {
      worlds.push(worldId)
      return Promise.resolve(runInNewContext(scripts[0]?.code ?? '', isolatedScope))
    },
    capturePage: (rect) => {
      crops.push(rect)
      return Promise.resolve(fakeImage(rect?.width ?? 800, rect?.height ?? 600))
    },
    on,
    off,
  }
  return { window, contents, events, crops, worlds }
}

function stubHit(window: Window, target: object): void {
  Object.defineProperty(window.document, 'elementFromPoint', { value: () => target })
  Object.defineProperty(target, 'getBoundingClientRect', {
    value: () => ({ left: 4, top: 30, width: 120, height: 40, right: 124, bottom: 70 }),
  })
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('browser design mode', () => {
  it('reports the clicked element with its markup, style, source and a padded crop', async () => {
    const { window, contents, crops, worlds } = guest(
      '<main><section class="hero"><button class="cta primary" style="color: rgb(255, 0, 0)">Start <b>trial</b></button></section></main>',
    )
    const button = window.document.querySelector('button')
    assert.ok(button)
    stubHit(window, button)
    // A React dev build leaves its fiber on the node, in the page's own world.
    Object.defineProperty(button, '__reactFiber$abc', {
      value: {
        type: 'button',
        return: {
          type: function PricingHero() {},
          _debugSource: { fileName: '/src/Hero.tsx', lineNumber: 42, columnNumber: 7 },
        },
      },
      enumerable: true,
    })
    const pending = pickBrowserElement(contents)
    await tick()
    window.dispatchEvent(new window.MouseEvent('click', { clientX: 10, clientY: 40 }))
    const result = await pending
    assert.ok(result.kind === 'picked')
    const picked = result.element
    assert.equal(picked.tag, 'button')
    assert.equal(picked.selector, 'main > section.hero > button.cta.primary')
    assert.match(picked.html, /^<button class="cta primary"/)
    assert.doesNotMatch(picked.html, /data-copse-design-pick/)
    assert.equal(picked.text, 'Start trial')
    assert.equal(picked.title, 'Pricing')
    assert.equal(picked.styles['color'], 'rgb(255, 0, 0)')
    assert.deepEqual(picked.source, {
      via: 'react',
      file: '/src/Hero.tsx',
      line: 42,
      column: 7,
      component: 'PricingHero',
    })
    // 12px of context, clamped to the viewport's left edge.
    assert.deepEqual(crops, [{ x: 0, y: 18, width: 136, height: 64 }])
    assert.equal(picked.screenshot, 'data:image/png;base64,136x64')
    assert.equal(button.hasAttribute('data-copse-design-pick'), false, 'one-shot attribute removed')
    assert.equal(window.document.querySelector('copse-design-overlay'), null, 'overlay removed')
    assert.ok(worlds.every((id) => id === DESIGN_MODE_WORLD_ID))
  })

  it('reads data-inspector attributes when no framework metadata is present', async () => {
    const { window, contents } = guest(
      '<div data-inspector-relative-path="src/Card.vue" data-inspector-line="9" data-inspector-column="3"><p>Hi</p></div>',
    )
    const p = window.document.querySelector('p')
    assert.ok(p)
    stubHit(window, p)
    const pending = pickBrowserElement(contents)
    await tick()
    window.dispatchEvent(new window.MouseEvent('click'))
    const result = await pending
    assert.ok(result.kind === 'picked')
    assert.deepEqual(result.element.source, {
      via: 'data-inspector',
      file: 'src/Card.vue',
      line: 9,
      column: 3,
      component: null,
    })
  })

  it('swallows page clicks while picking so the page does not act on them', async () => {
    const { window, contents } = guest('<a href="#next">Next</a>')
    const link = window.document.querySelector('a')
    assert.ok(link)
    stubHit(window, link)
    let pageSawClick = false
    link.addEventListener('click', () => {
      pageSawClick = true
    })
    const pending = pickBrowserElement(contents)
    await tick()
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    assert.equal((await pending).kind, 'picked')
    assert.equal(pageSawClick, false)
  })

  it('resolves cancelled on Escape and on an explicit cancel', async () => {
    const { window, contents } = guest('<p>x</p>')
    const first = pickBrowserElement(contents)
    await tick()
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    assert.deepEqual(await first, { kind: 'cancelled' })

    const second = pickBrowserElement(contents)
    await tick()
    await cancelBrowserElementPick(contents)
    assert.deepEqual(await second, { kind: 'cancelled' })
    assert.equal(window.document.querySelector('copse-design-overlay'), null)
  })

  it('resolves navigated when the document goes away mid-pick', async () => {
    const { contents, events } = guest('<p>x</p>')
    const pending = pickBrowserElement(contents)
    await tick()
    events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    events.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    assert.deepEqual(await pending, { kind: 'navigated' })
    assert.equal(events.listenerCount('did-start-navigation'), 0)
    assert.equal(events.listenerCount('destroyed'), 0)
  })

  it('resolves navigated when the document goes away while the crop is taken', async () => {
    const { window, contents, events } = guest('<p>x</p>')
    const p = window.document.querySelector('p')
    assert.ok(p)
    stubHit(window, p)
    let cropRequested = false
    contents.capturePage = (): Promise<never> => {
      cropRequested = true
      // Held open: the next document commits before the capture returns.
      return new Promise(() => undefined)
    }
    const pending = pickBrowserElement(contents)
    await tick()
    window.dispatchEvent(new window.MouseEvent('click'))
    // Let the guest resolve the pick (two animation frames) and the crop start.
    await tick()
    await tick()
    await tick()
    assert.equal(cropRequested, true)
    events.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    assert.deepEqual(await pending, { kind: 'navigated' })
    assert.equal(events.listenerCount('did-start-navigation'), 0)
  })

  it('draws numbered markers for pinned elements and rejects malformed ids', async () => {
    const { window, contents } = guest('<p>a</p><p>b</p>')
    const [a] = Array.from(window.document.querySelectorAll('p'))
    assert.ok(a)
    stubHit(window, a)
    const pending = pickBrowserElement(contents)
    await tick()
    window.dispatchEvent(new window.MouseEvent('click'))
    const result = await pending
    assert.ok(result.kind === 'picked')
    await syncBrowserDesignMarkers(contents, [result.element.pickId])
    assert.ok(window.document.querySelector('copse-design-markers'))
    await syncBrowserDesignMarkers(contents, [])
    assert.equal(window.document.querySelector('copse-design-markers'), null)
    await assert.rejects(syncBrowserDesignMarkers(contents, ['1); alert(1']))
    // The accent arrives from the renderer as a resolved colour, never as free CSS.
    await syncBrowserDesignMarkers(contents, [result.element.pickId], {
      accent: 'rgb(32, 253, 133)',
      onAccent: '#002e2b',
    })
    assert.ok(window.document.querySelector('copse-design-markers'))
    await syncBrowserDesignMarkers(contents, [])
    await assert.rejects(
      syncBrowserDesignMarkers(contents, [], { accent: 'red;}</style><img>', onAccent: '#000' }),
    )
  })
})
