import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  decisionLogManifest,
  makeDecisionEvent,
  parseDecisionLog,
  serializeDecisionLine,
  serializeDecisionLog,
  type DecisionEvent,
  type DecisionInput,
} from '@shared/threads/decision-log.ts'
import { projectStoreDir } from '../storage/copse-paths.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { getActiveProjectId } from '../workspace.ts'
import { getActiveRunThread } from '../thread-models.ts'

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Durable control-plane decision log (issue #656). Sits alongside the #644
 * thread spine under the same store root:
 *
 *   ~/.copse/workspace/<projectId>/decisions.jsonl
 *
 * append-only, one {@link DecisionEvent} per line. Decisions that fire with no
 * active project (headless / pre-open paths) are bucketed under `_global` so
 * they are never silently dropped. Writes go through the per-project write queue
 * (shared with the thread store) so concurrent gates can't interleave a line.
 *
 * Recording is best-effort: {@link recordDecision} never throws and never blocks
 * the decision it describes — an audit-log failure must not break the agent
 * loop. The `id`/`at` fields are stamped here (the pure schema module stays
 * Node-free); the writer applies secret redaction via {@link makeDecisionEvent}.
 */

const DECISIONS_FILE = 'decisions.jsonl'
const NO_PROJECT_BUCKET = '_global'

function decisionsPath(projectId: string): string {
  return join(projectStoreDir(projectId), DECISIONS_FILE)
}

function queueKey(projectId: string): string {
  return `decision-log:${projectId}`
}

/** Fields the writer resolves from ambient state when a caller omits them. */
export type RecordDecisionInput = Omit<DecisionInput, 'threadId'> & {
  /** Overrides the active-run thread; omit to attribute to the current run. */
  threadId?: string
  /** Overrides the active project; omit to attribute to the current project. */
  projectId?: string
}

/**
 * Record one decision. Best-effort and fire-and-forget: resolves the active
 * project/thread when not supplied, redacts and stamps the event, and appends it
 * to the project's `decisions.jsonl`. Swallows every error so a broken audit
 * write can never surface to — or stall — the caller.
 */
export function recordDecision(input: RecordDecisionInput): void {
  try {
    const projectId = input.projectId ?? getActiveProjectId() ?? NO_PROJECT_BUCKET
    const threadId = input.threadId ?? getActiveRunThread() ?? undefined
    const { projectId: _p, threadId: _t, ...rest } = input
    const event = makeDecisionEvent(
      { ...rest, ...(threadId ? { threadId } : {}) },
      randomUUID(),
      Date.now(),
    )
    // Chain on the same per-project queue as the thread store so an append can't
    // interleave with another line. The op itself is a single atomic appendFile.
    // Swallow an async write failure too (the outer try only catches the enqueue)
    // so a disk error can never surface as an unhandled rejection.
    void runSerialized(queueKey(projectId), () => {
      appendDecision(projectId, event)
    }).catch(() => undefined)
  } catch {
    // Never let an audit-log failure escape into the decision path.
  }
}

function appendDecision(projectId: string, event: DecisionEvent): void {
  const path = decisionsPath(projectId)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${serializeDecisionLine(event)}\n`)
}

/** Read a project's decision log, newest-last (append order). Empty when absent. */
export function readDecisionLog(projectId: string): Promise<DecisionEvent[]> {
  return runSerialized(queueKey(projectId), () =>
    parseDecisionLog(safeRead(decisionsPath(projectId)) ?? ''),
  )
}

export interface DecisionLogExport {
  /** Absolute path of the written export file. */
  path: string
  /** Number of decision events exported (excludes the manifest line). */
  count: number
}

/**
 * Export a project's decision log as a self-describing JSONL bundle: a
 * {@link decisionLogManifest} header line (media type + schema version +
 * conformance target) followed by the redacted decision events. Written under
 * `<project>/exports/`. Events are already redacted at record time; the export
 * re-affirms that by round-tripping through the same shape.
 */
export function exportDecisionLog(projectId: string): Promise<DecisionLogExport> {
  return runSerialized(queueKey(projectId), () => {
    const events = parseDecisionLog(safeRead(decisionsPath(projectId)) ?? '')
    const exportsDir = join(projectStoreDir(projectId), 'exports')
    mkdirSync(exportsDir, { recursive: true })
    const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, '-')
    const path = join(exportsDir, `decisions-${stamp}.jsonl`)
    const manifest = decisionLogManifest(events.length, Date.now())
    writeFileSync(path, `${JSON.stringify(manifest)}\n${serializeDecisionLog(events)}`)
    return { path, count: events.length }
  })
}
