import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MainWindowRegistry,
  type MainWindowHandle,
  type MainWindowWebContents,
} from './main-window-registry.ts'

interface TestWindow extends MainWindowHandle {
  sent: Array<[string, ...unknown[]]>
  setDestroyed(value: boolean): void
  setFocused(value: boolean): void
}

function testWindow(): TestWindow {
  let destroyed = false
  let focused = false
  const sent: Array<[string, ...unknown[]]> = []
  const webContents: MainWindowWebContents = {
    send(channel, ...args): void {
      sent.push([channel, ...args])
    },
  }
  return {
    webContents,
    sent,
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    setDestroyed(value): void {
      destroyed = value
    },
    setFocused(value): void {
      focused = value
    },
  }
}

function idFactory(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] ?? `window-${String(index)}`
}

describe('MainWindowRegistry', () => {
  it('registers stable ids and keeps the first live window primary', () => {
    const registry = new MainWindowRegistry<TestWindow>(idFactory('first', 'second'))
    const first = testWindow()
    const second = testWindow()

    assert.equal(registry.register(first).id, 'first')
    assert.equal(registry.register(first).id, 'first')
    assert.equal(registry.register(second).id, 'second')
    assert.equal(registry.getPrimary()?.window, first)
    assert.deepEqual(
      registry.list().map(({ id }) => id),
      ['first', 'second'],
    )
  })

  it('tracks focus and most-recently-focused windows independently', () => {
    const registry = new MainWindowRegistry<TestWindow>(idFactory('first', 'second'))
    const first = testWindow()
    const second = testWindow()
    registry.register(first)
    registry.register(second)

    first.setFocused(true)
    assert.equal(registry.getFocused()?.id, 'first')

    first.setFocused(false)
    second.setFocused(true)
    registry.markFocused(second)
    assert.equal(registry.getFocused()?.id, 'second')
    assert.equal(registry.getMostRecentlyFocused()?.id, 'second')
  })

  it('looks up contexts by web contents and identifies the primary sender', () => {
    const registry = new MainWindowRegistry<TestWindow>(idFactory('first', 'second'))
    const first = testWindow()
    const second = testWindow()
    registry.register(first)
    registry.register(second)

    assert.equal(registry.fromWebContents(second.webContents)?.id, 'second')
    assert.equal(registry.isPrimary(first.webContents), true)
    assert.equal(registry.isPrimary(second.webContents), false)
  })

  it('unregisters the primary without promoting an unsafe secondary window', () => {
    const registry = new MainWindowRegistry<TestWindow>(idFactory('first', 'second'))
    const first = testWindow()
    const second = testWindow()
    registry.register(first)
    registry.register(second)

    registry.unregister(first)

    assert.equal(registry.get('first'), undefined)
    assert.equal(registry.getPrimary(), undefined)
    assert.equal(registry.isPrimary(second.webContents), false)
    assert.equal(registry.fromWebContents(first.webContents), undefined)
  })

  it('skips destroyed windows when sending and broadcasting', () => {
    const registry = new MainWindowRegistry<TestWindow>(idFactory('first', 'second'))
    const first = testWindow()
    const second = testWindow()
    registry.register(first)
    registry.register(second)
    second.setDestroyed(true)

    assert.equal(registry.send('first', 'event', 1), true)
    assert.equal(registry.send('second', 'event', 2), false)
    registry.broadcast('broadcast', 'value')

    assert.deepEqual(first.sent, [
      ['event', 1],
      ['broadcast', 'value'],
    ])
    assert.deepEqual(second.sent, [])
    assert.deepEqual(
      registry.list().map(({ id }) => id),
      ['first'],
    )
  })
})
