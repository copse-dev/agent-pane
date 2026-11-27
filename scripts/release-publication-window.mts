import { isDirectExecution } from './lib/direct-execution.mts'
import { readFileSync } from 'node:fs'
import {
  expectArray,
  expectBoolean,
  expectNumber,
  expectRecord,
  expectString,
  parseJsonUnknown,
} from '../packages/std/src/unknown-value.ts'
import { nextBetaVersion } from './release-bump.mts'

// How long an unpublished release can still be published. `Release (macOS)`
// uploads the signed, notarized, smoke-tested files as Actions artifacts, and
// `Publish release artifacts` publishes only those bytes. Once they expire that
// build can no longer be published, and `Bump release version`, which waits for
// the current version to be published, would skip every week for good.
//
// `release-bump.yml` runs this when it skips for an unpublished version: it
// finds the version's successful `Release (macOS)` run by the tag's commit, reads
// when that run's artifacts expire, and reports. Near expiry it opens an
// `area:release` issue; once expired it also fails, naming the way out.
//
// Install-free: `release-bump.yml` runs this with plain Node and no
// `node_modules`.

/** `retention-days` of the artifacts `Release (macOS)` uploads for publication. */
export const RELEASE_ARTIFACT_RETENTION_DAYS = 30
/**
 * How close to expiry an unpublished build raises an issue. The bump checks
 * only weekly, so a seven-day threshold could first warn with hours left, or,
 * with a delayed schedule, not at all. Fourteen guarantees a warning with at
 * least a week left, and a second one in the final week.
 */
export const EXPIRY_WARNING_DAYS = 14
const RELEASE_WORKFLOW_PATH = '.github/workflows/release-mac.yml'
const ARCHITECTURES = ['arm64', 'x64'] as const
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

export interface ReleaseRun {
  id: number
  headSha: string
  path: string
  status: string
  conclusion: string | null
  createdAt: string
  url: string
}

export interface RunArtifact {
  name: string
  expired: boolean
  expiresAt: string | null
}

/** The items of one REST list page, or of the page array `gh api --paginate --slurp` prints. */
function pageItems(value: unknown, key: string): unknown[] {
  const pages = Array.isArray(value) ? value : [value]
  return pages.flatMap((page, index) =>
    expectArray(expectRecord(page, `page ${String(index)}`)[key], `page ${String(index)}.${key}`),
  )
}

function expectTime(value: unknown, label: string): string {
  const text = expectString(value, label)
  if (Number.isNaN(Date.parse(text))) throw new TypeError(`${label} is not a time: ${text}`)
  return text
}

/** Narrow a workflow-runs listing to the fields the window reads. */
export function parseReleaseRuns(value: unknown): ReleaseRun[] {
  return pageItems(value, 'workflow_runs').map((item, index) => {
    const label = `workflow_runs[${String(index)}]`
    const run = expectRecord(item, label)
    const conclusion = run['conclusion']
    return {
      id: expectNumber(run['id'], `${label}.id`),
      headSha: expectString(run['head_sha'], `${label}.head_sha`),
      path: expectString(run['path'], `${label}.path`),
      status: expectString(run['status'], `${label}.status`),
      conclusion: conclusion === null ? null : expectString(conclusion, `${label}.conclusion`),
      createdAt: expectTime(run['created_at'], `${label}.created_at`),
      url: expectString(run['html_url'], `${label}.html_url`),
    }
  })
}

/** Narrow a run-artifacts listing to the fields the window reads. */
export function parseRunArtifacts(value: unknown): RunArtifact[] {
  return pageItems(value, 'artifacts').map((item, index) => {
    const label = `artifacts[${String(index)}]`
    const artifact = expectRecord(item, label)
    const expiresAt = artifact['expires_at']
    return {
      name: expectString(artifact['name'], `${label}.name`),
      expired: expectBoolean(artifact['expired'], `${label}.expired`),
      expiresAt: expiresAt === null ? null : expectTime(expiresAt, `${label}.expires_at`),
    }
  })
}

/** The artifacts `Publish release artifacts` downloads from the run for this commit. */
export function publishedArtifactNames(releaseSha: string): string[] {
  return [...ARCHITECTURES, 'metadata'].map((part) => `copse-macos-${releaseSha}-${part}`)
}

function newest(runs: readonly ReleaseRun[]): ReleaseRun | null {
  let best: ReleaseRun | null = null
  for (const run of runs) {
    const order = best === null ? 1 : Date.parse(run.createdAt) - Date.parse(best.createdAt)
    if (best === null || order > 0 || (order === 0 && run.id > best.id)) best = run
  }
  return best
}

function releaseRunsFor(runs: readonly ReleaseRun[], releaseSha: string): ReleaseRun[] {
  return runs.filter((run) => run.path === RELEASE_WORKFLOW_PATH && run.headSha === releaseSha)
}

/**
 * The run `Publish release artifacts` would accept for this commit: a completed,
 * successful `Release (macOS)` run of exactly it. The newest, if there are
 * several, since its artifacts last longest.
 */
export function latestSuccessfulRun(
  runs: readonly ReleaseRun[],
  releaseSha: string,
): ReleaseRun | null {
  return newest(
    releaseRunsFor(runs, releaseSha).filter(
      (run) => run.status === 'completed' && run.conclusion === 'success',
    ),
  )
}

export type PublicationWindow =
  /** No `v<version>` tag yet, so nothing has been built. */
  | { state: 'untagged' }
  /** No successful run yet, and one is still going. */
  | { state: 'building'; run: ReleaseRun }
  /** No successful run, and none going: it failed, was cancelled, or never started. */
  | { state: 'unbuilt'; run: ReleaseRun | null }
  /** Publishable, with more than the warning threshold left. */
  | { state: 'open'; run: ReleaseRun; expiresAt: Date }
  /** Publishable, but within the warning threshold of expiry. */
  | { state: 'closing'; run: ReleaseRun; expiresAt: Date }
  /** Its artifacts are gone. `estimated` when GitHub no longer lists them. */
  | { state: 'expired'; run: ReleaseRun; expiresAt: Date; estimated: boolean }

/**
 * How long the unpublished release at `releaseSha` (null when untagged) can
 * still be published. `artifacts` are those of `latestSuccessfulRun(runs)`.
 */
export function assessPublicationWindow(options: {
  releaseSha: string | null
  runs: readonly ReleaseRun[]
  artifacts: readonly RunArtifact[]
  now: Date
}): PublicationWindow {
  const { releaseSha, runs, artifacts, now } = options
  if (releaseSha === null) return { state: 'untagged' }
  const run = latestSuccessfulRun(runs, releaseSha)
  if (run === null) {
    const own = releaseRunsFor(runs, releaseSha)
    const going = newest(own.filter((candidate) => candidate.status !== 'completed'))
    return going === null
      ? { state: 'unbuilt', run: newest(own) }
      : { state: 'building', run: going }
  }
  // GitHub stops listing an artifact once it expires, so a missing one is gone
  // too. Its expiry then comes from the run's start and the retention: an
  // early estimate, since uploads come later, but never one a rerun moves.
  const estimate = Date.parse(run.createdAt) + RELEASE_ARTIFACT_RETENTION_DAYS * DAY_MS
  let closes = Number.POSITIVE_INFINITY
  let gone = false
  let goneAt: number | null = null
  for (const name of publishedArtifactNames(releaseSha)) {
    const copies = artifacts.filter((artifact) => artifact.name === name)
    const live = copies.filter((artifact) => !artifact.expired)
    if (live.length === 0) {
      gone = true
      for (const copy of copies) {
        if (copy.expiresAt !== null) {
          goneAt = Math.min(goneAt ?? Number.POSITIVE_INFINITY, Date.parse(copy.expiresAt))
        }
      }
      continue
    }
    // A rerun uploads the same name again; the newest copy is the one that lasts.
    const lasts = Math.max(
      ...live.map((artifact) =>
        artifact.expiresAt === null ? estimate : Date.parse(artifact.expiresAt),
      ),
    )
    closes = Math.min(closes, lasts)
  }
  if (gone) {
    return {
      state: 'expired',
      run,
      expiresAt: new Date(goneAt ?? estimate),
      estimated: goneAt === null,
    }
  }
  const left = closes - now.getTime()
  const expiresAt = new Date(closes)
  if (left <= 0) return { state: 'expired', run, expiresAt, estimated: false }
  return { state: left <= EXPIRY_WARNING_DAYS * DAY_MS ? 'closing' : 'open', run, expiresAt }
}

export interface PublicationReport {
  level: 'notice' | 'warning' | 'error'
  /** One line, for the workflow annotation and step summary. */
  message: string
  /** The `area:release` issue to open, or to comment on when one is open. */
  issue: { title: string; body: string } | null
}

/** One open issue per tag; a later week comments on it rather than opening another. */
export function unpublishedIssueTitle(tag: string): string {
  return `Release unpublished: ${tag}`
}

function formatTime(time: Date): string {
  return `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function formatRemaining(ms: number): string {
  if (ms >= 2 * DAY_MS) return `${String(Math.floor(ms / DAY_MS))} days`
  if (ms >= DAY_MS) return '1 day'
  const hours = Math.max(1, Math.floor(ms / HOUR_MS))
  return hours === 1 ? '1 hour' : `${String(hours)} hours`
}

function runLink(run: ReleaseRun): string {
  return `[Release (macOS) run ${String(run.id)}](${run.url})`
}

/** What the bump run says, and files, about an unpublished `tag`. */
export function reportPublicationWindow(
  tag: string,
  window: PublicationWindow,
  now: Date,
): PublicationReport {
  if (!tag.startsWith('v')) throw new Error(`Release tag must start with v: ${tag}`)
  // Also rejects any version shape the release channels do not support.
  const next = nextBetaVersion(tag.slice(1))
  const cutPast =
    `dispatch \`Bump release version\` with the next version (for example \`${next}\`), ` +
    `which cuts past ${tag} and carries its notes forward into that release`
  switch (window.state) {
    case 'untagged':
      return {
        level: 'notice',
        message: `${tag} is not published or tagged yet. Cut release tag tags it, and starts Release (macOS), once the promotion carries it to release.`,
        issue: null,
      }
    case 'building':
      return {
        level: 'notice',
        message: `${tag} is not published; its Release (macOS) run is still going: ${window.run.url}. Publish its artifacts once it succeeds.`,
        issue: null,
      }
    case 'unbuilt': {
      const { run } = window
      if (run?.conclusion === 'failure') {
        // report-failure in release-mac.yml has already opened an issue for it.
        return {
          level: 'warning',
          message: `${tag} is not published, and its Release (macOS) run failed: ${run.url}. The weekly bump skips until it is published or cut past. Its "Release (macOS) failed for ${tag}" issue has the fix: fix forward, then ${cutPast}. See docs/releasing-macos.md#failed-releases.`,
          issue: null,
        }
      }
      // Cancelled, a startup failure, or never dispatched: report-failure does
      // not fire for these, and Cut release tag will not dispatch again while
      // any run exists, so nothing else would ever say the train has stopped.
      const why =
        run === null
          ? 'has never run'
          : `ended ${run.conclusion ?? 'without a conclusion'}: ${run.url}`
      // From the tag, not the default branch: a dispatch run's head_sha is the
      // ref it ran from, and the publisher accepts only the tag's commit.
      const build = `dispatch \`Release (macOS)\` from the tag, not from main (choose \`${tag}\` under "Use workflow from", or run \`gh workflow run release-mac.yml --ref ${tag} -f tag=${tag}\`), so the rebuild can be published`
      return {
        level: 'warning',
        message: `${tag} is not published, and its Release (macOS) build ${why}. Nothing will build it unless a person does: ${build}, or ${cutPast}.`,
        issue: {
          title: unpublishedIssueTitle(tag),
          body: [
            `\`Bump release version\` skipped this week because \`${tag}\` is not published, and it has no successful build: its Release (macOS) run ${run === null ? 'has never run' : `[ended ${run.conclusion ?? 'without a conclusion'}](${run.url})`}. No failure issue covers this, and \`Cut release tag\` does not dispatch a second run for a tag that has one, so the weekly bump will skip until a person acts.`,
            `To build it, ${build}. To abandon it instead, ${cutPast}. See docs/releasing-macos.md#publication-window.`,
            `Close this issue once \`${tag}\` or a later version is published.`,
          ].join('\n\n'),
        },
      }
    }
    case 'open': {
      const left = formatRemaining(window.expiresAt.getTime() - now.getTime())
      return {
        level: 'notice',
        message: `${tag} is not published. Publish it from ${window.run.url} before its artifacts expire on ${formatTime(window.expiresAt)} (in ${left}).`,
        issue: null,
      }
    }
    case 'closing': {
      const expiry = formatTime(window.expiresAt)
      const left = formatRemaining(window.expiresAt.getTime() - now.getTime())
      return {
        level: 'warning',
        message: `${tag} is still not published, and the artifacts of ${window.run.url} expire on ${expiry} (in ${left}). Publish it before then: after that, this build can no longer be published.`,
        issue: {
          title: unpublishedIssueTitle(tag),
          body: [
            `\`Bump release version\` skipped this week because \`${tag}\` is not published. ${runLink(window.run)} built it, and its signed artifacts expire on ${expiry} (in ${left}). \`Publish release artifacts\` publishes only those exact bytes, so after that this build can no longer be published, and the weekly bump will skip until a person cuts past \`${tag}\`.`,
            `To publish it, install-test the artifacts, then dispatch \`Publish release artifacts\` with tag \`${tag}\` and run ID \`${String(window.run.id)}\`.`,
            `To abandon it instead, ${cutPast}. See docs/releasing-macos.md#publication-window.`,
            `Close this issue once \`${tag}\` or a later version is published.`,
          ].join('\n\n'),
        },
      }
    }
    case 'expired': {
      // An estimate still ahead of now means the artifacts went early (deleted
      // by hand, say); never claim a future expiry.
      const when = !window.estimated
        ? `expired on ${formatTime(window.expiresAt)}`
        : window.expiresAt.getTime() <= now.getTime()
          ? `expired around ${formatTime(window.expiresAt)}`
          : 'are no longer available'
      return {
        level: 'error',
        message: `${tag}'s build can no longer be published: the artifacts of ${window.run.url} ${when}. The weekly bump skips every week until a person moves on: ${cutPast}.`,
        issue: {
          title: unpublishedIssueTitle(tag),
          body: [
            `\`${tag}\` was never published, and its build no longer can be: the signed artifacts of ${runLink(window.run)} ${when}, and \`Publish release artifacts\` publishes only a run's own artifacts.`,
            `\`Bump release version\` waits for the current version to be published, so it will skip every week, and fail, until a person moves on. To do that, ${cutPast}. The schedule does not cut past it by itself; see docs/releasing-macos.md#publication-window.`,
            'Close this issue once a later version is published.',
          ].join('\n\n'),
        },
      }
    }
  }
}

function readJson(path: string): unknown {
  return parseJsonUnknown(readFileSync(path, 'utf8'))
}

function releaseSha(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`Not a commit SHA: ${value}`)
  return value
}

const USAGE = [
  'Usage:',
  '  node scripts/release-publication-window.mts latest-run <runs.json> <release-sha>',
  '  node scripts/release-publication-window.mts report <tag> <release-sha|none> <runs.json|none> <artifacts.json|none>',
].join('\n')

function main(args: string[]): void {
  const [command, ...rest] = args
  if (command === 'latest-run' && rest.length === 2) {
    const [runsPath = '', sha = ''] = rest
    const run = latestSuccessfulRun(parseReleaseRuns(readJson(runsPath)), releaseSha(sha))
    // stdout carries only the run ID, or nothing, for the workflow to read.
    process.stdout.write(`${run === null ? '' : String(run.id)}\n`)
  } else if (command === 'report' && rest.length === 4) {
    const [tag = '', sha = '', runsPath = '', artifactsPath = ''] = rest
    const now = new Date()
    const window = assessPublicationWindow({
      releaseSha: sha === 'none' ? null : releaseSha(sha),
      runs: runsPath === 'none' ? [] : parseReleaseRuns(readJson(runsPath)),
      artifacts: artifactsPath === 'none' ? [] : parseRunArtifacts(readJson(artifactsPath)),
      now,
    })
    process.stdout.write(`${JSON.stringify(reportPublicationWindow(tag, window, now))}\n`)
  } else {
    throw new Error(USAGE)
  }
}

if (isDirectExecution(import.meta.url, 'release-publication-window')) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
