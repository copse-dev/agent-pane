/**
 * Main's record of the large calls a renderer makes (#4445).
 *
 * The preload reports a call before sending it when its arguments are large,
 * and refuses it when they are over the limit. Main logs those reports and
 * keeps the latest per window, so a renderer that dies while sending one leaves
 * its channel in the crash line. Records carry a channel name and a size, never
 * the arguments themselves.
 */

import { z } from 'zod'
import { IPC_ARGUMENT_LIMIT_BYTES, IPC_LARGE_CALL_CHANNEL } from '@shared/ipc-size-limits.ts'

/**
 * At most one line per channel and kind (large or refused) in this interval,
 * across all windows; the rest are counted.
 */
export const LARGE_IPC_LOG_INTERVAL_MS = 30_000
/** How long a report stays relevant to a renderer death. */
export const LARGE_IPC_RECENT_MS = 60_000
/** Channel names come from the renderer, so the tables they key are bounded. */
const MAX_TRACKED = 64

const reportSchema = z.object({
  channel: z.string().regex(/^[\w:.-]{1,96}$/),
  bytes: z.number().nonnegative(),
  refused: z.boolean(),
})

interface LargeIpcCall {
  channel: string
  bytes: number
  refused: boolean
  at: number
}

export interface LargeIpcCallLog {
  /** Take one report from the renderer with this `webContents` id. */
  record: (webContentsId: number, raw: unknown) => void
  /** The window's latest report if it is recent, formatted for a log line. */
  describeRecent: (webContentsId: number) => string | null
}

function megabytes(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))}MB`
}

interface Printed {
  at: number
  coalesced: number
}

export function createLargeIpcCallLog(
  options: { log?: (message: string) => void; now?: () => number } = {},
): LargeIpcCallLog {
  const log =
    options.log ??
    ((message: string): void => {
      console.warn(message)
    })
  const now = options.now ?? Date.now
  const latest = new Map<number, LargeIpcCall>()
  const printed = new Map<string, Printed>()

  /** Whether a line for `key` may be printed now, and how many it stands for. */
  const admit = (key: string, at: number): Printed | null => {
    const previous = printed.get(key)
    if (previous && at - previous.at < LARGE_IPC_LOG_INTERVAL_MS) {
      previous.coalesced += 1
      return null
    }
    if (!previous && printed.size >= MAX_TRACKED) {
      for (const [stale, entry] of printed) {
        if (at - entry.at >= LARGE_IPC_LOG_INTERVAL_MS) printed.delete(stale)
      }
      // Still full of live entries: more distinct names than real channels
      // produce. Drop the line instead of letting names rotate through the log.
      if (printed.size >= MAX_TRACKED) return null
    }
    printed.set(key, { at, coalesced: 0 })
    return previous ?? { at, coalesced: 0 }
  }

  return {
    record: (webContentsId, raw): void => {
      const parsed = reportSchema.safeParse(raw)
      if (!parsed.success) return
      const call: LargeIpcCall = { ...parsed.data, at: now() }
      latest.delete(webContentsId)
      latest.set(webContentsId, call)
      if (latest.size > MAX_TRACKED) {
        for (const oldest of latest.keys()) {
          latest.delete(oldest)
          break
        }
      }

      const before = admit(`${call.refused ? 'refused' : 'large'}:${call.channel}`, call.at)
      if (!before) return
      const coalesced = before.coalesced > 0 ? ` coalesced=${String(before.coalesced)}` : ''
      log(
        call.refused
          ? `[ipc] refused oversized renderer call channel=${call.channel} ` +
              `limit=${megabytes(IPC_ARGUMENT_LIMIT_BYTES)}${coalesced}`
          : `[ipc] large renderer call channel=${call.channel} ` +
              `estimated<=${megabytes(call.bytes)}${coalesced}`,
      )
    },
    describeRecent: (webContentsId): string | null => {
      const call = latest.get(webContentsId)
      if (!call) return null
      const ago = now() - call.at
      if (ago > LARGE_IPC_RECENT_MS) return null
      const size = call.refused ? 'refused' : `estimated<=${megabytes(call.bytes)}`
      return `lastLargeIpc=${call.channel} ${size} ago=${String(Math.max(0, Math.round(ago)))}ms`
    },
  }
}

/** The log every app window reports into. */
export const largeIpcCalls = createLargeIpcCallLog()

/**
 * Receive the preload's reports. `isAppWindow` decides whether the sender is one
 * of our own windows; a report from anywhere else is dropped rather than
 * raised, because a diagnostic must never surface as an error in the app.
 */
export function installLargeIpcCallChannel<
  Event extends { readonly sender: { readonly id: number } },
>(
  ipc: { on: (channel: string, listener: (event: Event, raw: unknown) => void) => unknown },
  isAppWindow: (event: Event) => boolean,
  calls: LargeIpcCallLog,
): void {
  ipc.on(IPC_LARGE_CALL_CHANNEL, (event, raw) => {
    if (isAppWindow(event)) calls.record(event.sender.id, raw)
  })
}
