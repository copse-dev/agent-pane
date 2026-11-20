import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WatchSubscriptions } from './fs-watch-subscriptions.ts'

const MAIN = 1
const SECOND = 2
const KEY = 'proj\0thread\0src/a.ts'

describe('fs:watch subscriptions', () => {
  it('keeps a shared watcher while another window still watches the file', () => {
    const subs = new WatchSubscriptions()
    subs.add(KEY, MAIN)
    subs.add(KEY, SECOND)
    assert.equal(subs.remove(KEY, MAIN), false)
    assert.equal(subs.remove(KEY, SECOND), true)
  })

  it('counts repeat watches from one window', () => {
    const subs = new WatchSubscriptions()
    subs.add(KEY, MAIN)
    subs.add(KEY, MAIN)
    assert.equal(subs.remove(KEY, MAIN), false)
    assert.equal(subs.remove(KEY, MAIN), true)
  })

  it('releases only the keys a closed window was the last subscriber of', () => {
    const subs = new WatchSubscriptions()
    const other = 'proj\0thread\0src/b.ts'
    subs.add(KEY, MAIN)
    subs.add(KEY, SECOND)
    subs.add(other, MAIN)
    assert.deepEqual(subs.removeSubscriber(MAIN), [other])
    assert.equal(subs.remove(KEY, SECOND), true)
  })

  it('cancels a watch whose unwatch arrives while it is still resolving', () => {
    const subs = new WatchSubscriptions()
    const pending = subs.begin(KEY, MAIN)
    // The renderer does not await `fs:watch` before `fs:unwatch`.
    assert.equal(subs.remove(KEY, MAIN), true)
    assert.equal(subs.commit(pending), false)
    // Nothing was subscribed, so a later watch/unwatch pair releases the key.
    assert.equal(subs.commit(subs.begin(KEY, MAIN)), true)
    assert.equal(subs.remove(KEY, MAIN), true)
  })

  it('cancels only one resolving watch per unwatch, and none of another window', () => {
    const subs = new WatchSubscriptions()
    const first = subs.begin(KEY, MAIN)
    const second = subs.begin(KEY, MAIN)
    const other = subs.begin(KEY, SECOND)
    subs.remove(KEY, MAIN)
    assert.equal(subs.commit(first), false)
    assert.equal(subs.commit(second), true)
    assert.equal(subs.commit(other), true)
    assert.equal(subs.remove(KEY, MAIN), false)
    assert.equal(subs.remove(KEY, SECOND), true)
  })

  it('drops an established subscription before cancelling a resolving watch', () => {
    const subs = new WatchSubscriptions()
    subs.add(KEY, MAIN)
    const pending = subs.begin(KEY, MAIN)
    assert.equal(subs.remove(KEY, MAIN), true)
    assert.equal(subs.commit(pending), true)
    assert.equal(subs.remove(KEY, MAIN), true)
  })

  it('does not cancel a later watch after a failed one was discarded', () => {
    const subs = new WatchSubscriptions()
    subs.discard(subs.begin(KEY, MAIN))
    subs.remove(KEY, MAIN)
    assert.equal(subs.commit(subs.begin(KEY, MAIN)), true)
  })

  it('does not let a resolving watch subscribe after everything was cleared', () => {
    const subs = new WatchSubscriptions()
    const pending = subs.begin(KEY, MAIN)
    subs.clear()
    assert.equal(subs.commit(pending), false)
  })

  it('treats an unwatch of an unknown key as releasing it', () => {
    assert.equal(new WatchSubscriptions().remove(KEY, MAIN), true)
  })
})
