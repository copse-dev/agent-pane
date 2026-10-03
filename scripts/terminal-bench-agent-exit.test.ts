import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { flushAndExit, type ExitDeps } from './terminal-bench-agent-exit.mts'

interface Harness {
  deps: ExitDeps
  codes: number[]
  timers: Array<() => void>
  flushPending: () => void
}

function harness(flushes: boolean): Harness {
  const codes: number[] = []
  const timers: Array<() => void> = []
  let pendingFlush: (() => void) | undefined
  const deps: ExitDeps = {
    stdout: {
      write: (_chunk, callback) => {
        if (flushes) callback()
        else pendingFlush = callback
      },
    },
    exit: (code) => {
      codes.push(code)
    },
    setTimer: (callback) => {
      timers.push(callback)
      return {}
    },
  }
  return {
    deps,
    codes,
    timers,
    flushPending: (): void => {
      pendingFlush?.()
    },
  }
}

describe('flushAndExit', () => {
  it('exits once stdout has flushed', () => {
    const h = harness(true)
    flushAndExit(0, h.deps)
    assert.deepEqual(h.codes, [0])
    h.timers[0]?.()
    assert.deepEqual(h.codes, [0])
  })

  it('does not exit before stdout flushes, and falls back on the timer', () => {
    const h = harness(false)
    flushAndExit(3, h.deps, 50)
    assert.deepEqual(h.codes, [])
    h.timers[0]?.()
    assert.deepEqual(h.codes, [3])
    h.flushPending()
    assert.deepEqual(h.codes, [3])
  })
})
