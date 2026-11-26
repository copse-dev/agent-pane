import {
  acquireWriterLease,
  defaultWriterLeaseEnvironment,
  releaseWriterLease,
  renewWriterLease,
  WRITER_LEASE_TTL_MS,
  type WriterLeaseEnvironment,
  type WriterLeaseRecord,
} from '@copse/thread-store/writer-lease.ts'
import { threadDirectoryPath } from './thread-store.ts'

/**
 * The app's side of the per-thread writer lease (`@copse/thread-store/writer-lease.ts`):
 * take it before a turn, keep its heartbeat while the turn runs, give it back after.
 */

export interface ThreadWriterClaim {
  readonly lease: WriterLeaseRecord
  /** Stop the heartbeat and give the lease up. Safe to call more than once. */
  release(): Promise<void>
}

export type ThreadWriterClaimResult =
  | { status: 'claimed'; claim: ThreadWriterClaim }
  | { status: 'held'; holder: Pick<WriterLeaseRecord, 'host' | 'pid' | 'owner'> }

export interface ThreadWriterClaimOptions {
  /** Called once if the lease is lost while held: the turn must stop writing. */
  onLost: () => void
  env?: WriterLeaseEnvironment
  ttlMs?: number
  /** Where the thread lives; the profile's store by default. */
  threadDir?: string
}

export async function claimThreadWriter(
  projectId: string,
  threadId: string,
  options: ThreadWriterClaimOptions,
): Promise<ThreadWriterClaimResult> {
  const env = options.env ?? defaultWriterLeaseEnvironment()
  const ttlMs = options.ttlMs ?? WRITER_LEASE_TTL_MS
  const dir = options.threadDir ?? threadDirectoryPath(projectId, threadId)
  const result = await acquireWriterLease(dir, threadId, env, ttlMs)
  if (result.status === 'held') {
    const { host, pid, owner } = result.holder
    return { status: 'held', holder: { host, pid, owner } }
  }
  const lease = result.lease
  let released = false
  // Read through a call: `release()` may flip it while a renewal is awaited.
  const isReleased = (): boolean => released
  let renewing: Promise<void> = Promise.resolve()
  const timer = setInterval(
    () => {
      renewing = renewing.then(async () => {
        if (isReleased()) return
        let kept: boolean
        try {
          kept = await renewWriterLease(dir, lease, env)
        } catch {
          // A transient read or write failure is not evidence another process
          // took over; the next beat retries well inside the time-to-live.
          return
        }
        if (kept || isReleased()) return
        released = true
        clearInterval(timer)
        options.onLost()
      })
    },
    Math.max(1, Math.floor(ttlMs / 3)),
  )
  timer.unref()
  return {
    status: 'claimed',
    claim: {
      lease,
      release: async (): Promise<void> => {
        clearInterval(timer)
        if (released) return
        released = true
        await renewing
        await releaseWriterLease(dir, lease, env)
      },
    },
  }
}
