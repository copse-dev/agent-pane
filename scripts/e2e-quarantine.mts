/**
 * Nightly quarantine run helper (.github/workflows/e2e-quarantine.yml).
 *
 *   node scripts/e2e-quarantine.mts specs
 *     Print the quarantined specs wdio.quarantine.conf.ts runs, one per line.
 *
 *   node scripts/e2e-quarantine.mts report --outcomes <dir> --out <history.json>
 *       [--history <previous-history.json>] [--commit <sha>] [--date <YYYY-MM-DD>] [--counted]
 *     Fold tonight's per-spec outcomes into the rolling history, print pass
 *     streaks and a warning annotation for each restore candidate, and append
 *     the same to $GITHUB_STEP_SUMMARY. Only `--counted` runs (the scheduled run
 *     on main) are written to the history; any other run reports a preview.
 *
 * Advisory only: it never fails because a quarantined spec failed.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { exclusionRegistrySchema } from './lib/e2e-exclusions.mts'
import {
  RESTORE_STREAK,
  appendNight,
  nightResults,
  passStreaks,
  quarantineHistorySchema,
  quarantinedSpecs,
  type QuarantineHistory,
} from './lib/e2e-quarantine.mts'
import { parseOutcome } from './lib/gate-evidence.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

const [command, ...rest] = process.argv.slice(2)
const registry = safeJsonParse(
  readFileSync('tests/e2e/exclusions.json', 'utf8'),
  decodeWithSchema(exclusionRegistrySchema),
)
if (!registry) throw new Error('Invalid tests/e2e/exclusions.json')
const specs = quarantinedSpecs(registry)

if (command === 'specs') {
  for (const spec of specs) console.log(spec)
} else if (command === 'report') {
  const { values } = parseArgs({
    args: rest,
    options: {
      outcomes: { type: 'string' },
      history: { type: 'string' },
      out: { type: 'string' },
      commit: { type: 'string' },
      date: { type: 'string' },
      counted: { type: 'boolean', default: false },
    },
  })
  if (!values.outcomes || !values.out)
    throw new Error('Usage: e2e-quarantine.mts report --outcomes <dir> --out <history.json>')
  report({
    outcomes: values.outcomes,
    history: values.history,
    out: values.out,
    commit: values.commit ?? process.env['GITHUB_SHA'] ?? 'local',
    date: values.date ?? new Date().toISOString().slice(0, 10),
    counted: values.counted,
  })
} else {
  throw new Error('Usage: e2e-quarantine.mts specs | report ...')
}

function readHistory(path: string | undefined): QuarantineHistory | null {
  if (!path || !existsSync(path)) return null
  const history = safeJsonParse(
    readFileSync(path, 'utf8'),
    decodeWithSchema(quarantineHistorySchema),
  )
  // A corrupt record restarts the streaks rather than inventing them.
  if (!history)
    console.log(`::warning title=Quarantine history unreadable::${path}; streaks restart`)
  return history
}

function report(options: {
  outcomes: string
  history: string | undefined
  out: string
  commit: string
  date: string
  counted: boolean
}): void {
  const outcomes = existsSync(options.outcomes)
    ? readdirSync(options.outcomes)
        .filter((name) => name.endsWith('.json'))
        .flatMap((name) => {
          try {
            return [parseOutcome(readFileSync(join(options.outcomes, name), 'utf8'))]
          } catch {
            console.log(`::warning title=Unreadable e2e outcome::${name}`)
            return []
          }
        })
    : []
  const previous = readHistory(options.history)
  const night = {
    runId: process.env['GITHUB_RUN_ID'] ?? 'local',
    runAttempt: process.env['GITHUB_RUN_ATTEMPT'] ?? '1',
    date: options.date,
    commit: options.commit,
    results: nightResults(specs, outcomes),
  }
  const withTonight = appendNight(previous, night)
  const recorded = options.counted ? withTonight : (previous ?? { version: 1, nights: [] })
  writeFileSync(options.out, JSON.stringify(recorded, null, 2) + '\n')

  const streaks = passStreaks(withTonight, specs)
  const lines = [
    '## Nightly quarantine run',
    '',
    options.counted
      ? `Counted toward pass streaks (${String(previous?.nights.length ?? 0)} earlier night(s) on record).`
      : `Preview only: this run is not a scheduled run on main, so it is not recorded. Streaks below add it to ${String(previous?.nights.length ?? 0)} recorded night(s).`,
    '',
  ]
  if (specs.length === 0) {
    lines.push('No spec in tests/e2e/exclusions.json is quarantined by wdio.ci.conf.ts.')
  } else {
    lines.push('| Spec | Tonight | Consecutive passing nights |', '| --- | --- | --- |')
    for (const spec of specs) {
      const streak = streaks.get(spec) ?? 0
      lines.push(`| \`${spec}\` | ${night.results[spec] ?? 'missing'} | ${String(streak)} |`)
    }
    lines.push('')
    for (const spec of specs) {
      const streak = streaks.get(spec) ?? 0
      console.log(`${spec}: ${night.results[spec] ?? 'missing'} tonight, streak ${String(streak)}`)
      if (streak < RESTORE_STREAK) continue
      const message = `${spec} has passed ${String(streak)} consecutive nightly quarantine runs. It is a restore candidate: confirm the root cause, then remove its wdio.ci.conf.ts exclusion and registry entry.`
      if (options.counted) {
        console.log(`::warning title=Quarantined spec is a restore candidate::${message}`)
        lines.push(`- **Restore candidate:** ${message}`)
      } else {
        lines.push(`- Preview only, not annotated: ${message}`)
      }
    }
  }
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) appendFileSync(summary, lines.join('\n') + '\n')
  else console.log(lines.join('\n'))
}
