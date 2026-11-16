import { isDirectExecution } from './lib/direct-execution.mts'
// Nightly screenshot drift refresh: decides whether
// .github/workflows/screenshot-refresh.yml moves the refresh PR's branch to a
// new empty commit on the latest `main`.
//
// Any PR whose oracle selection is broad re-renders every reference screenshot,
// so it inherits all of `main`'s accumulated drift as unrelated candidates, and
// maintainers declined the same drift on PR after PR. The refresh PR carries
// that drift instead. Its branch is one empty commit on `main`. CI recognises
// the branch name and renders everything, with the noise and flap filters but
// no ownership scoping (an empty diff owns nothing), so its screenshot evidence
// is `main`'s current drift. A maintainer reviews it once there, with the
// normal accept, decline or tick controls; nothing here accepts or merges.
//
// The branch moves only when that can change the evidence, and never over a
// human decision that `main` still lacks:
//   - an open refresh PR whose head is anything but this workflow's own empty
//     commit is left alone until it is merged or closed, even on a forced
//     dispatch, while it holds a hand push or a reviewed screenshot `main` has
//     not changed since. The decision then lists those screenshots so the
//     workflow can say on the PR what is holding it: #3985 held the refresh for
//     16 nights with nothing but a green run's step summary to show for it;
//   - once `main` has changed every screenshot such a PR committed, moving the
//     branch discards nothing `main` has not already decided afresh, so it
//     moves as if the head were its own commit;
//   - otherwise a night is skipped when the `main` commit the newest refresh PR
//     rendered is current, or when nothing since it reaches a render: no
//     committed hash changed and the test oracle selects no e2e spec. That is
//     the same `skip` CI already trusts to run no e2e on a pull request.
// A dispatch with `force` refreshes regardless of the second rule, for example
// to re-render after the PR's CI failed.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import {
  changedManifestNames,
  parseScreenshotManifest,
  SCREENSHOT_MANIFEST,
  type ScreenshotManifest,
} from './lib/screenshot-manifest.mts'
import { changedFiles, computePlan, computeSelection } from './test-oracle.mts'

/** The refresh PR's head branch. ci.yml keys the full, unscoped render on it. */
export const SCREENSHOT_REFRESH_BRANCH = 'screenshot-refresh/main'
/** Subject of the empty commit the workflow puts on `main`. */
export const SCREENSHOT_REFRESH_SUBJECT = 'chore(e2e): render main for the screenshot drift review'

const SHA = /^[0-9a-f]{40}$/

/** The newest refresh PR, open or closed. */
export interface RefreshPull {
  number: number
  open: boolean
  /** The `main` commit its head renders (merge-base of head and main), or null when unknown. */
  renderedMain: string | null
  /**
   * Whether its head is still the workflow's own empty commit, and is the
   * branch tip the push will replace.
   */
  ownHead: boolean
  /**
   * When the branch tip is not that commit: the reviewed screenshots it
   * commits that `main` has not changed since, sorted. Null when it holds
   * anything but manifest changes (a hand push), or when that cannot be read.
   */
  liveDecisions: string[] | null
}

/** What changed on `main` since a rendered commit, by the measures that move a render. */
export interface MainChanges {
  manifest: boolean
  e2e: 'full' | 'subset' | 'skip'
}

export interface RefreshInput {
  main: string
  pull: RefreshPull | null
  force: boolean
  /** Called only when the answer depends on it: it runs the oracle. */
  changes: (since: string) => MainChanges
}

export interface RefreshDecision {
  refresh: boolean
  reason: string
  /**
   * Reviewed screenshots an open refresh PR holds the branch for after `main`
   * moved on, for the workflow to name on that PR; empty otherwise.
   */
  held: string[]
}

export function decideRefresh({ main, pull, force, changes }: RefreshInput): RefreshDecision {
  if (pull?.open && !pull.ownHead) {
    const number = `#${String(pull.number)}`
    const live = pull.liveDecisions
    if (live === null)
      return {
        refresh: false,
        reason: `${number} carries a commit besides the refresh commit and its committed screenshots (a hand push); merge or close it before the branch can move`,
        held: [],
      }
    if (live.length === 0)
      return {
        refresh: true,
        reason: `main has changed every screenshot ${number} committed since it rendered, so moving the branch discards no decision main lacks`,
        held: [],
      }
    return {
      refresh: false,
      reason: `${number} carries ${String(live.length)} reviewed screenshot${live.length === 1 ? '' : 's'} main has not changed since (${live.join(', ')}); merge or close it before the branch can move`,
      // The night after a review, before main moves, holding loses nothing.
      held: pull.renderedMain === main ? [] : live,
    }
  }
  if (force) return { refresh: true, reason: 'forced by workflow_dispatch', held: [] }
  if (!pull) return { refresh: true, reason: 'no refresh PR has been opened yet', held: [] }
  const rendered = pull.renderedMain
  if (!rendered)
    return {
      refresh: true,
      reason: `the main commit #${String(pull.number)} rendered could not be resolved`,
      held: [],
    }
  if (rendered === main)
    return {
      refresh: false,
      reason: `main has not moved since #${String(pull.number)} rendered it`,
      held: [],
    }
  const since = `since #${String(pull.number)} rendered ${rendered.slice(0, 12)}`
  const changed = changes(rendered)
  if (changed.manifest)
    return { refresh: true, reason: `main changed committed screenshot hashes ${since}`, held: [] }
  if (changed.e2e === 'skip')
    return {
      refresh: false,
      reason: `nothing main changed ${since} reaches an e2e render (oracle: skip)`,
      held: [],
    }
  return {
    refresh: true,
    reason: `main changed render inputs ${since} (oracle: ${changed.e2e})`,
    held: [],
  }
}

/** Run git in the working directory; null on any failure, including a non-zero exit. */
function git(args: string[], cwd?: string): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      // Room for the largest manifest parseScreenshotManifest accepts (2 MiB).
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cwd ? { cwd } : {}),
    }).trim()
  } catch {
    return null
  }
}

/**
 * Whether `head` is still the workflow's own empty commit: one parent, that
 * parent's tree, and the refresh subject. Anything else holds a decision or a
 * push the nightly must not discard.
 */
export function isRefreshCommit(head: string, cwd?: string): boolean {
  const parents = git(['rev-list', '--parents', '-n', '1', head], cwd)?.split(' ') ?? []
  const parent = parents[1]
  if (parents.length !== 2 || !parent) return false
  const tree = git(['rev-parse', `${head}^{tree}`], cwd)
  return (
    tree !== null &&
    tree === git(['rev-parse', `${parent}^{tree}`], cwd) &&
    git(['log', '-1', '--format=%s', head], cwd) === SCREENSHOT_REFRESH_SUBJECT
  )
}

function manifestAt(ref: string, cwd?: string): ScreenshotManifest | null {
  const text = git(['show', `${ref}:${SCREENSHOT_MANIFEST}`], cwd)
  if (text === null) return null
  try {
    return parseScreenshotManifest(text)
  } catch {
    return null
  }
}

/**
 * The reviewed screenshots `tip` commits on top of the `main` it rendered that
 * `main` has not changed since, sorted. Null when `tip` changes any other file
 * (a hand push) or a manifest cannot be read, which keeps the branch held.
 */
export function liveDecisions(tip: string, main: string, cwd?: string): string[] | null {
  const rendered = git(['merge-base', tip, main], cwd)
  if (!rendered) return null
  const files = git(['diff', '--name-only', rendered, tip], cwd)
  if (
    files === null ||
    files.split('\n').some((file) => file !== '' && file !== SCREENSHOT_MANIFEST)
  )
    return null
  const base = manifestAt(rendered, cwd)
  const reviewed = manifestAt(tip, cwd)
  const current = manifestAt(main, cwd)
  if (!base || !reviewed || !current) return null
  const changedOnMain = new Set(changedManifestNames(base, current))
  return changedManifestNames(base, reviewed).filter((name) => !changedOnMain.has(name))
}

/**
 * Changes between `since` and the checked-out `main`. A failed manifest diff
 * reads as changed, and an unknown merge-base makes the oracle plan `full`, so
 * both fail toward a refresh.
 */
function mainChangesSince(since: string): MainChanges {
  const manifest = git(['diff', '--quiet', since, 'HEAD', '--', SCREENSHOT_MANIFEST]) === null
  return { manifest, e2e: computePlan(computeSelection(changedFiles(since))).mode }
}

function emit(file: string | undefined, text: string): void {
  if (file) appendFileSync(file, text)
}

function main(): void {
  const env = process.env
  const mainSha = env['MAIN_SHA'] ?? ''
  if (!SHA.test(mainSha) || git(['rev-parse', 'HEAD']) !== mainSha)
    throw new Error('MAIN_SHA must be the checked-out main commit')
  const number = Number(env['PULL_NUMBER'] ?? '')
  const tip = env['BRANCH_SHA'] ?? ''
  if (tip !== '' && !SHA.test(tip)) throw new Error('BRANCH_SHA must be empty or one commit')
  let pull: RefreshPull | null = null
  if (number > 0) {
    const head = env['PULL_HEAD'] ?? ''
    if (!Number.isSafeInteger(number) || !SHA.test(head))
      throw new Error('PULL_NUMBER and PULL_HEAD must name one pull request head')
    const fetched = (sha: string): boolean =>
      git(['cat-file', '-e', `${sha}^{commit}`]) !== null ||
      git(['fetch', '--no-tags', '--quiet', 'origin', sha]) !== null
    const present = fetched(head)
    const open = env['PULL_OPEN'] === 'true'
    // The push leases the branch tip, so judge that commit: a PR head read
    // before committed screenshots landed must not vouch for a tip it never saw.
    const ownHead = present && head === tip && isRefreshCommit(head)
    pull = {
      number,
      open,
      renderedMain: present ? git(['merge-base', head, mainSha]) : null,
      ownHead,
      liveDecisions:
        open && !ownHead && tip !== '' && fetched(tip) ? liveDecisions(tip, mainSha) : null,
    }
  }
  const decision = decideRefresh({
    main: mainSha,
    pull,
    force: env['FORCE'] === 'true',
    changes: mainChangesSince,
  })
  console.log(`${decision.refresh ? 'refresh' : 'skip'}: ${decision.reason}`)
  emit(
    env['GITHUB_OUTPUT'],
    `refresh=${String(decision.refresh)}\nreason=${decision.reason}\nheld=${decision.held.join(',')}\n`,
  )
  emit(
    env['GITHUB_STEP_SUMMARY'],
    `### Screenshot drift refresh\n\n${decision.refresh ? 'Refresh' : 'Skip'}: ${decision.reason}.\n`,
  )
}

if (isDirectExecution(import.meta.url, 'screenshot-refresh')) main()
