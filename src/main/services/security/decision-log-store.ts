import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decisionLogManifest,
  makeDecisionEvent,
  serializeDecisionLog,
  type DecisionEvent,
  type DecisionInput,
} from '@shared/threads/decision-log.ts'
import {
  decisionDetailBlobRef,
  parseSpineEntries,
  type SpineDecisionLine,
  type SpinePermissionDecisionLine,
} from '@shared/threads/spine-schema.ts'
import { projectStoreDir } from '../storage/copse-paths.ts'
import { runSerialized } from '../storage/write-queue.ts'
import { currentThreadExecutionContext } from '../thread-execution-context-store.ts'
import { getActiveRunThread } from '../thread-models.ts'
import { appendSpineDecision } from '../thread-store.ts'

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Durable control-plane decision log (issue #656). Appended as `decision` lines
 * on each thread's `events.jsonl` (with optional `blobs/decision-*.detail.json`
 * for argv / YOLO extras). The legacy project-level `decisions.jsonl` is no
 * longer written; readers ignore/delete it.
 *
 * Recording is best-effort: {@link recordDecision} never throws and never blocks
 * the decision it describes. Without a resolvable project+thread the event is
 * dropped (there is no `_global` file anymore).
 */

const LEGACY_DECISIONS_FILE = 'decisions.jsonl'

function queueKey(projectId: string): string {
  return `thread-store:${projectId}`
}

function legacyDecisionsPath(projectId: string): string {
  return join(projectStoreDir(projectId), LEGACY_DECISIONS_FILE)
}

function deleteLegacyDecisionLog(projectId: string): void {
  try {
    unlinkSync(legacyDecisionsPath(projectId))
  } catch {
    // absent or unreadable — fine
  }
}

/** Fields the writer resolves from the running turn when a caller omits them. */
export type RecordDecisionInput = Omit<DecisionInput, 'threadId'> & {
  /** Overrides the active-run thread; omit to attribute to the current run. */
  threadId?: string
  /**
   * The thread's project. Omit only inside a turn: the project is then the
   * turn's (for an explicit `threadId`, only that thread's own turn). Never the
   * window's active project, which can be a different one.
   */
  projectId?: string
  /** Optional turn correlation (hook recording context). */
  turnId?: string
  step?: number
  /**
   * Structured detail stored in a thread blob (shell argv, YOLO harm fields).
   * Not redacted beyond JSON serialization — treat as thread-sensitive like tool
   * args.
   */
  detail?: Record<string, unknown>
}

export interface RecordedDecision {
  readonly projectId: string
  readonly threadId: string
  readonly line: SpineDecisionLine
  readonly detailContents?: string
}

const scopedRecorder = new AsyncLocalStorage<(decision: RecordedDecision) => void>()

/** Route an explicit host's audit records without writing the desktop thread store. */
export function runWithDecisionRecorder<T>(
  recorder: (decision: RecordedDecision) => void,
  operation: () => T,
): T {
  return scopedRecorder.run(recorder, operation)
}

/** Persist an explicitly owned host record through the normal serialized thread writer. */
export function persistRecordedDecision(decision: RecordedDecision): void {
  void appendSpineDecision(
    decision.projectId,
    decision.threadId,
    decision.line,
    decision.detailContents,
  ).catch(() => undefined)
}

/**
 * The running turn's project for a decision on `threadId`. A thread the caller
 * named borrows it only from its own turn. A decision that names no thread
 * belongs to the running turn whatever thread the run identity reports: an
 * isolated worker runs its own turn inside its parent's run, in the same project.
 */
function turnProjectFor(threadId: string | null, threadNamed: boolean): string | undefined {
  const context = currentThreadExecutionContext()
  if (context === null) return undefined
  return !threadNamed || context.threadId === threadId ? context.projectId : undefined
}

/**
 * Record one decision onto the active thread spine. Best-effort and
 * fire-and-forget.
 */
export function recordDecision(input: RecordDecisionInput): void {
  try {
    const threadId = input.threadId ?? getActiveRunThread()
    const projectId = input.projectId ?? turnProjectFor(threadId, input.threadId !== undefined)
    if (!projectId || !threadId) {
      console.warn('[decision-log] dropping decision — no active project/thread', {
        kind: input.kind,
        cause: input.cause,
        source: input.source,
      })
      return
    }

    const { projectId: _p, threadId: _t, detail, turnId, step, ...rest } = input
    const id = randomUUID()
    const at = Date.now()
    const event = makeDecisionEvent({ ...rest, threadId }, id, at)

    let detailContents: string | undefined
    let line: SpineDecisionLine = {
      ...event,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(step !== undefined ? { step } : {}),
    }
    if (detail !== undefined) {
      detailContents = JSON.stringify(detail)
      line = {
        ...line,
        detail: { ref: decisionDetailBlobRef(id), sha256: sha256(detailContents) },
      }
    }

    const recorder = scopedRecorder.getStore()
    if (recorder) {
      recorder({
        projectId,
        threadId,
        line,
        ...(detailContents !== undefined ? { detailContents } : {}),
      })
    } else {
      persistRecordedDecision({
        projectId,
        threadId,
        line,
        ...(detailContents !== undefined ? { detailContents } : {}),
      })
    }
  } catch {
    // Never let an audit-log failure escape into the decision path.
  }
}

function legacyPermissionToEvent(
  line: SpinePermissionDecisionLine,
  threadId: string,
): DecisionEvent {
  const verdict =
    line.userResponse === 'approved'
      ? 'approved'
      : line.userResponse === 'declined'
        ? 'denied'
        : 'allowed'
  return {
    v: 1,
    type: 'decision',
    id: line.id,
    at: line.decidedAt,
    kind: 'shell',
    actor: line.userResponse === 'not-required' ? 'system' : 'user',
    verdict,
    subject: 'shell command (arguments omitted)',
    scope: line.sandboxState === 'unsandboxed' ? 'external' : 'sandbox',
    reasons: line.reasons,
    threadId,
    cause: 'shell-guarded-yolo-harm',
  }
}

function collectThreadDecisionEvents(projectId: string): DecisionEvent[] {
  const root = projectStoreDir(projectId)
  let entries: string[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }

  const out: DecisionEvent[] = []
  for (const threadId of entries) {
    const raw = safeRead(join(root, threadId, 'events.jsonl'))
    if (raw === null) continue
    for (const entry of parseSpineEntries(raw)) {
      if (entry.line?.type === 'decision') {
        const { detail: _d, turnId: _t, step: _s, ...event } = entry.line
        out.push(event)
      } else if (entry.line?.type === 'permission_decision') {
        out.push(legacyPermissionToEvent(entry.line, threadId))
      }
    }
  }
  out.sort((a, b) => a.at - b.at)
  return out
}

/**
 * Read one thread's decisions, oldest first. Callers must pass ids that already
 * satisfy the `[\w-]` id schema: they become path segments.
 */
export function readThreadDecisionLog(
  projectId: string,
  threadId: string,
): Promise<DecisionEvent[]> {
  return runSerialized(queueKey(projectId), () => {
    const raw = safeRead(join(projectStoreDir(projectId), threadId, 'events.jsonl'))
    if (raw === null) return []
    const out: DecisionEvent[] = []
    for (const entry of parseSpineEntries(raw)) {
      if (entry.line?.type === 'decision') {
        const { detail: _d, turnId: _t, step: _s, ...event } = entry.line
        out.push(event)
      } else if (entry.line?.type === 'permission_decision') {
        out.push(legacyPermissionToEvent(entry.line, threadId))
      }
    }
    return out
  })
}

/** Read a project's decisions from every thread spine, newest-last. */
export function readDecisionLog(projectId: string): Promise<DecisionEvent[]> {
  return runSerialized(queueKey(projectId), () => {
    deleteLegacyDecisionLog(projectId)
    return collectThreadDecisionEvents(projectId)
  })
}

export interface DecisionLogExport {
  /** Absolute path of the written export file. */
  path: string
  /** Number of decision events exported (excludes the manifest line). */
  count: number
}

/**
 * Export a project's decision log as a self-describing JSONL bundle (redacted
 * spine fields only — detail blobs are not inlined).
 */
export function exportDecisionLog(projectId: string): Promise<DecisionLogExport> {
  return runSerialized(queueKey(projectId), () => {
    deleteLegacyDecisionLog(projectId)
    const events = collectThreadDecisionEvents(projectId)
    const exportsDir = join(projectStoreDir(projectId), 'exports')
    mkdirSync(exportsDir, { recursive: true })
    const stamp = new Date(Date.now()).toISOString().replace(/[:.]/g, '-')
    const path = join(exportsDir, `decisions-${stamp}.jsonl`)
    const manifest = decisionLogManifest(events.length, Date.now())
    writeFileSync(path, `${JSON.stringify(manifest)}\n${serializeDecisionLog(events)}`)
    return { path, count: events.length }
  })
}
