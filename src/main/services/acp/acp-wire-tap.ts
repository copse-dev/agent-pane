import type { AnyMessage, Stream } from '@agentclientprotocol/sdk'

/**
 * Pure transport plumbing for observing an ACP connection's inbound messages.
 *
 * Deliberately dependency-free — SDK types and nothing else. `acp-client.ts` is
 * bundled into the standalone probe worker, which must stay clear of electron
 * and node-pty (see `acp-probe-worker.ts`), so the tap cannot live next to its
 * filesystem-backed consumer. The sink that writes `acp-debug.jsonl` lives in
 * `acp-wire-trace.ts` and reaches the thread store; this module never does.
 */

/** Anything that wants a copy of each inbound wire message. */
export interface AcpWireSink {
  /** Called once per inbound message, in wire order, before any parsing. */
  record: (message: unknown) => void
}

/**
 * Route an ACP transport's inbound messages through `sink` before the SDK sees
 * them. `null` returns the caller's own stream, so the disabled path adds no
 * transform, no allocation, and no behavior change whatsoever.
 *
 * The tap sits on the message stream (`ndJsonStream`'s output), which is raw
 * `JSON.parse` output — every field the agent sent is still present, including
 * the ones the ACP schema is about to strip. Errors and cancellation propagate
 * through `pipeThrough` exactly as before, so a dying agent process still
 * errors the connection the same way.
 */
export function tapAcpWireStream(stream: Stream, sink: AcpWireSink | null): Stream {
  if (!sink) return stream
  const tap = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller): void {
      try {
        sink.record(message)
      } catch (err) {
        console.warn('[acp-wire-tap] failed to record an inbound message:', err)
      }
      controller.enqueue(message)
    },
  })
  return { readable: stream.readable.pipeThrough(tap), writable: stream.writable }
}
