import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { CellOutcome, CellRequest } from './code-cell-container.ts'
import { CodeCellPool, type PooledCodeCellContainer } from './code-cell-pool.ts'

class FakeContainer implements PooledCodeCellContainer {
  static started = 0
  readonly id: number
  alive = true
  stopped = 0
  cells: string[] = []
  next: CellOutcome = {
    kind: 'result',
    result: { id: 1, ok: true, value: '', logs: '', truncated: false },
  }
  hold: Promise<void> | null = null

  constructor() {
    FakeContainer.started += 1
    this.id = FakeContainer.started
  }

  async runCell(request: CellRequest): Promise<CellOutcome> {
    this.cells.push(request.code)
    if (this.hold) await this.hold
    return this.next
  }

  /** Set to make `stop` take as long as a slow engine would. */
  stopGate: Promise<void> | null = null

  async stop(): Promise<void> {
    this.stopped += 1
    this.alive = false
    if (this.stopGate) await this.stopGate
  }
}

function request(code = 'return 1'): CellRequest {
  return {
    code,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    callTool: () => Promise.resolve({ ok: false, error: 'none' }),
  }
}

function pool(options: Partial<ConstructorParameters<typeof CodeCellPool>[0]> = {}): {
  pool: CodeCellPool
  made: FakeContainer[]
} {
  const made: FakeContainer[] = []
  const cells = new CodeCellPool({
    start: (): Promise<FakeContainer> => {
      const container = new FakeContainer()
      made.push(container)
      return Promise.resolve(container)
    },
    sweep: (): Promise<void> => Promise.resolve(),
    idleMs: 30 * 60_000,
    maxLeases: 4,
    now: Date.now,
    log: (): void => {},
    ...options,
  })
  return { pool: cells, made }
}

const threadA = { projectId: 'p', threadId: 'a' }
const threadB = { projectId: 'p', threadId: 'b' }
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('CodeCellPool', () => {
  it('warms a spare when enabled and hands it to the first thread', async () => {
    const { pool: cells, made } = pool()
    cells.enable()
    await flush()
    assert.equal(made.length, 1, 'the spare is started at once')
    await cells.run(threadA, request('first'))
    assert.deepEqual(made[0]?.cells, ['first'], 'the spare ran the cell')
    await flush()
    assert.equal(made.length, 2, 'taking the spare starts the next one')
    await cells.disable()
  })

  it("keeps one container per thread and never shares a thread's", async () => {
    const { pool: cells, made } = pool()
    cells.enable()
    await cells.run(threadA, request('a1'))
    await cells.run(threadA, request('a2'))
    await cells.run(threadB, request('b1'))
    const ran = made.filter((container) => container.cells.length > 0)
    assert.deepEqual(
      ran.map((container) => container.cells),
      [['a1', 'a2'], ['b1']],
    )
    await cells.disable()
  })

  it('discards the container after anything but a result', async () => {
    const { pool: cells, made } = pool()
    cells.enable()
    await cells.run(threadA, request())
    const first = made.find((container) => container.cells.length > 0)
    assert.ok(first)
    first.next = { kind: 'timeout' }
    assert.deepEqual(await cells.run(threadA, request('slow')), { kind: 'timeout' })
    assert.equal(first.stopped, 1)
    await cells.run(threadA, request('fresh'))
    const second = made.find((container) => container.cells.includes('fresh'))
    assert.notEqual(second, first)
    await cells.disable()
  })

  it('replaces a container that died between cells', async () => {
    const { pool: cells, made } = pool()
    cells.enable()
    await cells.run(threadA, request('one'))
    const first = made.find((container) => container.cells.includes('one'))
    assert.ok(first)
    first.alive = false
    await cells.run(threadA, request('two'))
    assert.ok(!first.cells.includes('two'))
    await cells.disable()
  })

  it('makes room by discarding the least recently used idle thread', async () => {
    let now = 0
    const { pool: cells, made } = pool({ maxLeases: 2, now: () => now })
    cells.enable()
    await cells.run(threadA, request('a'))
    now = 10
    await cells.run(threadB, request('b'))
    now = 20
    await cells.run({ projectId: 'p', threadId: 'c' }, request('c'))
    const a = made.find((container) => container.cells.includes('a'))
    const b = made.find((container) => container.cells.includes('b'))
    assert.equal(a?.stopped, 1, 'the oldest idle thread gave its container up')
    assert.equal(b?.stopped, 0)
    await cells.run(threadB, request('b again'))
    assert.ok(b.cells.includes('b again'), 'the newer thread kept its container')
    await cells.disable()
  })

  it('refuses a new thread when every container is busy', async () => {
    const { pool: cells, made } = pool({ maxLeases: 1 })
    cells.enable()
    await flush()
    const spare = made[0]
    assert.ok(spare)
    let release = (): void => {}
    spare.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const busy = cells.run(threadA, request('busy'))
    await flush()
    await assert.rejects(cells.run(threadB, request()), /already running code cells/)
    release()
    await busy
    await cells.disable()
  })

  it('discards idle threads on its sweep', async () => {
    mock.timers.enable({ apis: ['setInterval'] })
    try {
      let now = 0
      const { pool: cells, made } = pool({ idleMs: 1000, now: () => now })
      cells.enable()
      await cells.run(threadA, request('a'))
      now = 5000
      mock.timers.tick(60_000)
      await flush()
      assert.equal(made.find((container) => container.cells.includes('a'))?.stopped, 1)
      await cells.disable()
    } finally {
      mock.timers.reset()
    }
  })

  it('removes every container, the spare included, when disabled', async () => {
    const { pool: cells, made } = pool()
    cells.enable()
    await cells.run(threadA, request())
    await flush()
    await cells.disable()
    assert.ok(made.length >= 2)
    assert.ok(made.every((container) => container.stopped === 1))
    await assert.rejects(cells.run(threadA, request()), /Code mode is off/)
  })

  it('sweeps leftovers once, before the first container starts', async () => {
    const order: string[] = []
    const { pool: cells } = pool({
      sweep: () => {
        order.push('sweep')
        return Promise.resolve()
      },
      start: () => {
        order.push('start')
        return Promise.resolve(new FakeContainer())
      },
    })
    cells.enable()
    await cells.run(threadA, request())
    await flush()
    assert.deepEqual(order.slice(0, 2), ['sweep', 'start'])
    assert.equal(order.filter((step) => step === 'sweep').length, 1)
    await cells.disable()
  })

  it('discard removes only that thread’s container', async () => {
    const { pool: cells, made } = pool()
    cells.enable()
    await cells.run(threadA, request('a'))
    await cells.run(threadB, request('b'))
    await cells.discard(threadA)
    assert.equal(made.find((container) => container.cells.includes('a'))?.stopped, 1)
    assert.equal(made.find((container) => container.cells.includes('b'))?.stopped, 0)
    await cells.run(threadB, request('b again'))
    assert.ok(made.find((container) => container.cells.includes('b'))?.cells.includes('b again'))
    await cells.disable()
  })

  it('turns off without waiting for a container that is still starting, and stops it once up', async () => {
    const made: FakeContainer[] = []
    let finishStart = (): void => {}
    const cells = new CodeCellPool({
      start: (): Promise<FakeContainer> =>
        new Promise((resolve) => {
          finishStart = (): void => {
            const container = new FakeContainer()
            made.push(container)
            resolve(container)
          }
        }),
      sweep: (): Promise<void> => Promise.resolve(),
      idleMs: 60_000,
      maxLeases: 4,
      now: Date.now,
      log: (): void => {},
    })
    cells.enable()
    await flush()
    await cells.disable()
    assert.equal(made.length, 0, 'disable returned while the spare was still starting')
    finishStart()
    await flush()
    assert.equal(made[0]?.stopped, 1, 'the late container is removed once it is up')
  })

  it('starts nothing for a thread that was making room when code mode was turned off', async () => {
    const { pool: cells, made } = pool({ maxLeases: 1 })
    cells.enable()
    await cells.run(threadA, request('a'))
    const a = made.find((container) => container.cells.includes('a'))
    assert.ok(a)
    let finishStop = (): void => {}
    a.stopGate = new Promise((resolve) => {
      finishStop = resolve
    })
    const b = cells.run(threadB, request('b'))
    await flush()
    const disabling = cells.disable()
    finishStop()
    await assert.rejects(b, /Code mode is off/)
    await disabling
    await flush()
    assert.ok(
      made.every((container) => container.stopped >= 1),
      'no container outlives turning code mode off',
    )
    assert.ok(made.every((container) => !container.cells.includes('b')))
  })
})
