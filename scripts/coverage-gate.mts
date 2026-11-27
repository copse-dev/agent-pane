// Coverage ratchet: fail CI when a PR lowers line coverage below the committed
// baseline, or raises it so far above the baseline that the bar stops binding.
//
// Why line coverage only: unit tests are emitted as split ESM entries under
// dist-test/ before `node --test` runs them, so V8 coverage is recorded against
// the entry/shared-chunk graph and remapped to src via source maps (see .c8rc.json
// `exclude-after-remap`).
// That remap is accurate per-file for lines/statements, but c8's *aggregate*
// branch/function rollup is unreliable for bundled inputs, so we gate on the
// line total — the trustworthy, stable number. Per-file branch data still lives
// in the HTML/lcov report for humans.
//
//   npm run coverage          # run tests under c8, write coverage/ reports
//   npm run coverage:check    # compare against baseline, fail on regression
//   npm run coverage:update   # set the baseline just under the current coverage
//
// Per-area floors (#4391): `coverage-baseline.json` may also hold `areas`, a
// floor per area (`scripts/lib/coverage-areas.mts`), so a drop in one layer
// cannot hide behind a rise elsewhere. Every run prints the areas with the most
// uncovered lines; `--update` resets the floors with the global baseline.
//
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expectRecord } from '../src/shared/unknown-value.mts'
import {
  areaFloorFailures,
  baselineFloors,
  formatAreaTable,
  summariseAreas,
  updatedFloors,
} from './lib/coverage-areas.mts'

const SUMMARY = resolve('coverage/coverage-summary.json')
const BASELINE = resolve('coverage-baseline.json')
// Tolerance absorbs sub-0.01% float jitter so an unrelated PR is never failed
// by rounding noise. A real regression is far larger than this.
const TOLERANCE = 0.01
// Most slack the baseline may carry below measured coverage. Without a cap the
// bar drifted to 19 points under the measured figure, so a PR could delete
// tests covering tens of thousands of lines and still pass (#4391). Identical
// commits measure identically on CI, and a week of main moved 0.14 points, so
// one point leaves room for unrelated PRs while keeping the gate meaningful.
const MAX_SLACK = 1
// `--update` sets the bar this far under the measured figure, so the PR after a
// bump is not failed by a few lines of unrelated churn.
const UPDATE_MARGIN = 0.25
const AREA_UPDATE_MARGIN = 0.5
// The slack cap fails only pull requests (and local runs). Two PRs that each
// pass inside the slack can together push main past it; failing main's own
// push run, the nightly or every later PR's merge result then would turn the
// whole repository red until someone bumps the baseline. Elsewhere it warns.
const eventName = process.env['GITHUB_EVENT_NAME']
const enforceSlack = eventName === undefined || eventName === '' || eventName === 'pull_request'

const update = process.argv.includes('--update')

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return expectRecord(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (err) {
    console.error(
      `coverage-gate: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }
}

const summary = await readJson(SUMMARY)
const total = expectRecord(summary['total'], 'coverage total')
const lines = expectRecord(total['lines'], 'coverage total.lines')
if (typeof lines['pct'] !== 'number') {
  console.error(
    `coverage-gate: ${SUMMARY} has no total.lines.pct — run \`npm run coverage\` first.`,
  )
  process.exit(1)
}
const current = lines['pct']
const areas = summariseAreas(summary, process.cwd())

if (update) {
  const next = Math.floor((current - UPDATE_MARGIN) * 100) / 100
  // Area figures move more than the total when one file changes, so their
  // floors keep a wider margin.
  const previous = existsSync(BASELINE) ? baselineFloors(await readJson(BASELINE)) : {}
  const floors = updatedFloors(areas, AREA_UPDATE_MARGIN, previous)
  const written = Object.keys(floors).length > 0 ? { lines: next, areas: floors } : { lines: next }
  await writeFile(BASELINE, JSON.stringify(written, null, 2) + '\n')
  console.log(
    `coverage-gate: baseline updated to ${String(next)}% lines (measured ${String(current)}%), ` +
      `with floors for ${String(Object.keys(floors).length)} areas.`,
  )
  process.exit(0)
}

const baseline = await readJson(BASELINE)
const required = typeof baseline['lines'] === 'number' ? baseline['lines'] : 0
const floors = baselineFloors(baseline)
const delta = current - required

const summaryLine =
  `Line coverage: ${String(current)}% (baseline ${String(required)}%, ` +
  `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%)`
console.log(summaryLine)

// Surface the result on the GitHub Actions run summary when available.
const stepSummary = process.env['GITHUB_STEP_SUMMARY']
const areaTable = formatAreaTable(areas, floors)
console.log(`Areas with the most uncovered lines:\n${areaTable}`)
if (stepSummary) {
  await writeFile(
    stepSummary,
    `### Coverage\n\n${summaryLine}\n\n#### Areas with the most uncovered lines\n\n${areaTable}\n`,
    { flag: 'a' },
  )
}

const areaFailures = areaFloorFailures(areas, floors, TOLERANCE)
if (areaFailures.length > 0) {
  console.error(
    `coverage-gate: line coverage fell below an area floor:\n` +
      areaFailures.map((failure) => `  ${failure}`).join('\n') +
      `\nAdd tests to restore it, or, if the drop is intentional, lower that floor\n` +
      `under \`areas\` in coverage-baseline.json.`,
  )
  process.exit(1)
}

if (current + TOLERANCE < required) {
  console.error(
    `coverage-gate: line coverage regressed to ${String(current)}% (below baseline ${String(required)}%).\n` +
      `Add tests to restore coverage, or — if this drop is intentional — lower the\n` +
      `baseline in coverage-baseline.json.`,
  )
  process.exit(1)
}

if (delta > MAX_SLACK + TOLERANCE) {
  const gap =
    `coverage-gate: line coverage is ${delta.toFixed(2)}% above the baseline, more than the\n` +
    `${String(MAX_SLACK)}% slack the ratchet allows.`
  if (!enforceSlack) {
    console.warn(
      `${gap} Not failing a ${eventName} run for it:\n` +
        `the next PR that runs \`npm run coverage:update\` raises the baseline.`,
    )
    if (stepSummary) {
      await writeFile(stepSummary, `\n> [!WARNING]\n> ${gap.replace(/\n/g, ' ')}\n`, { flag: 'a' })
    }
  } else {
    console.error(
      `${gap} Run \`npm run coverage:update\` and commit\n` +
        `coverage-baseline.json in this PR so a later regression cannot hide in the gap.`,
    )
    process.exit(1)
  }
}
