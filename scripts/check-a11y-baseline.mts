/**
 * The accessibility baseline (tests/e2e/accessibility-baseline.json) may only
 * shrink: fail when it tolerates a violation the base ref did not.
 *
 * Run: node scripts/check-a11y-baseline.mts [--base <ref>]
 *
 * With `--base` (CI passes the PR/queue base) an unreadable ref fails. Without
 * it, the merge-base with origin/main is used and a missing remote ref is a
 * warning, because the e2e lane still pins the file to observed reality.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  A11Y_BASELINE_PATH,
  a11yBaselineSchema,
  baselineGrowth,
  type A11yBaseline,
} from './lib/a11y-baseline.mts'
import { decodeWithSchema, safeJsonParse } from './lib/safe-json.mts'

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function parse(text: string, source: string): A11yBaseline {
  const baseline = safeJsonParse(text, decodeWithSchema(a11yBaselineSchema))
  if (!baseline) throw new Error(`check-a11y-baseline: ${source} is not a valid baseline`)
  return baseline
}

const argv = process.argv.slice(2)
const baseIndex = argv.indexOf('--base')
const explicitBase = baseIndex >= 0 ? argv[baseIndex + 1] : undefined
if (baseIndex >= 0 && !explicitBase) throw new Error('check-a11y-baseline: --base needs a ref')

const head = parse(readFileSync(A11Y_BASELINE_PATH, 'utf8'), A11Y_BASELINE_PATH)
const base = explicitBase ?? git(['merge-base', 'HEAD', 'origin/main'])?.trim()
if (!base) {
  console.warn('check-a11y-baseline: no merge-base with origin/main; skipping the shrink check')
  process.exit(0)
}
if (git(['cat-file', '-e', `${base}^{commit}`]) === null) {
  console.error(`check-a11y-baseline: cannot read base ${base}; fetch it or pass --base <ref>`)
  process.exit(1)
}

const baseText = git(['show', `${base}:${A11Y_BASELINE_PATH}`])
if (baseText === null) {
  // The PR that introduces the lane seeds the file; there is nothing to shrink from.
  console.log(`check-a11y-baseline: ${A11Y_BASELINE_PATH} is new relative to ${base}`)
  process.exit(0)
}

const growth = baselineGrowth(parse(baseText, `${base}:${A11Y_BASELINE_PATH}`), head)
for (const problem of growth) console.error(`check-a11y-baseline: ${problem}`)
if (growth.length > 0) {
  console.error(
    'check-a11y-baseline: the baseline only shrinks. Fix the violation instead (docs/accessibility.md).',
  )
  process.exit(1)
}
console.log(`check-a11y-baseline: no growth relative to ${base}`)
