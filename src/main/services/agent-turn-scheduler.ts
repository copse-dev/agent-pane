import { AsyncLocalStorage } from 'node:async_hooks'
import { errorMessage } from '@shared/errors.ts'

export const DEFAULT_MAX_ACTIVE_TURNS = 4
export const AGENT_TURN_QUEUE_NOTICE =
  'Waiting for an available agent slot. You can stop this turn while it is queued.\n\n'

/** A positive integer overrides the default; zero explicitly disables the limit. */
export function parseMaxActiveTurns(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) return DEFAULT_MAX_ACTIVE_TURNS
  const limit = Number(value)
  return Number.isSafeInteger(limit) ? limit : DEFAULT_MAX_ACTIVE_TURNS
}

interface Waiter {
  signal: AbortSignal
  resolve: () => void
  reject: (reason: Error) => void
  abort: () => void
}

function rejectionError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(errorMessage(reason))
}

/** FIFO admission for primary turns. A nested turn shares its parent's live lease. */
export class AgentTurnScheduler {
  private active = 0
  private readonly queue: Waiter[] = []
  private readonly context = new AsyncLocalStorage<{ active: boolean }>()

  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid active turn limit')
  }

  async run<T>(signal: AbortSignal, onQueued: () => void, run: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.context.getStore()?.active) return run()
    await this.acquire(signal, onQueued)
    const lease = { active: true }
    try {
      signal.throwIfAborted()
      return await this.context.run(lease, run)
    } finally {
      lease.active = false
      this.active--
      this.drain()
    }
  }

  private acquire(signal: AbortSignal, onQueued: () => void): Promise<void> {
    if (this.limit === 0 || this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.queue.indexOf(waiter)
          if (index !== -1) this.queue.splice(index, 1)
          signal.removeEventListener('abort', waiter.abort)
          reject(rejectionError(signal.reason))
        },
      }
      this.queue.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      try {
        onQueued()
      } catch (error) {
        const index = this.queue.indexOf(waiter)
        if (index !== -1) this.queue.splice(index, 1)
        signal.removeEventListener('abort', waiter.abort)
        reject(rejectionError(error))
      }
    })
  }

  private drain(): void {
    while (this.queue.length > 0 && (this.limit === 0 || this.active < this.limit)) {
      const waiter = this.queue.shift()
      if (!waiter) break
      waiter.signal.removeEventListener('abort', waiter.abort)
      if (waiter.signal.aborted) {
        waiter.reject(rejectionError(waiter.signal.reason))
        continue
      }
      this.active++
      waiter.resolve()
    }
  }
}

export const agentTurnScheduler = new AgentTurnScheduler(
  parseMaxActiveTurns(process.env['COPSE_MAX_ACTIVE_TURNS']),
)
