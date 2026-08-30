import { createHash, randomUUID } from 'node:crypto'
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
import { getActiveProjectId } from '../workspace.ts'
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
 * the decision it describes. Without an active project+thread the event is
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

/** Fields the writer resolves from ambient state when a caller omits them. */
export type RecordDecisionInput = Omit<DecisionInput, 'threadId'> & {
  /** Overrides the active-run thread; omit to attribute to the current run. */
  threadId?: string
  /** Overrides the active project; omit to attribute to the current project. */
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

/**
 * Record one decision onto the active thread spine. Best-effort and
 * fire-and-forget.
 */
export function recordDecision(input: RecordDecisionInput): void {
  try {
    const projectId = input.projectId ?? getActiveProjectId()
    const threadId = input.threadId ?? getActiveRunThread()
    if (!projectId || !threadId) {
      console.warn(
        '[decision-log] dropping decision — no active project/thread',
        { kind: input.kind, cause: input.cause, source: input.source },
      )
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

    void appendSpineDecision(projectId, threadId, line, detailContents).catch(() => undefined)
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
