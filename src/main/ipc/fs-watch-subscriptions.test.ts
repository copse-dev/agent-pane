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

  it('treats an unwatch of an unknown key as releasing it', () => {
    assert.equal(new WatchSubscriptions().remove(KEY, MAIN), true)
  })
})
