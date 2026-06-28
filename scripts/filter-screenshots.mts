/**
 * Reference-screenshot variance filter — drop sub-threshold render noise.
 *
 * Reference PNGs are pixel-rendered on the CI runner (see check-screenshots.mts).
 * Even with a pinned viewport and fonts, a re-render of an *unchanged* screen can
 * differ from the committed PNG by a handful of pixels: sub-pixel font hinting and
 * anti-aliasing wobble on text edges. The `commit-screenshots` job used to commit
 * any PNG whose bytes changed (`git diff --name-only`), so this micro-noise churned
 * the reference shots on every run — a meaningless diff a human still has to review.
 *
 * This script runs in the working tree AFTER the e2e gate re-rendered the shots
 * (the rendered PNGs have overwritten the committed ones) and BEFORE the job stages
 * the diff. For each changed PNG it pixel-compares the re-render against the
 * committed baseline (`git show HEAD:<path>`) and decides:
 *
 *   keep    The change is clearly real (new/moved UI, different text, resized
 *           shot, or a brand-new screenshot) → leave the re-render in place so the
 *           job commits it.
 *   ignore  The change is below the noise threshold (only anti-aliased / a few
 *           stray pixels differ) → `git checkout HEAD -- <path>` to restore the
 *           committed PNG, so the job never commits it.
 *
 * Anti-aliased pixels are excluded by pixelmatch itself (its AA detector), which
 * already swallows most font-edge wobble; the threshold below is the small residual
 * margin on top. It is deliberately tiny — a real change moves thousands of pixels,
 * far above any hinting noise — so a genuine but small visual change still commits.
 *
 * Escape hatch: when UPDATE_SCREENSHOTS_LABEL=true (the PR carries the
 * `update-screenshots` label) filtering is disabled and every changed shot is kept,
 * so a maintainer who deliberately wants even the micro-diffs committed can force it.
 *
 * Tunables (env):
 *   SCREENSHOT_DIFF_COLOR_THRESHOLD  per-pixel color delta, 0..1 (pixelmatch
 *                                    `threshold`; default 0.1). Larger = less
 *                                    sensitive to per-pixel color shifts.
 *   SCREENSHOT_IGNORE_RATIO          ignore when differing-pixel fraction is <= this
 *                                    (default 0.0008 = 0.08%). For a 1280×800 shot
 *                                    that's ~820 px; AA exclusion keeps real noise
 *                                    far under that.
 *   SCREENSHOT_IGNORE_MIN_PIXELS     always ignore at/below this absolute count even
 *                                    on tiny shots (default 12).
 *
 * Outputs (CI): when GITHUB_OUTPUT is set, emits `ignored-count`, `kept-count`, and
 * `ignored-json` (a JSON array of { name, path, diffPixels, ratioPct }) so the
 * commit job can list the near-identical shots in its PR comment for a human to
 * eyeball and accept manually if they actually want them refreshed.
 *
 * Run: node scripts/filter-screenshots.mts [--dir tests/e2e/screenshots] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const ROOT = resolve(import.meta.dirname, '..')
const SCREENSHOT_DIR = argValue('--dir') ?? 'tests/e2e/screenshots'
const DRY_RUN = process.argv.includes('--dry-run')

const COLOR_THRESHOLD = numEnv('SCREENSHOT_DIFF_COLOR_THRESHOLD', 0.1)
const IGNORE_RATIO = numEnv('SCREENSHOT_IGNORE_RATIO', 0.0008)
const IGNORE_MIN_PIXELS = numEnv('SCREENSHOT_IGNORE_MIN_PIXELS', 12)

type Verdict =
  | { path: string; decision: 'keep'; reason: string; diffPixels?: number; ratio?: number }
  | { path: string; decision: 'ignore'; reason: string; diffPixels: number; ratio: number }

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** Run git, returning stdout; never throws (mirrors test-oracle.mts). */
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  } catch {
    return ''
  }
}

/** The committed (HEAD) bytes of a path, or null when it didn't exist there. */
function committedBytes(path: string): Buffer | null {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], {
      cwd: ROOT,
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch {
    return null
  }
}

/** Reference PNGs changed in the working tree (modified or newly added). */
function changedScreenshots(): string[] {
  const out = new Set<string>()
  for (const f of git(['diff', '--name-only', '--', SCREENSHOT_DIR]).split('\n')) {
    const t = f.trim()
    if (t) out.add(t)
  }
  for (const f of git(['ls-files', '--others', '--exclude-standard', '--', SCREENSHOT_DIR]).split(
    '\n',
  )) {
    const t = f.trim()
    if (t) out.add(t)
  }
  return [...out].filter((f) => f.toLowerCase().endsWith('.png'))
}

function classify(path: string): Verdict {
  const oldBytes = committedBytes(path)
  if (!oldBytes) return { path, decision: 'keep', reason: 'new screenshot (no baseline)' }

  let oldPng: PNG
  let newPng: PNG
  try {
    oldPng = PNG.sync.read(oldBytes)
    newPng = PNG.sync.read(readFileSync(resolve(ROOT, path)))
  } catch (err) {
    // Undecodable on either side → don't gamble, let it commit for human review.
    return { path, decision: 'keep', reason: `decode failed (${(err as Error).message})` }
  }

  if (oldPng.width !== newPng.width || oldPng.height !== newPng.height) {
    return { path, decision: 'keep', reason: 'dimensions changed' }
  }

  const { width, height } = oldPng
  const total = width * height
  const diffPixels = pixelmatch(oldPng.data, newPng.data, undefined, width, height, {
    threshold: COLOR_THRESHOLD,
  })
  const ratio = total > 0 ? diffPixels / total : 0
  const ignore = diffPixels <= IGNORE_MIN_PIXELS || ratio <= IGNORE_RATIO
  return ignore
    ? { path, decision: 'ignore', reason: 'below noise threshold', diffPixels, ratio }
    : { path, decision: 'keep', reason: 'real visual change', diffPixels, ratio }
}

function emitOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  if (value.includes('\n')) {
    appendFileSync(file, `${name}<<__EOF__\n${value}\n__EOF__\n`)
  } else {
    appendFileSync(file, `${name}=${value}\n`)
  }
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(4)}%`
}

function main(): void {
  const changed = changedScreenshots()
  if (changed.length === 0) {
    console.log('screenshot filter: no changed reference screenshots')
    emitOutput('ignored-count', '0')
    emitOutput('kept-count', '0')
    emitOutput('ignored-json', '[]')
    return
  }

  // Escape hatch: the `update-screenshots` label means "refresh everything",
  // so keep all changed shots — including sub-threshold micro-diffs.
  if (process.env.UPDATE_SCREENSHOTS_LABEL === 'true') {
    console.log(
      `screenshot filter: update-screenshots label present — keeping all ${changed.length} changed shot(s) unfiltered`,
    )
    emitOutput('ignored-count', '0')
    emitOutput('kept-count', String(changed.length))
    emitOutput('ignored-json', '[]')
    return
  }

  const verdicts = changed.map(classify)
  const ignored = verdicts.filter((v) => v.decision === 'ignore')
  const kept = verdicts.filter((v) => v.decision === 'keep')

  console.log(
    `screenshot filter: ${changed.length} changed, ${kept.length} kept (real), ` +
      `${ignored.length} ignored (noise) ` +
      `[color-threshold=${COLOR_THRESHOLD}, ignore-ratio=${IGNORE_RATIO}, min-pixels=${IGNORE_MIN_PIXELS}]`,
  )

  for (const v of kept) {
    const detail =
      v.diffPixels !== undefined ? ` (${v.diffPixels} px, ${pct(v.ratio ?? 0)})` : ` (${v.reason})`
    console.log(`  keep   ${v.path}${detail}`)
  }

  // Revert the noise shots so the commit job never stages them.
  for (const v of ignored) {
    console.log(`  ignore ${v.path} (${v.diffPixels} px, ${pct(v.ratio)})`)
    if (!DRY_RUN) git(['checkout', 'HEAD', '--', v.path])
  }

  emitOutput('ignored-count', String(ignored.length))
  emitOutput('kept-count', String(kept.length))
  emitOutput(
    'ignored-json',
    JSON.stringify(
      ignored.map((v) => ({
        name: v.path.split('/').pop(),
        path: v.path,
        diffPixels: v.diffPixels,
        ratioPct: pct(v.ratio),
      })),
    ),
  )
}

main()
