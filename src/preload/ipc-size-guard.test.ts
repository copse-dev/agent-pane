import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { serialize } from 'node:v8'
import {
  IPC_ARGUMENT_LIMIT_BYTES,
  IPC_ARGUMENT_REPORT_BYTES,
  IPC_LARGE_CALL_CHANNEL,
} from '@shared/ipc-size-limits.ts'
import { createIpcSizeGuard, estimateIpcArgumentBytes } from './ipc-size-guard.ts'

const NO_LIMIT = Number.MAX_SAFE_INTEGER

// `repeat` builds a rope, and the estimate reads only `length`, so these cost
// almost nothing to make even though they stand for hundreds of megabytes.
const LARGE_TEXT = 'x'.repeat(IPC_ARGUMENT_REPORT_BYTES / 2)
const OVERSIZED_TEXT = 'x'.repeat(IPC_ARGUMENT_LIMIT_BYTES / 2 + 1)

function estimate(value: unknown): number {
  return estimateIpcArgumentBytes([value], NO_LIMIT)
}

/** The real structured-clone size: `node:v8` writes the wire format IPC uses. */
function wireBytes(value: unknown): number {
  return serialize(value).byteLength
}

function threadLike(messages: number): unknown {
  return {
    id: 'thread-1',
    title: 'Ünïcode — two-byte text',
    createdAt: 1_795_222_534_123,
    ratio: 0.1 + 0.2,
    archived: false,
    worktree: null,
    messages: Array.from({ length: messages }, (_, index) => ({
      id: `m${String(index)}`,
      role: 'assistant',
      content: 'word '.repeat(index + 1),
      toolCalls: [
        {
          name: 'edit',
          args: { edits: [{ before: 'a', after: 'b' }] },
          subagent: { messages: [{ content: 'nested — text' }] },
        },
      ],
    })),
  }
}

describe('estimateIpcArgumentBytes', () => {
  const shared = { content: 'shared '.repeat(40) }
  const cyclic: { self?: unknown; items: unknown[] } = { items: [] }
  cyclic.self = cyclic
  cyclic.items.push(cyclic)
  const sparse: unknown[] = []
  sparse[1_000_000] = 'tail'
  const holey: unknown[] = ['head', 'next']
  holey[10] = 'tail'

  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['an empty string', ''],
    ['a one-byte string', 'plain ascii text'],
    ['a two-byte string', 'snowman ☃ and friends — ünïcode'],
    ['a small integer', 7],
    ['a large integer', Number.MAX_SAFE_INTEGER],
    ['a double', Math.PI],
    ['a bigint', 2n ** 200n],
    ['booleans, null and undefined', [true, false, null, undefined]],
    ['an empty object', {}],
    ['an empty array', []],
    ['a thread-shaped value', threadLike(40)],
    ['a value reached by two paths', { first: shared, second: shared, list: [shared, shared] }],
    ['a cycle', cyclic],
    ['a sparse array', sparse],
    ['a holey array', holey],
    [
      'a Map',
      new Map<unknown, unknown>([
        ['key', { value: 'entry' }],
        [2, ['two']],
      ]),
    ],
    ['a Set', new Set(['one', 'two', { three: 3 }])],
    ['a Date', new Date(1_795_222_534_123)],
    ['a RegExp', /^[\w:.-]{1,96}$/giu],
    ['an Error with a cause', new Error('outer failure', { cause: new Error('inner') })],
    ['an ArrayBuffer', new ArrayBuffer(4_096)],
    ['a typed array', new Float64Array(512)],
    ['a view of part of a buffer', new Uint8Array(new ArrayBuffer(4_096), 8, 16)],
  ]

  for (const [name, value] of cases) {
    it(`is not below the real serialized size of ${name}`, () => {
      assert.ok(
        estimate(value) >= wireBytes(value),
        `estimated ${String(estimate(value))}, serialized ${String(wireBytes(value))}`,
      )
    })
  }

  it('stays within a small factor of the real size for text-heavy data', () => {
    const value = threadLike(400)
    assert.ok(estimate(value) <= wireBytes(value) * 3)
  })

  it('counts a view by its whole backing buffer, as the renderer serializer does', () => {
    assert.ok(estimate(new Uint8Array(new ArrayBuffer(4_096), 0, 16)) >= 4_096)
  })

  it('counts a sparse array by its present elements, not its length', () => {
    const wide: unknown[] = []
    wide[1_000_000_000] = 'tail'
    assert.ok(estimate(wide) < 1_024)
  })

  it('stops walking once the limit is passed', () => {
    let read = 0
    const items = Array.from({ length: 1_000 }, () => ({
      get text(): string {
        read += 1
        return 'c'.repeat(100)
      },
    }))
    assert.ok(estimateIpcArgumentBytes([items], 1_000) > 1_000)
    assert.ok(read < 20, `read ${String(read)} of 1000 items`)
  })
})

interface Sent {
  via: 'invoke' | 'send'
  channel: string
  args: unknown[]
}

function fixture(): { guard: ReturnType<typeof createIpcSizeGuard>; sent: Sent[] } {
  const sent: Sent[] = []
  const guard = createIpcSizeGuard({
    invoke: (channel, ...args) => {
      sent.push({ via: 'invoke', channel, args })
      return Promise.resolve('reply')
    },
    send: (channel, ...args) => {
      sent.push({ via: 'send', channel, args })
    },
  })
  return { guard, sent }
}

function order(sent: readonly Sent[]): string[] {
  return sent.map((call) => `${call.via}:${call.channel}`)
}

function reportIn(call: Sent | undefined): Record<string, unknown> {
  const report: unknown = call?.args[0]
  assert.ok(typeof report === 'object' && report !== null)
  return { ...report }
}

describe('createIpcSizeGuard', () => {
  it('passes an ordinary call through untouched and unreported', async () => {
    const { guard, sent } = fixture()
    const message = { id: 'm1', content: 'hello' }
    assert.equal(await guard.invoke('threads:append-message', 'p', 't', message), 'reply')
    guard.send('vnc:send', 'c', new Uint8Array(64))
    assert.deepEqual(order(sent), ['invoke:threads:append-message', 'send:vnc:send'])
    assert.equal(sent[0]?.args[2], message)
  })

  it('names a large call to main before sending it', async () => {
    const { guard, sent } = fixture()
    assert.equal(await guard.invoke('threads:create', 'p', { content: LARGE_TEXT }), 'reply')
    assert.deepEqual(order(sent), [`send:${IPC_LARGE_CALL_CHANNEL}`, 'invoke:threads:create'])
    const report = reportIn(sent[0])
    assert.equal(report['channel'], 'threads:create')
    assert.equal(report['refused'], false)
    const bytes = report['bytes']
    assert.ok(typeof bytes === 'number' && bytes >= IPC_ARGUMENT_REPORT_BYTES)
  })

  it('rejects an oversized invoke without sending it, and says which channel', async () => {
    const { guard, sent } = fixture()
    await assert.rejects(
      guard.invoke('threads:create', 'p', { messages: [{ content: OVERSIZED_TEXT }] }),
      /Refused to send "threads:create".*960 MB/s,
    )
    assert.deepEqual(order(sent), [`send:${IPC_LARGE_CALL_CHANNEL}`])
    const report = reportIn(sent[0])
    assert.equal(report['channel'], 'threads:create')
    assert.equal(report['refused'], true)
  })

  it('throws on an oversized send without sending it', () => {
    const { guard, sent } = fixture()
    assert.throws(() => {
      guard.send('vnc:send', 'c', OVERSIZED_TEXT)
    }, /Refused to send "vnc:send"/)
    assert.deepEqual(order(sent), [`send:${IPC_LARGE_CALL_CHANNEL}`])
  })

  it('leaves a value it cannot walk to the real call', async () => {
    const { guard, sent } = fixture()
    const unreadable = {
      get content(): string {
        throw new Error('not readable')
      },
    }
    assert.equal(await guard.invoke('threads:create', 'p', unreadable), 'reply')
    assert.deepEqual(order(sent), ['invoke:threads:create'])
  })

  it('still makes the call when the report cannot be sent', async () => {
    const calls: string[] = []
    const guard = createIpcSizeGuard({
      invoke: (channel) => {
        calls.push(channel)
        return Promise.resolve('reply')
      },
      send: () => {
        throw new Error('channel closed')
      },
    })
    assert.equal(await guard.invoke('threads:create', 'p', LARGE_TEXT), 'reply')
    assert.deepEqual(calls, ['threads:create'])
  })
})
