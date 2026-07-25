/**
 * Screenshot ownership — which reference shots a diff is allowed to rewrite.
 *
 * The e2e gate re-renders every shot its selected specs produce, and a *broad*
 * selection (a lockfile bump, an e2e helper change, a low-confidence map) selects
 * everything. `commit-screenshots` then committed whatever differed on disk, so a
 * PR that cannot have moved a pixel still rewrote reference PNGs it never touched:
 * a release-smoke fix landed 17 refreshed shots, a Terminal-Bench benchmark PR
 * refreshed Settings → Sources. Worse, the reconcile step resolves screenshot
 * conflicts with `--ours`, so those unrelated renders also *win* against main —
 * a stale branch reverts main's newer shot, the next PR flips it back, and the
 * shot oscillates between render states across PRs (`portrait-panel-controls-
 * with-panel.png` alternated ~100 KB / ~140 KB over eight consecutive commits).
 *
 * `computeScreenshotGate` in test-oracle.mts already knows the answer — it maps a
 * diff to the shots its specs legitimately (re)render, and deliberately ignores
 * root infra that "cannot change a pixel" — but only `check-screenshots.mts
 * --plan` consumed it, as an advisory annotation. This module makes that set
 * authoritative for *writes*: a shot outside it is held, not committed, and loses
 * a merge conflict against main instead of winning it.
 *
 * A shot is OWNED by the branch when either:
 *   • the oracle maps this diff to a spec that renders it (`affected`), or
 *   • a non-bot author committed it on this branch since the merge-base
 *     (`branchOwned`) — a hand-committed reference shot is deliberate work,
 *     whatever the oracle thinks.
 *
 * Scope is DISABLED (everything owned, i.e. the pre-existing behaviour) when the
 * base ref is unavailable — a local run or a shallow clone — so a missing
 * `origin/main` degrades to the old policy rather than holding every shot.
 *
 * Escape hatch: the `update-screenshots` label bypasses filtering entirely
 * (filter-screenshots.mts returns before consulting scope), which is the explicit
 * "regenerate and take CI's render" override for the case where the oracle could
 * not map a render-affecting file to its shots.
 */
import { execFileSync } from 'node:child_process'
import { computeScreenshotGate, changedFiles } from '../test-oracle.mts'

export const SCREENSHOT_DIR = 'tests/e2e/screenshots'

/** Commits authored by this identity are CI's own refreshes, never deliberate. */
const BOT_AUTHOR = 'github-actions[bot]'

export interface ScreenshotScope {
  /** False when the base ref is missing — callers must not filter on scope. */
  enabled: boolean
  /** Basenames the diff's selected specs legitimately (re)render. */
  affected: Set<string>
  /** Basenames a non-bot author committed on this branch since the merge-base. */
  branchOwned: Set<string>
}

/** Scope that owns everything — the behaviour before this module existed. */
export function unscoped(): ScreenshotScope {
  return { enabled: false, affected: new Set(), branchOwned: new Set() }
}

/** Run git, returning stdout; never throws (mirrors test-oracle.mts). */
function git(args: string[], cwd = process.cwd()): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  } catch {
    return ''
  }
}

/** `tests/e2e/screenshots/foo.png` → `foo.png`; a bare basename passes through. */
export function screenshotName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

/**
 * Whether the branch may rewrite `path` — pure, so the ownership rule is
 * testable without git. A disabled scope owns everything.
 */
export function ownsScreenshot(scope: ScreenshotScope, path: string): boolean {
  if (!scope.enabled) return true
  const name = screenshotName(path)
  return scope.affected.has(name) || scope.branchOwned.has(name)
}

/**
 * Reference shots a non-bot author committed on this branch since `mergeBase`.
 * Two git calls per branch commit rather than one parse of interleaved
 * `--format`/`--name-only` output: the commit count on a branch is small and the
 * separate walks are unambiguous.
 */
function branchOwnedScreenshots(mergeBase: string, cwd: string): Set<string> {
  const out = new Set<string>()
  const lines = git(
    ['log', '--format=%H %an', `${mergeBase}..HEAD`, '--', SCREENSHOT_DIR],
    cwd,
  ).split('\n')
  for (const line of lines) {
    const sep = line.indexOf(' ')
    if (sep <= 0) continue
    const sha = line.slice(0, sep)
    const author = line.slice(sep + 1).trim()
    if (author === BOT_AUTHOR) continue
    for (const f of git(['show', '--format=', '--name-only', sha, '--', SCREENSHOT_DIR], cwd).split(
      '\n',
    )) {
      const t = f.trim()
      if (t.toLowerCase().endsWith('.png')) out.add(screenshotName(t))
    }
  }
  return out
}

/**
 * The branch's screenshot scope versus `base` (default `origin/main`). Returns a
 * disabled scope when the merge-base can't be resolved.
 */
export function computeScreenshotScope(base = 'origin/main', cwd = process.cwd()): ScreenshotScope {
  const mergeBase = git(['merge-base', 'HEAD', base], cwd).trim()
  if (!mergeBase) return unscoped()
  // `labeled: false` — the label is handled by the caller (it bypasses filtering
  // wholesale), and passing it here would only change `gate.ok`, which we ignore.
  const gate = computeScreenshotGate(changedFiles(base), false)
  return {
    enabled: true,
    affected: new Set(gate.affected.map(screenshotName)),
    branchOwned: branchOwnedScreenshots(mergeBase, cwd),
  }
}

/**
 * Repo-relative paths the branch owns, for the reconcile steps' per-file
 * `--ours` / `--theirs` decision. Null when scope is unavailable, meaning the
 * caller should keep every shot with a blanket `--ours`.
 */
export function ownedScreenshotPaths(base = 'origin/main', cwd = process.cwd()): string[] | null {
  const scope = computeScreenshotScope(base, cwd)
  if (!scope.enabled) return null
  return [...new Set([...scope.affected, ...scope.branchOwned])]
    .sort()
    .map((name) => `${SCREENSHOT_DIR}/${name}`)
}
