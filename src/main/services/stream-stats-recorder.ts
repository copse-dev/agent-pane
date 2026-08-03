import type { StreamCutRecord } from '@copse/agent/stream-cut-record.ts'
import { CHARS_PER_TOKEN } from '@copse/agent/token-estimate.ts'
import { appendStreamStat } from './thread-store.ts'
import { getHookRunRecordingContext, type HookRunRecordingSnapshot } from './hook-run-recorder.ts'

const STREAM_STATS_SCHEMA_VERSION = 1

export interface StreamStatLine extends StreamCutRecord {
  schemaVersion: typeof STREAM_STATS_SCHEMA_VERSION
  timestamp: string
  projectId: string
  threadId: string
  turnId: string
  model: string
  totalTokensEstimate: number
  reasoningTokensEstimate: number
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function buildStreamStatLine(
  ctx: HookRunRecordingSnapshot,
  model: string,
  record: StreamCutRecord,
): StreamStatLine {
  return {
    schemaVersion: STREAM_STATS_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    projectId: ctx.projectId,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    model,
    totalTokensEstimate: estimateTokens(record.streamOutputChars),
    reasoningTokensEstimate: estimateTokens(record.streamReasoningChars),
    ...record,
  }
}

/**
 * Persist a stream-cut record to `~/.copse/workspace/<projectId>/stream-stats.jsonl`.
 * Best-effort observability — never blocks or throws into the agent loop.
 */
export function recordStreamCut(
  record: StreamCutRecord,
  model: string,
  snapshot: HookRunRecordingSnapshot | null = getHookRunRecordingContext(),
): void {
  const ctx = snapshot
  if (!ctx) return
  const line = buildStreamStatLine(ctx, model, record)
  appendStreamStat(ctx.projectId, line).catch((err: unknown) => {
    console.warn('[stream-stats-recorder] failed to append stream cut record:', err)
  })
}
