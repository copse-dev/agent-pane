/**
 * Contract between the preload's IPC size guard and main's record of large
 * renderer calls (#4445).
 */

const MIB = 1024 * 1024

/** Arguments estimated at or above this size are reported to main before they are sent. */
export const IPC_ARGUMENT_REPORT_BYTES = 32 * MIB

/**
 * Arguments estimated above this size are refused instead of sent.
 *
 * Electron serializes IPC arguments into a buffer that V8 grows by doubling,
 * and Chromium's allocator aborts the process on a single allocation above
 * about 2 GiB. A call is therefore certain to survive only while its arguments
 * stay under about 1 GiB serialized. Past that it depends on how the buffer
 * happened to grow, and past 2 GiB it always kills the renderer.
 *
 * The limit sits just under the certain bound, so nothing that could abort is
 * sent and as little as possible that would have worked is refused. The margin
 * covers what the estimate does not model.
 */
export const IPC_ARGUMENT_LIMIT_BYTES = 960 * MIB

/** Fire-and-forget report the preload sends before a large call. */
export const IPC_LARGE_CALL_CHANNEL = 'diagnostics:ipc-large-call'

export interface IpcLargeCallReport {
  /** The channel the renderer was about to use. */
  channel: string
  /**
   * Upper bound on the serialized size of the arguments. For a refused call
   * the estimate stops once it passes the limit, so this is only "more than
   * the limit".
   */
  bytes: number
  /** True when the preload refused the call instead of sending it. */
  refused: boolean
}
