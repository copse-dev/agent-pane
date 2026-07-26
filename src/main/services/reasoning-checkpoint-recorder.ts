import type { ReasoningCheckpointRecord } from '@copse/agent/reasoning-circle-detector.ts'
import { appendReasoningCheckpoint } from './thread-store.ts'
import { getHookRunRecordingContext, type HookRunRecordingSnapshot } from './hook-run-recorder.ts'

const REASONING_CHECKPOINT_SCHEMA_VERSION = 1

export interface ReasoningCheckpointLine extends ReasoningCheckpointRecord {
  schemaVersion: typeof REASONING_CHECKPOINT_SCHEMA_VERSION
  timestamp: string
  projectId: string
  threadId: string
  turnId: string
  model: string
}

/**
 * Persist a checkpoint decision without storing the model's private reasoning.
 * Best-effort observability — never blocks or throws into the agent loop.
 */
export function recordReasoningCheckpoint(
  record: ReasoningCheckpointRecord,
  model: string,
  snapshot: HookRunRecordingSnapshot | null = getHookRunRecordingContext(),
): void {
  if (!snapshot) return
  const line: ReasoningCheckpointLine = {
    schemaVersion: REASONING_CHECKPOINT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    projectId: snapshot.projectId,
    threadId: snapshot.threadId,
    turnId: snapshot.turnId,
    model,
    ...record,
  }
  appendReasoningCheckpoint(snapshot.projectId, line).catch((error: unknown) => {
    console.warn('[reasoning-checkpoint-recorder] failed to append checkpoint:', error)
  })
}
