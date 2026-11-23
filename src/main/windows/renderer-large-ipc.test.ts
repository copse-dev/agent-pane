import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { IPC_LARGE_CALL_CHANNEL } from '@shared/ipc-size-limits.ts'
import {
  LARGE_IPC_LOG_INTERVAL_MS,
  LARGE_IPC_RECENT_MS,
  createLargeIpcCallLog,
  installLargeIpcCallChannel,
  type LargeIpcCallLog,
} from './renderer-large-ipc.ts'

const MIB = 1024 * 1024

function fixture(): { calls: LargeIpcCallLog; logs: string[]; advance: (ms: number) => void } {
  const logs: string[] = []
  let now = 10_000
  const calls = createLargeIpcCallLog({
    log: (message) => {
      logs.push(message)
    },
    now: () => now,
  })
  return {
    calls,
    logs,
    advance: (ms): void => {
      now += ms
    },
  }
}

describe('createLargeIpcCallLog', () => {
  it('logs a large call with its channel and estimated size', () => {
    const { calls, logs } = fixture()
    calls.record(1, { channel: 'threads:create', bytes: 612 * MIB, refused: false })
    assert.deepEqual(logs, ['[ipc] large renderer call channel=threads:create estimated<=612MB'])
  })

  it('logs a refused call with the limit it was over', () => {
    const { calls, logs } = fixture()
    calls.record(1, { channel: 'threads:create', bytes: 961 * MIB, refused: true })
    assert.deepEqual(logs, [
      '[ipc] refused oversized renderer call channel=threads:create limit=960MB',
    ])
  })

  it('prints one line per channel per interval and counts the rest', () => {
    const { calls, logs, advance } = fixture()
    const report = { channel: 'threads:create', bytes: 40 * MIB, refused: false }
    calls.record(1, report)
    calls.record(1, report)
    calls.record(1, report)
    calls.record(1, { ...report, channel: 'threads:update-meta' })
    assert.equal(logs.length, 2)

    advance(LARGE_IPC_LOG_INTERVAL_MS)
    calls.record(1, report)
    assert.equal(logs.length, 3)
    assert.match(logs[2] ?? '', /channel=threads:create estimated<=40MB coalesced=2$/)
  })

  it('ignores a report that is not one', () => {
    const { calls, logs } = fixture()
    for (const raw of [
      null,
      'threads:create',
      { channel: 'threads:create' },
      { channel: 'threads:create', bytes: -1, refused: false },
      { channel: 'threads:create', bytes: Number.NaN, refused: false },
      { channel: 'has spaces\nand a newline', bytes: 1, refused: false },
      { channel: 'x'.repeat(200), bytes: 1, refused: false },
    ]) {
      calls.record(1, raw)
    }
    assert.deepEqual(logs, [])
    assert.equal(calls.describeRecent(1), null)
  })

  it('stops printing new names once more are live than real channels produce', () => {
    const { calls, logs } = fixture()
    for (let index = 0; index < 500; index++) {
      calls.record(1, { channel: `made-up:${String(index)}`, bytes: 40 * MIB, refused: false })
    }
    assert.ok(logs.length <= 64, `printed ${String(logs.length)} lines`)
  })

  it("describes a window's latest report while it is recent", () => {
    const { calls, advance } = fixture()
    assert.equal(calls.describeRecent(1), null)

    calls.record(1, { channel: 'threads:create', bytes: 612 * MIB, refused: false })
    calls.record(2, { channel: 'agent:run', bytes: 961 * MIB, refused: true })
    advance(1_200)
    assert.equal(calls.describeRecent(1), 'lastLargeIpc=threads:create estimated<=612MB ago=1200ms')
    assert.equal(calls.describeRecent(2), 'lastLargeIpc=agent:run refused ago=1200ms')

    advance(LARGE_IPC_RECENT_MS)
    assert.equal(calls.describeRecent(1), null)
  })
})

describe('installLargeIpcCallChannel', () => {
  interface Event {
    sender: { id: number }
  }

  it('records reports from app windows and drops the rest', () => {
    const { calls, logs } = fixture()
    const listeners = new Map<string, (event: Event, raw: unknown) => void>()
    installLargeIpcCallChannel<Event>(
      {
        on: (channel, listener) => {
          listeners.set(channel, listener)
        },
      },
      // Stands in for the sender check: only window 1 is one of ours.
      (event) => event.sender.id === 1,
      calls,
    )
    const deliver = listeners.get(IPC_LARGE_CALL_CHANNEL)
    assert.ok(deliver)

    deliver({ sender: { id: 7 } }, { channel: 'threads:create', bytes: 40 * MIB, refused: false })
    assert.deepEqual(logs, [])
    assert.equal(calls.describeRecent(7), null)

    deliver({ sender: { id: 1 } }, { channel: 'threads:create', bytes: 40 * MIB, refused: false })
    assert.equal(logs.length, 1)
    assert.match(calls.describeRecent(1) ?? '', /^lastLargeIpc=threads:create /)
  })
})
