/**
 * Reference-screenshot variance filter — drop sub-threshold render noise and
 * break the render-flap ping-pong (#609).
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
 *   flap    The change is above the noise threshold vs HEAD, but it matches a
 *           RECENT COMMITTED render of the same shot (a prior bot refresh on this
 *           PR). That means the runner fleet is alternating between two render
 *           states for this shot: committing again just re-triggers CI and the
 *           other state comes back next run — an unbounded ping-pong (#609). We
 *           restore HEAD (do not commit) and surface the shot for human review.
 *
 * Anti-aliased pixels are excluded by pixelmatch itself (its AA detector), which
 * already swallows most font-edge wobble; the threshold below is the small residual
 * margin on top. It is deliberately tiny — a real change moves thousands of pixels,
 * far above any hinting noise — so a genuine but small visual change still commits.
 *
 * Flap detection bounds the loop: a shot that oscillates between two states A and B
 * commits at most once per distinct state (A, then B), and every subsequent render
 * matches one of those committed states, so it is held instead of re-committed. The
 * head therefore stops moving and `CI Passed` can settle.
 *
 * Escape hatch: when UPDATE_SCREENSHOTS_LABEL=true (the PR carries the
 * `update-screenshots` label) all filtering is disabled — noise AND flap — and
 * every changed shot is kept, so a maintainer who deliberately wants even the
 * micro-diffs / a specific flapping state committed can force it.
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
 *   SCREENSHOT_FLAP_LOOKBACK         number of recent DISTINCT committed renders of
 *                                    each shot to compare a real change against for
 *                                    flap detection (default 4). 0 disables it.
 *
 * Outputs (CI): when GITHUB_OUTPUT is set, emits `ignored-count`, `kept-count`,
 * `flapping-count`, `ignored-json`, and `flapping-json` (JSON arrays of
 * { name, path, diffPixels, ratioPct }) so the commit job can list the near-
 * identical and the flapping shots in its PR comment for a human to eyeball.
 *
 * Run: node scripts/filter-screenshots.mts [--dir tests/e2e/screenshots] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

// Repo root. Uses import.meta so it works when run directly; falls back to cwd
// when a bundler (the unit-test build) leaves import.meta empty — the pure
// classifier under test never touches ROOT, so the fallback is harmless there.
function repoRoot(): string {
  try {
    return resolve(fileURLToPath(import.meta.url), '..', '..')
  } catch {
    return process.cwd()
  }
}
const ROOT = repoRoot()
const SCREENSHOT_DIR = argValue('--dir') ?? 'tests/e2e/screenshots'
const DRY_RUN = process.argv.includes('--dry-run')

const COLOR_THRESHOLD = numEnv('SCREENSHOT_DIFF_COLOR_THRESHOLD', 0.1)
const IGNORE_RATIO = numEnv('SCREENSHOT_IGNORE_RATIO', 0.0008)
const IGNORE_MIN_PIXELS = numEnv('SCREENSHOT_IGNORE_MIN_PIXELS', 12)
const FLAP_LOOKBACK = numEnv('SCREENSHOT_FLAP_LOOKBACK', 4)

export interface ClassifyOptions {
  colorThreshold: number
  ignoreRatio: number
  ignoreMinPixels: number
}

export type Verdict =
  | { decision: 'keep'; reason: string; diffPixels?: number; ratio?: number }
  | { decision: 'ignore'; reason: string; diffPixels: number; ratio: number }
  | { decision: 'flap'; reason: string; diffPixels: number; ratio: number; matchedPixels: number }

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

/**
 * The last `lookback` DISTINCT committed renders of `path`, most-recent-first,
 * excluding the current HEAD baseline (`headBytes`). These are the states a real
 * change is checked against for flap detection — if the new render matches one of
 * them, the shot is oscillating between already-committed states.
 */
function priorCommittedRenders(path: string, headBytes: Buffer | null, lookback: number): Buffer[] {
  if (lookback <= 0) return []
  const shas = git(['log', '-n', String(lookback + 4), '--format=%H', '--', path])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const out: Buffer[] = []
  const seen = new Set<string>()
  if (headBytes) seen.add(createHash('sha1').update(headBytes).digest('hex'))
  for (const sha of shas) {
    if (out.length >= lookback) break
    let bytes: Buffer
    try {
      bytes = execFileSync('git', ['show', `${sha}:${path}`], {
        cwd: ROOT,
        maxBuffer: 256 * 1024 * 1024,
      })
    } catch {
      continue
    }
    const key = createHash('sha1').update(bytes).digest('hex')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(bytes)
  }
  return out
}

function decode(bytes: Buffer): PNG | null {
  try {
    return PNG.sync.read(bytes)
  } catch {
    return null
  }
}

/** Differing pixels between two PNGs, or null when their dimensions differ. */
function diffPixels(
  a: PNG,
  b: PNG,
  colorThreshold: number,
): { diffPixels: number; ratio: number } | null {
  if (a.width !== b.width || a.height !== b.height) return null
  const total = a.width * a.height
  const count = pixelmatch(a.data, b.data, undefined, a.width, a.height, {
    threshold: colorThreshold,
  })
  return { diffPixels: count, ratio: total > 0 ? count / total : 0 }
}

function isNoise(diff: { diffPixels: number; ratio: number }, opts: ClassifyOptions): boolean {
  return diff.diffPixels <= opts.ignoreMinPixels || diff.ratio <= opts.ignoreRatio
}

/**
 * Pure classification of one re-rendered shot. `priorRenders` are recent committed
 * renders of the same shot (see priorCommittedRenders); pass [] to disable flap
 * detection. Kept pure (bytes in, verdict out) so it is unit-testable without git.
 */
export function classifyScreenshotChange(
  oldBytes: Buffer | null,
  newBytes: Buffer,
  priorRenders: Buffer[],
  opts: ClassifyOptions,
): Verdict {
  if (!oldBytes) return { decision: 'keep', reason: 'new screenshot (no baseline)' }

  const oldPng = decode(oldBytes)
  const newPng = decode(newBytes)
  if (!oldPng || !newPng) {
    // Undecodable on either side → don't gamble, let it commit for human review.
    return { decision: 'keep', reason: 'decode failed' }
  }
  if (oldPng.width !== newPng.width || oldPng.height !== newPng.height) {
    return { decision: 'keep', reason: 'dimensions changed' }
  }

  const vsHead = diffPixels(oldPng, newPng, opts.colorThreshold)
  // Dimensions are equal here, so diffPixels never returns null.
  if (!vsHead) return { decision: 'keep', reason: 'dimensions changed' }
  if (isNoise(vsHead, opts)) {
    return { decision: 'ignore', reason: 'below noise threshold', ...vsHead }
  }

  // A real change versus HEAD. If it matches a recent committed render of this
  // same shot, the shot is flapping between already-committed states (#609):
  // committing again would just re-trigger CI and bring the other state back.
  for (const prior of priorRenders) {
    const priorPng = decode(prior)
    if (!priorPng) continue
    const vsPrior = diffPixels(priorPng, newPng, opts.colorThreshold)
    if (!vsPrior) continue
    if (isNoise(vsPrior, opts)) {
      return {
        decision: 'flap',
        reason: 'matches a recent committed render',
        diffPixels: vsHead.diffPixels,
        ratio: vsHead.ratio,
        matchedPixels: vsPrior.diffPixels,
      }
    }
  }

  return { decision: 'keep', reason: 'real visual change', ...vsHead }
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

type PathVerdict = Verdict & { path: string }

function classify(path: string): PathVerdict {
  const oldBytes = committedBytes(path)
  let newBytes: Buffer
  try {
    newBytes = readFileSync(resolve(ROOT, path))
  } catch {
    // Vanished from the working tree — nothing to stage; treat as keep-noop so the
    // commit job's own diff simply finds nothing for it.
    return { path, decision: 'keep', reason: 'unreadable in working tree' }
  }
  const priorRenders = priorCommittedRenders(path, oldBytes, FLAP_LOOKBACK)
  const verdict = classifyScreenshotChange(oldBytes, newBytes, priorRenders, {
    colorThreshold: COLOR_THRESHOLD,
    ignoreRatio: IGNORE_RATIO,
    ignoreMinPixels: IGNORE_MIN_PIXELS,
  })
  return { path, ...verdict }
}

function emitOutput(name: string, value: string): void {
  const file = process.env['GITHUB_OUTPUT']
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

function reportJson(items: Array<Extract<PathVerdict, { diffPixels: number }>>): string {
  return JSON.stringify(
    items.map((v) => ({
      name: v.path.split('/').pop(),
      path: v.path,
      diffPixels: v.diffPixels,
      ratioPct: pct(v.ratio),
    })),
  )
}

export function main(): void {
  const changed = changedScreenshots()
  if (changed.length === 0) {
    console.log('screenshot filter: no changed reference screenshots')
    emitOutput('ignored-count', '0')
    emitOutput('kept-count', '0')
    emitOutput('flapping-count', '0')
    emitOutput('ignored-json', '[]')
    emitOutput('flapping-json', '[]')
    return
  }

  // Escape hatch: the `update-screenshots` label means "refresh everything", so
  // keep all changed shots — including sub-threshold micro-diffs and shots that
  // would otherwise be held as flapping.
  if (process.env['UPDATE_SCREENSHOTS_LABEL'] === 'true') {
    console.log(
      `screenshot filter: update-screenshots label present — keeping all ${String(changed.length)} changed shot(s) unfiltered`,
    )
    emitOutput('ignored-count', '0')
    emitOutput('kept-count', String(changed.length))
    emitOutput('flapping-count', '0')
    emitOutput('ignored-json', '[]')
    emitOutput('flapping-json', '[]')
    return
  }

  const verdicts = changed.map(classify)
  const kept = verdicts.filter((v) => v.decision === 'keep')
  const ignored = verdicts.filter(
    (v): v is Extract<PathVerdict, { decision: 'ignore' }> => v.decision === 'ignore',
  )
  const flapping = verdicts.filter(
    (v): v is Extract<PathVerdict, { decision: 'flap' }> => v.decision === 'flap',
  )

  console.log(
    `screenshot filter: ${String(changed.length)} changed, ${String(kept.length)} kept (real), ` +
      `${String(ignored.length)} ignored (noise), ${String(flapping.length)} held (flapping) ` +
      `[color-threshold=${String(COLOR_THRESHOLD)}, ignore-ratio=${String(IGNORE_RATIO)}, ` +
      `min-pixels=${String(IGNORE_MIN_PIXELS)}, flap-lookback=${String(FLAP_LOOKBACK)}]`,
  )

  for (const v of kept) {
    const detail =
      v.diffPixels !== undefined
        ? ` (${String(v.diffPixels)} px, ${pct(v.ratio ?? 0)})`
        : ` (${v.reason})`
    console.log(`  keep   ${v.path}${detail}`)
  }

  // Revert the noise shots so the commit job never stages them.
  for (const v of ignored) {
    console.log(`  ignore ${v.path} (${String(v.diffPixels)} px, ${pct(v.ratio)})`)
    if (!DRY_RUN) git(['checkout', 'HEAD', '--', v.path])
  }

  // Revert the flapping shots too — committing them again would re-trigger CI and
  // bring the other render state back (the #609 ping-pong). Surface for a human.
  for (const v of flapping) {
    console.log(
      `  flap   ${v.path} (${String(v.diffPixels)} px vs HEAD, matches a prior render within ${String(v.matchedPixels)} px)`,
    )
    if (!DRY_RUN) git(['checkout', 'HEAD', '--', v.path])
  }

  emitOutput('ignored-count', String(ignored.length))
  emitOutput('kept-count', String(kept.length))
  emitOutput('flapping-count', String(flapping.length))
  emitOutput('ignored-json', reportJson(ignored))
  emitOutput('flapping-json', reportJson(flapping))
}

// Run only when invoked directly (`node scripts/filter-screenshots.mts`), not when
// imported by the unit test.
function invokedDirectly(): boolean {
  try {
    return (
      process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    )
  } catch {
    return false
  }
}
if (invokedDirectly()) main()
