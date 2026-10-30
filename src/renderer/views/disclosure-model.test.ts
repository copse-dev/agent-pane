import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDisclosureModel,
  type DisclosureClock,
  type DisclosureHost,
  type DisclosureUpdate,
} from './disclosure-model.ts'

// The model is pure state plus timers: no DOM is involved, so these tests
// prove the disclosure policy without reading any previous open state.

interface FakeClock extends DisclosureClock {
  advance(ms: number): void
}

function fakeClock(): FakeClock {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    schedule(callback, ms): () => void {
      const id = nextId++
      timers.set(id, { at: now + ms, callback })
      return () => {
        timers.delete(id)
      }
    },
    advance(ms): void {
      const until = now + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)
        const first = due[0]
        if (!first) break
        timers.delete(first[0])
        now = first[1].at
        first[1].callback()
      }
      now = until
    },
  }
}

interface Harness {
  host: DisclosureHost
  revealed: string[]
  collapsed: string[]
  compacted: string[]
  pinned: boolean
}

function harness(): Harness {
  const h: Harness = {
    revealed: [],
    collapsed: [],
    compacted: [],
    pinned: true,
    host: {
      canReveal: () => h.pinned,
      canCompact: () => h.pinned,
      reveal: (key) => {
        h.revealed.push(key)
        return true
      },
      collapse: (key) => {
        h.collapsed.push(key)
      },
      compacted: (threadId) => {
        h.compacted.push(threadId)
      },
    },
  }
  return h
}

const timing = { revealDelayMs: 300, minDwellMs: 1_000, compactDelayMs: 750 }
const T = 'thread-1'
const tool = (status: DisclosureUpdate['status']): DisclosureUpdate => ({
  kind: 'tool',
  status,
  autoRevealEligible: true,
})
const churn: DisclosureUpdate['status'][] = ['running', 'done', 'running', 'error', 'done']
const rollup = (status: DisclosureUpdate['status']): DisclosureUpdate => ({
  kind: 'container',
  status,
  autoRevealEligible: true,
})

function setup(): {
  h: Harness
  clock: FakeClock
  model: ReturnType<typeof createDisclosureModel>
} {
  const h = harness()
  const clock = fakeClock()
  return { h, clock, model: createDisclosureModel(h.host, timing, clock) }
}

describe('disclosure model', () => {
  it('starts every key in auto mode', () => {
    const { model } = setup()
    assert.equal(model.mode('k'), 'auto')
    assert.equal(model.userChoice('k'), undefined)
  })

  it('keeps a user-open choice through running → done → running', () => {
    const { model, clock } = setup()
    for (const update of [rollup, tool]) {
      const key = `k-${update('running').kind}`
      model.update(T, key, update('running'))
      model.choose(T, key, true)
      assert.equal(model.mode(key), 'user-open')
      for (const status of churn) {
        assert.equal(model.update(T, key, update(status)), true, `${key} closed on ${status}`)
        clock.advance(400)
      }
    }
  })

  it('keeps a user-closed choice through running → done → running', () => {
    const { model, clock, h } = setup()
    const key = 'k-tool'
    model.update(T, key, tool('running'))
    model.choose(T, key, false)
    for (const status of churn) {
      assert.equal(model.update(T, key, tool(status)), false, `reopened on ${status}`)
      clock.advance(400)
    }
    assert.deepEqual(h.revealed, [], 'a user-closed card was auto-revealed')
  })

  it('keeps a user-closed running card closed on refresh and across its reveal delay', () => {
    const { model, clock, h } = setup()
    const key = 'k-running'
    assert.equal(model.update(T, key, tool('running')), false)
    clock.advance(100)
    model.choose(T, key, false)
    clock.advance(1_000)
    // A refresh re-applies the same running status.
    assert.equal(model.update(T, key, tool('running')), false)
    clock.advance(1_000)
    assert.deepEqual(h.revealed, [])
  })

  it('does not reveal a tool that finishes inside the reveal delay', () => {
    const { model, clock, h } = setup()
    model.update(T, 'fast', tool('running'))
    clock.advance(200)
    model.update(T, 'fast', tool('done'))
    clock.advance(500)
    assert.deepEqual(h.revealed, [])
    assert.equal(model.isAutoOpen('fast'), false)
  })

  it('reveals long-running work once and holds it open across a gap', () => {
    const { model, clock, h } = setup()
    model.update(T, 'long', tool('running'))
    clock.advance(300)
    assert.deepEqual(h.revealed, ['long'])
    assert.equal(model.mode('long'), 'auto', 'an automatic reveal is not a user choice')
    assert.equal(model.update(T, 'long', tool('done')), true)
    assert.equal(model.update(T, 'long', tool('running')), true)
    clock.advance(1_000)
    assert.deepEqual(h.revealed, ['long'], 'revealed twice')
  })

  it('does not reveal while the reader is scrolled up', () => {
    const { model, clock, h } = setup()
    h.pinned = false
    model.update(T, 'long', tool('running'))
    clock.advance(400)
    assert.deepEqual(h.revealed, [])
    assert.equal(model.isAutoOpen('long'), false)
  })

  it('keeps containers quiet while running or failed', () => {
    const { model, clock, h } = setup()
    assert.equal(model.update(T, 'r', rollup('running')), false)
    clock.advance(1_000)
    assert.equal(model.update(T, 'r', rollup('error')), false)
    assert.deepEqual(h.revealed, [])
  })

  it('opens failures immediately and never compacts them', () => {
    const { model, clock, h } = setup()
    assert.equal(model.update(T, 'fail', tool('error')), true)
    assert.equal(
      model.update(T, 'entry', { kind: 'entry', status: 'error', autoRevealEligible: false }),
      true,
    )
    model.scheduleCompaction(T)
    clock.advance(5_000)
    assert.deepEqual(h.collapsed, [])
    assert.equal(model.update(T, 'fail', tool('error')), true)
  })

  it('does not auto-reveal group entries', () => {
    const { model, clock, h } = setup()
    const entry: DisclosureUpdate = { kind: 'entry', status: 'running', autoRevealEligible: true }
    assert.equal(model.update(T, 'entry', entry), false)
    clock.advance(1_000)
    assert.deepEqual(h.revealed, [])
  })

  it('compacts auto-opened work after the quiet period and minimum dwell', () => {
    const { model, clock, h } = setup()
    model.update(T, 'long', tool('running'))
    clock.advance(300)
    model.update(T, 'long', tool('done'))
    model.scheduleCompaction(T)
    clock.advance(750)
    assert.deepEqual(h.collapsed, [], 'compacted before the minimum dwell')
    clock.advance(250)
    assert.deepEqual(h.collapsed, ['long'])
    assert.deepEqual(h.compacted, [T])
    assert.equal(model.update(T, 'long', tool('done')), false)
  })

  it('leaves user-open work open when compacting', () => {
    const { model, clock, h } = setup()
    model.update(T, 'long', tool('running'))
    clock.advance(300)
    model.choose(T, 'long', true)
    model.update(T, 'long', tool('done'))
    model.scheduleCompaction(T)
    clock.advance(5_000)
    assert.deepEqual(h.collapsed, [])
    assert.equal(model.update(T, 'long', tool('done')), true)
  })

  it('cancels compaction when a new run starts', () => {
    const { model, clock, h } = setup()
    model.update(T, 'long', tool('running'))
    clock.advance(2_000)
    model.update(T, 'long', tool('done'))
    model.scheduleCompaction(T)
    clock.advance(500)
    model.cancelCompaction(T)
    clock.advance(5_000)
    assert.deepEqual(h.collapsed, [])
  })

  it('defers compaction for a scrolled-up reader until they return', () => {
    const { model, clock, h } = setup()
    model.update(T, 'long', tool('running'))
    clock.advance(2_000)
    model.update(T, 'long', tool('done'))
    h.pinned = false
    model.scheduleCompaction(T)
    clock.advance(5_000)
    assert.deepEqual(h.collapsed, [])
    h.pinned = true
    model.resumeDeferredCompaction(T)
    clock.advance(750)
    assert.deepEqual(h.collapsed, ['long'])
  })

  it('scopes compaction to its thread', () => {
    const { model, clock, h } = setup()
    model.update(T, 'a', tool('running'))
    model.update('thread-2', 'b', tool('running'))
    clock.advance(2_000)
    assert.equal(model.hasAutoOpen('thread-2'), true)
    model.scheduleCompaction(T)
    clock.advance(1_000)
    assert.deepEqual(h.collapsed, ['a'])
    assert.equal(model.isAutoOpen('b'), true)
  })

  it('cancels pending timers on dispose', () => {
    const { model, clock, h } = setup()
    model.update(T, 'long', tool('running'))
    model.dispose()
    clock.advance(5_000)
    assert.deepEqual(h.revealed, [])
  })
})
