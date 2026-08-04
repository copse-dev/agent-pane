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
 *   npm run report:prompt-causes -- <path…>      # explicit decisions.jsonl files
 *   npm run report:prompt-causes -- --json       # machine-readable
 *
 * Reads only the redacted durable log (`decisions.jsonl`); it never touches
 * transcripts or command text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseDecisionLog } from '../src/shared/threads/decision-log.ts'
import {
  promptCauseLabel,
  summarizePromptCauses,
  type PromptCauseSummary,
} from '../src/shared/threads/prompt-cause.ts'

const WORKSPACE_ROOT = join(homedir(), '.copse', 'workspace')

function defaultLogPaths(): string[] {
  let entries: string[]
  try {
    entries = readdirSync(WORKSPACE_ROOT)
  } catch {
    return []
  }
  return entries
    .map((entry) => join(WORKSPACE_ROOT, entry, 'decisions.jsonl'))
    .filter((path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
}

function readEvents(paths: readonly string[]): ReturnType<typeof parseDecisionLog> {
  return paths.flatMap((path) => {
    try {
      return parseDecisionLog(readFileSync(path, 'utf8'))
    } catch (error) {
      console.warn(`skipped ${path}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  })
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${((part / whole) * 100).toFixed(1)}%`
}

function printReport(summary: PromptCauseSummary, sources: number): void {
  console.log(`\nPrompt causes across ${String(sources)} decision log(s)\n`)
  if (summary.total === 0) {
    console.log('No prompts recorded yet.')
    if (summary.uncaused > 0) {
      console.log(`${String(summary.uncaused)} prompt(s) carried no cause.`)
    }
    return
  }

  const width = Math.max(...summary.rows.map((row) => promptCauseLabel(row.cause).length))
  console.log(
    `${'CAUSE'.padEnd(width)}  ${'N'.padStart(5)}  ${'SHARE'.padStart(6)}  ${'OK'.padStart(4)}  ${'NO'.padStart(4)}  CONTAINER`,
  )
  for (const row of summary.rows) {
    console.log(
      `${promptCauseLabel(row.cause).padEnd(width)}  ${String(row.total).padStart(5)}  ` +
        `${percent(row.total, summary.total).padStart(6)}  ${String(row.approved).padStart(4)}  ` +
        `${String(row.denied).padStart(4)}  ${row.containment}`,
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
const logPaths = paths.length > 0 ? paths : defaultLogPaths()

if (logPaths.length === 0) {
  console.error(`No decision logs found under ${WORKSPACE_ROOT}. Pass paths explicitly.`)
  process.exit(1)
}

const summary = summarizePromptCauses(readEvents(logPaths))
if (asJson) {
  console.log(JSON.stringify({ sources: logPaths.length, ...summary }, null, 2))
} else {
  printReport(summary, logPaths.length)
}
