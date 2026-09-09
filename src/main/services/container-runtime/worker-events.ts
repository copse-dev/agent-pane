/** Structured worker control records on stderr, separate from human-readable log lines. */
import { safeJsonParse } from '@shared/safe-json.ts'
import { isRecord } from '@shared/unknown-value.ts'
import type { ContainerRunPhase } from '@shared/types/container-run.ts'

export type WorkerPhase = Extract<ContainerRunPhase, 'installing' | 'running' | 'collecting'>
const PREFIX = '\u001eCOPSE:'

export function encodeWorkerPhase(phase: WorkerPhase): string {
  return `${PREFIX}${JSON.stringify({ type: 'phase', phase })}\n`
}

/** Only progress phases cross this boundary; terminal outcomes remain host-owned. */
export function decodeWorkerPhase(line: string): WorkerPhase | null {
  if (!line.startsWith(PREFIX) || line.length > 128) return null
  return safeJsonParse(line.slice(PREFIX.length), (value) => {
    if (!isRecord(value) || value['type'] !== 'phase') return null
    const phase = value['phase']
    return phase === 'installing' || phase === 'running' || phase === 'collecting' ? phase : null
  })
}
