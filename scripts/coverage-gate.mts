// Coverage ratchet: fail CI when a PR lowers line coverage below the committed
// baseline, and make it easy to raise the bar when coverage improves.
//
// Why line coverage only: unit tests are bundled by esbuild into dist-test/*.js
// before `node --test` runs them, so V8 coverage is recorded against the bundle
// and remapped back to src via source maps (see .c8rc.json `exclude-after-remap`).
// That remap is accurate per-file for lines/statements, but c8's *aggregate*
// branch/function rollup is unreliable for bundled inputs, so we gate on the
// line total — the trustworthy, stable number. Per-file branch data still lives
// in the HTML/lcov report for humans.
//
//   npm run coverage          # run tests under c8, write coverage/ reports
//   npm run coverage:check    # compare against baseline, fail on regression
//   npm run coverage:update   # raise the baseline to the current coverage
//
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const SUMMARY = resolve('coverage/coverage-summary.json')
const BASELINE = resolve('coverage-baseline.json')
// Tolerance absorbs sub-0.01% float jitter so an unrelated PR is never failed
// by rounding noise. A real regression is far larger than this.
const TOLERANCE = 0.01

const update = process.argv.includes('--update')

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    console.error(`coverage-gate: could not read ${path}: ${(err as Error).message}`)
    process.exit(1)
  }
}

const summary = await readJson(SUMMARY)
const total = (summary['total'] as { lines?: { pct?: number } } | undefined)?.lines
if (typeof total?.pct !== 'number') {
  console.error(
    `coverage-gate: ${SUMMARY} has no total.lines.pct — run \`npm run coverage\` first.`,
  )
  process.exit(1)
}
const current = total.pct

if (update) {
  await writeFile(BASELINE, JSON.stringify({ lines: current }, null, 2) + '\n')
  console.log(`coverage-gate: baseline updated to ${String(current)}% lines.`)
  process.exit(0)
}

const baseline = await readJson(BASELINE)
const required = typeof baseline['lines'] === 'number' ? baseline['lines'] : 0
const delta = current - required

const summaryLine =
  `Line coverage: ${String(current)}% (baseline ${String(required)}%, ` +
  `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%)`
console.log(summaryLine)

// Surface the result on the GitHub Actions run summary when available.
const stepSummary = process.env['GITHUB_STEP_SUMMARY']
if (stepSummary) {
  await writeFile(stepSummary, `### Coverage\n\n${summaryLine}\n`, { flag: 'a' })
}

if (current + TOLERANCE < required) {
  console.error(
    `coverage-gate: line coverage regressed to ${String(current)}% (below baseline ${String(required)}%).\n` +
      `Add tests to restore coverage, or — if this drop is intentional — lower the\n` +
      `baseline in coverage-baseline.json.`,
  )
  process.exit(1)
}

if (delta > TOLERANCE) {
  console.log(
    `coverage-gate: coverage improved by ${delta.toFixed(2)}%. ` +
      `Run \`npm run coverage:update\` and commit coverage-baseline.json to ratchet the bar up.`,
  )
}
