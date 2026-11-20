import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import { releaseWhenSenderDestroyed, type TeardownSender } from './sender-teardown.ts'

class FakeSender extends EventEmitter implements TeardownSender {
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

describe('releaseWhenSenderDestroyed', () => {
  it('releases at once for a window that closed while the open was in flight', () => {
    const sender = new FakeSender()
    // The window closes during the handler's await: `destroyed` has fired.
    sender.destroy()
    let released = 0
    const live = releaseWhenSenderDestroyed(sender, new WeakSet(), () => {
      released += 1
    })
    assert.equal(live, false)
    assert.equal(released, 1)
    assert.equal(sender.listenerCount('destroyed'), 0)
  })

  it('adds one listener per window however many resources it opens', () => {
    const sender = new FakeSender()
    const hooked = new WeakSet<object>()
    let released = 0
    for (let opened = 0; opened < 12; opened++) {
      assert.equal(
        releaseWhenSenderDestroyed(sender, hooked, () => {
          released += 1
        }),
        true,
      )
    }
    assert.equal(sender.listenerCount('destroyed'), 1)
    assert.equal(released, 0)
    sender.destroy()
    assert.equal(released, 1)
  })

  it('wires each window separately', () => {
    const hooked = new WeakSet<object>()
    const first = new FakeSender()
    const second = new FakeSender()
    const released: string[] = []
    releaseWhenSenderDestroyed(first, hooked, () => released.push('first'))
    releaseWhenSenderDestroyed(second, hooked, () => released.push('second'))
    second.destroy()
    assert.deepEqual(released, ['second'])
  })
})
