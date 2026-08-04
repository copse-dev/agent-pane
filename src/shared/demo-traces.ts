import type { StreamChunk } from './types/stream.ts'

/**
 * A recorded agent turn, replayable through the browser demo's stream path.
 *
 * A trace is a near-1:1 projection of a real thread's JSONL export
 * (`threadToJsonl`): one user prompt plus the chunks the renderer would have
 * received while the assistant answered it. `scripts/build-demo-trace.mts`
 * writes these from an export, so the demo shows work that actually happened
 * rather than copy written to look like it did.
 *
 * Two things a trace deliberately does *not* carry:
 *
 * - **Timing of the original run.** Exports keep message timestamps, not
 *   token-level arrival times. The player paces text at a fixed characters-
 *   per-second rate and uses `delayMs` for the gaps between chunks, so a
 *   two-minute turn replays in a hero-sized window.
 * - **Sub-chunk text splits.** A `text` chunk holds the message's whole body;
 *   the player slices it on word boundaries at playback time. That keeps the
 *   committed trace readable in review and diffable when it is regenerated.
 */
export interface DemoTraceStep {
  /** Chunk to emit, exactly as the agent loop would have emitted it. */
  chunk: StreamChunk
  /** Pause before emitting, on top of the pacing the player applies. */
  delayMs?: number
}

/** Where a trace came from, so a rendered demo can be traced back to its run. */
export interface DemoTraceSource {
  /** `exportVersion` of the JSONL the trace was built from. */
  exportVersion: number
  /** Thread id in the originating export. */
  threadId: string
  /** Thread title in the originating export. */
  title: string
  /** Zero-based index of the user turn this trace replays. */
  turn: number
  /** Model that answered the turn, when the export recorded one. */
  model?: string
}

export interface DemoTrace {
  id: string
  label: string
  /** User message that opened the turn; typed into the composer on autoplay. */
  prompt: string
  /** Ordered chunks, ending with a `done`. */
  steps: DemoTraceStep[]
  source?: DemoTraceSource
}

/** Total characters of streamed prose in a trace — the player's pacing budget. */
export function traceTextLength(trace: DemoTrace): number {
  let total = 0
  for (const step of trace.steps) {
    if (step.chunk.type === 'text' || step.chunk.type === 'reasoning') {
      total += step.chunk.text.length
    }
  }
  return total
}
