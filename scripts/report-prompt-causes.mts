/**
 * Report how often the permission gate interrupted, broken down by cause and by
 * what would remove each interruption.
 *
 * This is the measurement behind `docs/plans/deferred-approvals.md` phase D0 and
 * `docs/plans/unattended-runs.md` phase U0: the decision to build a container
 * runtime rests on prompts being dominated by causes a container removes, and
 * that is a question about real logs rather than intuition.
 *
 *   npm run report:prompt-causes                 # every project store
 *   npm run report:prompt-causes -- <path…>      # thread events.jsonl and/or legacy decisions.jsonl
 *   npm run report:prompt-causes -- --json       # machine-readable
 *
 * Reads redacted `decision` spine lines (and legacy `permission_decision` /
 * project `decisions.jsonl` when still present). It never opens detail blobs or
 * tool-arg blobs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDecisionLog, type DecisionEvent } from '../src/shared/threads/decision-log.ts'
import {
  parseSpineEntries,
  type SpinePermissionDecisionLine,
} from '../src/shared/threads/spine-schema.ts'
import {
  promptCauseLabel,
  summarizePromptCauses,
  type PromptCauseSummary,
} from '../src/shared/threads/prompt-cause.ts'

const WORKSPACE_ROOT = join(homedir(), '.copse', 'workspace')

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

function eventsFromSpine(raw: string, threadId: string): DecisionEvent[] {
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
}

function collectFromProject(projectDir: string): DecisionEvent[] {
  let entries: string[]
  try {
    entries = readdirSync(projectDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const out: DecisionEvent[] = []
  for (const threadId of entries) {
    try {
      const raw = readFileSync(join(projectDir, threadId, 'events.jsonl'), 'utf8')
      out.push(...eventsFromSpine(raw, threadId))
    } catch {
      // missing spine — fine
    }
  }
  try {
    out.push(...parseDecisionLog(readFileSync(join(projectDir, 'decisions.jsonl'), 'utf8')))
  } catch {
    // legacy file absent — fine
  }
  return out
}

function defaultProjectDirs(): string[] {
  let entries: string[]
  try {
    entries = readdirSync(WORKSPACE_ROOT)
  } catch {
    return []
  }
  return entries
    .map((entry) => join(WORKSPACE_ROOT, entry))
    .filter((path) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    })
}

function readEventsFromPath(path: string): DecisionEvent[] {
  try {
    const st = statSync(path)
    if (st.isDirectory()) return collectFromProject(path)
    const raw = readFileSync(path, 'utf8')
    if (path.endsWith('events.jsonl')) {
      const parts = path.split(/[/\\]/)
      const threadId = parts.at(-2) ?? 'unknown'
      return eventsFromSpine(raw, threadId)
    }
    return parseDecisionLog(raw)
  } catch (error) {
    console.warn(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(1)}%`
}

function printReport(summary: PromptCauseSummary, sources: number): void {
  console.log(`\nPrompt causes across ${String(sources)} source(s)\n`)
  if (summary.total === 0) {
    console.log('No prompts recorded yet.')
    if (summary.uncaused > 0) {
      console.log(`${String(summary.uncaused)} prompt(s) carried no cause.`)
    }
    return
  }

  const width = Math.max(...summary.rows.map((row) => promptCauseLabel(row.cause).length))
  console.log(
    `${'CAUSE'.padEnd(width)}  ${'N'.padStart(5)}  ${'SHARE'.padStart(6)}  ${'OK'.padStart(4)}  ` +
      `${'NO'.padStart(4)}  ${'DEFER'.padStart(5)}  CONTAINER`,
  )
  for (const row of summary.rows) {
    console.log(
      `${promptCauseLabel(row.cause).padEnd(width)}  ${String(row.total).padStart(5)}  ` +
        `${percent(row.total, summary.total).padStart(6)}  ${String(row.approved).padStart(4)}  ` +
        `${String(row.denied).padStart(4)}  ${String(row.deferred).padStart(5)}  ${row.containment}`,
    )
  }

  const deferred = summary.rows.reduce((sum, row) => sum + row.deferred, 0)
  if (deferred > 0) {
    console.log(
      `\n${String(deferred)} of these were queued for review rather than shown ` +
        '(an unattended run was active), so they did not interrupt anyone.',
    )
  }

  const { removed, kept, mixed } = summary.byContainment
  console.log(`\nTotal prompts: ${String(summary.total)}`)
  console.log(`  a container removes:      ${String(removed)} (${percent(removed, summary.total)})`)
  console.log(`  a container keeps:        ${String(kept)} (${percent(kept, summary.total)})`)
  console.log(`  depends on the action:    ${String(mixed)} (${percent(mixed, summary.total)})`)
  if (summary.uncaused > 0) {
    console.log(
      `\n${String(summary.uncaused)} prompt(s) recorded without a cause — either written ` +
        'before this instrumentation, or an uninstrumented gate path. Treat the ' +
        'breakdown above as a lower bound until this reaches zero.',
    )
  }
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const paths = args.filter((arg) => !arg.startsWith('--'))
const sources = paths.length > 0 ? paths : defaultProjectDirs()

if (sources.length === 0) {
  console.error(`No project stores found under ${WORKSPACE_ROOT}. Pass paths explicitly.`)
  process.exit(1)
}

const events = sources.flatMap((path) => readEventsFromPath(path))
const summary = summarizePromptCauses(events)
if (asJson) {
  console.log(JSON.stringify({ sources: sources.length, ...summary }, null, 2))
} else {
  printReport(summary, sources.length)
}
