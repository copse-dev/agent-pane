/**
 * Static flake-risk ratchet (docs/testing-strategy.md#flake-risk-ratchet).
 *
 * Scans unit tests and e2e specs/helpers for fixed waits, shared-checkout
 * seeding and fixed ports, and compares the per-file counts with
 * scripts/flake-risk-baseline.json. A count above the baseline (a new file
 * allows zero) fails with file, line and the preferred alternative. A count
 * below it fails until the baseline is lowered in the same change; `--write`
 * lowers it and refuses to raise it. The committed baseline itself may not
 * grow relative to the base ref (renames carry their counts).
 *
 * Run: node scripts/check-flake-risks.mts [--base <ref>] [--write]
 *
 * With `--base` (CI passes the PR/queue base) an unreadable ref fails. Without
 * it, the merge-base with origin/main is used and a missing remote ref skips
 * only the base comparison, with a warning.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  FLAKE_RISK_BASELINE_PATH,
  FLAKE_RULE_ADVICE,
  baselineFromFindings,
  compareWithBaseline,
  flakeBaselineGrowth,
  flakeRiskBaselineSchema,
  formatFlakeRiskBaseline,
  isE2ePath,
  isUnitTestPath,
  scanFlakeRisks,
  type FlakeRiskBaseline,
} from './lib/flake-risks.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

function parse(text: string, source: string): FlakeRiskBaseline {
  const baseline = safeJsonParse(text, decodeWithSchema(flakeRiskBaselineSchema))
  if (!baseline) throw new Error(`check-flake-risks: ${source} is not a valid baseline`)
  return baseline
}

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const baseIndex = argv.indexOf('--base')
const explicitBase = baseIndex >= 0 ? argv[baseIndex + 1] : undefined
if (baseIndex >= 0 && !explicitBase) throw new Error('check-flake-risks: --base needs a ref')

// Tracked plus untracked-but-not-ignored files, so a new spec is scanned before it is committed.
const listing = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
if (listing === null) throw new Error('check-flake-risks: git ls-files failed')
const paths = [...new Set(listing.split('\0'))]
  .filter((path) => (isUnitTestPath(path) || isE2ePath(path)) && existsSync(path))
  .sort()
const findings = paths.flatMap((path) => scanFlakeRisks(path, readFileSync(path, 'utf8')))

let failed = false
const head = parse(readFileSync(FLAKE_RISK_BASELINE_PATH, 'utf8'), FLAKE_RISK_BASELINE_PATH)
const { added, stale } = compareWithBaseline(head, findings)

for (const change of added) {
  failed = true
  console.error(
    `check-flake-risks: ${change.rule}: ${change.file} has ${String(change.observed)}, baseline allows ${String(change.allowed)}`,
  )
  for (const finding of findings) {
    if (finding.rule === change.rule && finding.file === change.file)
      console.error(`  ${finding.file}:${String(finding.line)}  ${finding.text}`)
  }
  console.error(`  prefer: ${FLAKE_RULE_ADVICE[change.rule]}`)
}

if (write) {
  if (added.length > 0) {
    console.error('check-flake-risks: --write only lowers the baseline; fix the new findings first')
  } else if (stale.length > 0) {
    writeFileSync(FLAKE_RISK_BASELINE_PATH, formatFlakeRiskBaseline(baselineFromFindings(findings)))
    console.log(`check-flake-risks: lowered ${String(stale.length)} baseline entries`)
  }
} else {
  for (const change of stale) {
    failed = true
    console.error(
      `check-flake-risks: ${change.rule}: ${change.file} dropped from ${String(change.allowed)} to ${String(change.observed)}; lower the baseline (pnpm run check:flake-risks -- --write)`,
    )
  }
}

function baseRef(): string | null {
  const base = explicitBase ?? git(['merge-base', 'HEAD', 'origin/main'])?.trim()
  if (!base) {
    console.warn('check-flake-risks: no merge-base with origin/main; skipping the base comparison')
    return null
  }
  if (git(['cat-file', '-e', `${base}^{commit}`]) === null) {
    console.error(`check-flake-risks: cannot read base ${base}; fetch it or pass --base <ref>`)
    process.exit(1)
  }
  return base
}

const base = baseRef()
if (base) {
  const baseText = git(['show', `${base}:${FLAKE_RISK_BASELINE_PATH}`])
  if (baseText === null) {
    console.log(`check-flake-risks: ${FLAKE_RISK_BASELINE_PATH} is new relative to ${base}`)
  } else {
    const current = parse(readFileSync(FLAKE_RISK_BASELINE_PATH, 'utf8'), FLAKE_RISK_BASELINE_PATH)
    const renames = new Map<string, string>()
    // Includes uncommitted edits: the working tree is what this run scanned.
    const diff = git(['diff', '-z', '--name-status', '--find-renames', base]) ?? ''
    const fields = diff.split('\0')
    for (let index = 0; index < fields.length; index++) {
      const status = fields[index] ?? ''
      if (status.startsWith('R')) {
        const from = fields[index + 1]
        const to = fields[index + 2]
        if (from && to) renames.set(to, from)
        index += 2
      } else if (status) {
        index += 1
      }
    }
    const growth = flakeBaselineGrowth(
      parse(baseText, `${base}:${FLAKE_RISK_BASELINE_PATH}`),
      current,
      renames,
    )
    for (const problem of growth) {
      failed = true
      console.error(`check-flake-risks: baseline grew: ${problem}`)
    }
  }
}

if (failed) {
  console.error(
    'check-flake-risks: the baseline only shrinks: fix a new risk rather than recording it, and lower the baseline when a count drops (docs/testing-strategy.md#flake-risk-ratchet).',
  )
  process.exit(1)
}
console.log(
  `check-flake-risks: ${String(findings.length)} known findings in ${String(paths.length)} scanned files; none new`,
)
