/**
 * Code mode's containers: one warm spare, and one container per thread that
 * has run a cell.
 *
 * - **The spare** is started as soon as code mode is on, so a thread's first
 *   cell does not wait for an engine to create and boot a container. Taking it
 *   starts the next one in the background.
 * - **A thread's container** keeps its cells' state (the guest's `state` and
 *   globals) for the thread's later cells. It is never handed to another
 *   thread. It is discarded when a cell overruns, a turn is stopped mid-cell,
 *   the link fails, the thread is archived or deleted, it sits idle past
 *   {@link CODE_CELL_IDLE_MS}, code mode is turned off, or the app quits.
 *
 * At most {@link CODE_CELL_MAX_LEASES} threads hold a container at once (an
 * Apple container is a whole VM); past that, the least recently used idle one
 * is discarded to make room.
 */
import { errorMessage } from '@shared/errors.ts'
import type { CellOutcome, CellRequest } from './code-cell-container.ts'

/** What the pool needs of a container (`CodeCellContainer` in the product). */
export interface PooledCodeCellContainer {
  readonly alive: boolean
  runCell(request: CellRequest): Promise<CellOutcome>
  stop(): Promise<void>
}

export interface CodeCellOwner {
  readonly projectId: string
  readonly threadId: string
}

export const CODE_CELL_IDLE_MS = 30 * 60_000
export const CODE_CELL_MAX_LEASES = 4
const IDLE_SWEEP_MS = 60_000

interface Lease {
  readonly container: Promise<PooledCodeCellContainer>
  lastUsed: number
  running: number
}

export interface CodeCellPoolOptions {
  start: () => Promise<PooledCodeCellContainer>
  /** Remove containers an earlier app session left behind; run once, before the first start. */
  sweep?: () => Promise<void>
  idleMs?: number
  maxLeases?: number
  now?: () => number
  log?: (message: string) => void
}

function ownerKey(owner: CodeCellOwner): string {
  return JSON.stringify([owner.projectId, owner.threadId])
}

export class CodeCellPool {
  private readonly options: CodeCellPoolOptions
  private readonly leases = new Map<string, Lease>()
  private spare: Promise<PooledCodeCellContainer> | null = null
  private enabled = false
  private swept: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | null = null

  constructor(options: CodeCellPoolOptions) {
    this.options = options
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private log(message: string): void {
    if (this.options.log) this.options.log(message)
    else console.warn(`[code-mode] ${message}`)
  }

  /** Whether code mode is on for this pool: a spare is kept and leases are granted. */
  get isEnabled(): boolean {
    return this.enabled
  }

  /** Turn the pool on and start warming the spare. Idempotent. */
  enable(): void {
    if (this.enabled) return
    this.enabled = true
    this.idleTimer = setInterval(() => {
      void this.discardIdle()
    }, IDLE_SWEEP_MS)
    this.idleTimer.unref()
    this.fillSpare()
  }

  /** Turn the pool off and remove every container it holds. */
  async disable(): Promise<void> {
    this.enabled = false
    if (this.idleTimer !== null) clearInterval(this.idleTimer)
    this.idleTimer = null
    await this.stopAll()
  }

  private sweepOnce(): Promise<void> {
    this.swept ??= (this.options.sweep?.() ?? Promise.resolve()).catch((error: unknown) => {
      this.log(`could not remove earlier code-cell containers: ${errorMessage(error)}`)
    })
    return this.swept
  }

  private startContainer(): Promise<PooledCodeCellContainer> {
    return this.sweepOnce().then(() => this.options.start())
  }

  /** Keep one started container ready for the next thread that needs one. */
  private fillSpare(): void {
    if (!this.enabled || this.spare !== null) return
    const spare = this.startContainer()
    this.spare = spare
    spare.catch((error: unknown) => {
      if (this.spare === spare) this.spare = null
      this.log(`could not prepare a spare container: ${errorMessage(error)}`)
    })
  }

  /** A started container for a new lease: the spare when it is alive, else a fresh one. */
  private async takeContainer(): Promise<PooledCodeCellContainer> {
    const spare = this.spare
    this.spare = null
    const ready = spare === null ? null : await spare.catch(() => null)
    if (ready?.alive === true) return ready
    if (ready !== null) void ready.stop()
    return await this.startContainer()
  }

  /** Discard idle leases past the limit, the least recently used first, to make room. */
  private async makeRoom(): Promise<void> {
    const max = this.options.maxLeases ?? CODE_CELL_MAX_LEASES
    while (this.leases.size >= max) {
      let oldest: [string, Lease] | null = null
      for (const entry of this.leases) {
        if (entry[1].running > 0) continue
        if (oldest === null || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry
      }
      if (oldest === null) {
        throw new Error(
          `${String(max)} threads are already running code cells; wait for one to finish and try again.`,
        )
      }
      await this.discardKey(oldest[0])
    }
  }

  /**
   * The thread's lease, created when it has none, counted as running before it
   * is returned so a concurrent `makeRoom` cannot take it in between.
   */
  private async lease(owner: CodeCellOwner): Promise<Lease> {
    if (!this.enabled) throw new Error('Code mode is off.')
    const key = ownerKey(owner)
    const existing = this.leases.get(key)
    if (existing !== undefined) {
      existing.running += 1
      const container = await existing.container.catch(() => null)
      if (container?.alive === true && this.leases.get(key) === existing) return existing
      existing.running -= 1
      if (this.leases.get(key) === existing) await this.discardKey(key)
      return await this.lease(owner)
    }
    await this.makeRoom()
    const raced = this.leases.get(key)
    if (raced !== undefined) return await this.lease(owner)
    const container = this.takeContainer()
    const lease: Lease = { container, lastUsed: this.now(), running: 1 }
    this.leases.set(key, lease)
    container.then(
      () => {
        this.fillSpare()
      },
      () => {
        if (this.leases.get(key) === lease) this.leases.delete(key)
        this.fillSpare()
      },
    )
    return lease
  }

  /**
   * Run a cell in the thread's container, taking one for the thread first if
   * it has none. Anything but a result discards the container, so the thread's
   * next cell starts clean.
   */
  async run(owner: CodeCellOwner, request: CellRequest): Promise<CellOutcome> {
    const key = ownerKey(owner)
    const lease = await this.lease(owner)
    try {
      const container = await lease.container
      const outcome = await container.runCell(request)
      if (outcome.kind !== 'result' && this.leases.get(key) === lease) await this.discardKey(key)
      return outcome
    } finally {
      lease.running -= 1
      lease.lastUsed = this.now()
    }
  }

  /** Remove the thread's container, if it has one. */
  async discard(owner: CodeCellOwner): Promise<void> {
    await this.discardKey(ownerKey(owner))
  }

  private async discardKey(key: string): Promise<void> {
    const lease = this.leases.get(key)
    if (lease === undefined) return
    this.leases.delete(key)
    const container = await lease.container.catch(() => null)
    await container?.stop()
  }

  private async discardIdle(): Promise<void> {
    const limit = this.options.idleMs ?? CODE_CELL_IDLE_MS
    const now = this.now()
    const idle = [...this.leases].filter(
      ([, lease]) => lease.running === 0 && now - lease.lastUsed >= limit,
    )
    await Promise.all(idle.map(([key]) => this.discardKey(key)))
  }

  /** Remove every container, the spare included. */
  async stopAll(): Promise<void> {
    const spare = this.spare
    this.spare = null
    const keys = [...this.leases.keys()]
    await Promise.all([
      ...keys.map((key) => this.discardKey(key)),
      (async (): Promise<void> => {
        const container = spare === null ? null : await spare.catch(() => null)
        await container?.stop()
      })(),
    ])
  }

  /** How many threads hold a container; for tests and diagnostics. */
  get leaseCount(): number {
    return this.leases.size
  }
}
