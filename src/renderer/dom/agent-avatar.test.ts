import '../../../tests/setup-dom.ts'
import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentAvatar, createAgentAvatarMotion } from './agent-avatar.ts'

afterEach(() => {
  mock.restoreAll()
})

describe('riso agent identity', () => {
  it('regenerates the same art after cache eviction and keeps separate agents distinct', () => {
    const pastel = createAgentAvatar('named:maple', 'riso').src
    const duotone = createAgentAvatar('named:maple', 'duotone').src
    assert.notEqual(pastel, duotone, 'the cache must distinguish styles for the same seed')
    assert.notEqual(duotone, createAgentAvatar('remote:cursor', 'duotone').src)
    for (let i = 0; i < 140; i++) createAgentAvatar(`named:${String(i)}`)
    assert.equal(createAgentAvatar('named:maple', 'riso').src, pastel)
    assert.equal(createAgentAvatar('named:maple', 'duotone').src, duotone)
  })

  it('keeps identities out of markup and isolates SVG definitions inside an image', () => {
    const identity = '"><script>alert(1)</script>'
    for (const style of ['riso', 'duotone'] as const) {
      const avatar = createAgentAvatar(identity, style)
      assert.equal(avatar.tagName, 'IMG')
      assert.equal(avatar.alt, '')
      assert.equal(avatar.getAttribute('aria-hidden'), 'true')
      const svg = decodeURIComponent(avatar.src.slice(avatar.src.indexOf(',') + 1))
      assert.ok(svg.includes('<feTurbulence'))
      assert.ok(svg.includes('<pattern'))
      assert.ok(!svg.includes(identity))
      assert.ok(!svg.includes('<script'))
      assert.ok(!svg.includes('NaN'))
    }
  })
})

describe('active avatar motion', () => {
  it('suspends hidden, offscreen, and reduced-motion images and cleans up after handoff', () => {
    const OriginalObserver = window.IntersectionObserver
    let deliver: IntersectionObserverCallback | undefined
    let observer: IntersectionObserver | undefined
    mock.method(window, 'IntersectionObserver', function (callback: IntersectionObserverCallback) {
      deliver = callback
      observer = new OriginalObserver(callback)
      return observer
    })
    let reduced = false
    let hidden = false
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    mock.getter(media, 'matches', () => reduced)
    mock.method(window, 'matchMedia', () => media)
    mock.getter(document, 'hidden', () => hidden)
    const motion = createAgentAvatarMotion()
    const remote = createAgentAvatar('remote:cursor', 'duotone')
    const named = createAgentAvatar('named:maple')
    const still = remote.src
    const intersect = (img: HTMLImageElement, visible: boolean): void => {
      assert.ok(deliver)
      assert.ok(observer)
      const rect = img.getBoundingClientRect()
      deliver(
        [
          {
            target: img,
            isIntersecting: visible,
            intersectionRatio: visible ? 1 : 0,
            boundingClientRect: rect,
            intersectionRect: rect,
            rootBounds: null,
            time: 0,
          },
        ],
        observer,
      )
    }
    motion.setActive(remote)
    assert.equal(remote.src, still, 'wait for visibility before starting')
    intersect(remote, true)
    const moving = remote.src
    assert.notEqual(moving, still)
    const svg = decodeURIComponent(moving.slice(moving.indexOf(',') + 1))
    assert.ok(svg.includes('prefers-reduced-motion: no-preference'))
    assert.ok(svg.includes('@keyframes ink-0'))
    assert.ok(!svg.includes('NaN'))
    motion.setActive(remote)
    assert.equal(remote.src, moving, 'reconciliation must not restart a running icon')
    reduced = true
    media.dispatchEvent(new Event('change'))
    assert.equal(remote.src, still)
    reduced = false
    media.dispatchEvent(new Event('change'))
    assert.equal(remote.src, moving)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(remote.src, still)
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    assert.equal(remote.src, moving)
    intersect(remote, false)
    assert.equal(remote.src, still)
    intersect(remote, true)
    motion.setActive(named)
    assert.equal(remote.src, still)
    assert.equal(remote.hasAttribute('data-avatar-active'), false)
    intersect(named, true)
    assert.ok(named.hasAttribute('data-avatar-animating'))
    motion.dispose()
    assert.equal(named.hasAttribute('data-avatar-animating'), false)
    assert.equal(named.hasAttribute('data-avatar-active'), false)
    media.dispatchEvent(new Event('change'))
    assert.equal(named.hasAttribute('data-avatar-animating'), false)
  })
})
