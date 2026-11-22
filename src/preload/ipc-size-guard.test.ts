import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { serialize } from 'node:v8'
import {
  IPC_ARGUMENT_LIMIT_BYTES,
  IPC_ARGUMENT_REPORT_BYTES,
  type IpcLargeCallReport,
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

  it('counts an object reached by many paths once', () => {
    // 2^26 paths to the innermost object; serialized, it is a few hundred bytes.
    let diamond: unknown = { leaf: 'x' }
    for (let level = 0; level < 26; level++) diamond = { left: diamond, right: diamond }
    assert.ok(estimate(diamond) >= wireBytes(diamond))
    assert.ok(estimate(diamond) < 8_192, `estimated ${String(estimate(diamond))}`)

    const attachment = { content: 'y'.repeat(1_000) }
    assert.ok(estimate({ first: attachment, second: attachment }) < 3_000)
  })

  it('counts a buffer shared by two views once', () => {
    const buffer = new ArrayBuffer(4_096)
    assert.ok(estimate([new Uint8Array(buffer), new Uint16Array(buffer)]) < 2 * 4_096)
  })

  it('still ends on a cycle among more objects than it remembers', () => {
    const many: unknown[] = Array.from({ length: 1_000_001 }, () => ({}))
    const late: { self?: unknown } = {}
    late.self = late
    many.push(late, late)
    assert.ok(estimate(many) >= wireBytes(many))
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

type Step =
  | { via: 'invoke' | 'send'; channel: string; args: unknown[] }
  | { via: 'report'; report: IpcLargeCallReport }

function fixture(): { guard: ReturnType<typeof createIpcSizeGuard>; steps: Step[] } {
  const steps: Step[] = []
  const guard = createIpcSizeGuard({
    invoke: (channel, ...args) => {
      steps.push({ via: 'invoke', channel, args })
      return Promise.resolve('reply')
    },
    send: (channel, ...args) => {
      steps.push({ via: 'send', channel, args })
    },
    report: (report) => {
      steps.push({ via: 'report', report })
    },
  })
  return { guard, steps }
}

/** What happened, in order: a report is named by the call it describes. */
function order(steps: readonly Step[]): string[] {
  return steps.map((step) =>
    step.via === 'report'
      ? `report:${step.report.channel}:${step.report.refused ? 'refused' : 'large'}`
      : `${step.via}:${step.channel}`,
  )
}

describe('createIpcSizeGuard', () => {
  it('passes an ordinary call through untouched and unreported', async () => {
    const { guard, steps } = fixture()
    const message = { id: 'm1', content: 'hello' }
    assert.equal(await guard.invoke('threads:append-message', 'p', 't', message), 'reply')
    guard.send('vnc:send', 'c', new Uint8Array(64))
    assert.deepEqual(order(steps), ['invoke:threads:append-message', 'send:vnc:send'])
    const [first] = steps
    assert.ok(first?.via === 'invoke')
    assert.equal(first.args[2], message)
  })

  it('names a large call to main before sending it', async () => {
    const { guard, steps } = fixture()
    assert.equal(await guard.invoke('threads:create', 'p', { content: LARGE_TEXT }), 'reply')
    assert.deepEqual(order(steps), ['report:threads:create:large', 'invoke:threads:create'])
    const [first] = steps
    assert.ok(first?.via === 'report')
    assert.ok(first.report.bytes >= IPC_ARGUMENT_REPORT_BYTES)
  })

  it('rejects an oversized invoke without sending it, and says which channel', async () => {
    const { guard, steps } = fixture()
    await assert.rejects(
      guard.invoke('threads:create', 'p', { messages: [{ content: OVERSIZED_TEXT }] }),
      { message: 'Too large to send in one request: more than 960 MB (threads:create).' },
    )
    assert.deepEqual(order(steps), ['report:threads:create:refused'])
  })

  it('throws on an oversized send without sending it', () => {
    const { guard, steps } = fixture()
    assert.throws(
      () => {
        guard.send('vnc:send', 'c', OVERSIZED_TEXT)
      },
      { message: 'Too large to send in one request: more than 960 MB (vnc:send).' },
    )
    assert.deepEqual(order(steps), ['report:vnc:send:refused'])
  })

  it('leaves a value it cannot walk to the real call', async () => {
    const { guard, steps } = fixture()
    const unreadable = {
      get content(): string {
        throw new Error('not readable')
      },
    }
    assert.equal(await guard.invoke('threads:create', 'p', unreadable), 'reply')
    assert.deepEqual(order(steps), ['invoke:threads:create'])
  })

  it('still makes the call when the report cannot be sent', async () => {
    const calls: string[] = []
    const guard = createIpcSizeGuard({
      invoke: (channel) => {
        calls.push(channel)
        return Promise.resolve('reply')
      },
      send: (channel) => {
        calls.push(channel)
      },
      report: () => {
        throw new Error('channel closed')
      },
    })
    assert.equal(await guard.invoke('threads:create', 'p', LARGE_TEXT), 'reply')
    assert.deepEqual(calls, ['threads:create'])
  })
})
