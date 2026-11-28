// Starts `Release (macOS)` for a cut tag once CI for its commit has finished.
//
// release-dispatch.yml is the only caller. It runs when CI completes, and when
// release-cut.yml hands it a newly cut commit (a recovery cut can land after CI
// already finished). Its concurrency group runs one evaluation per commit at a
// time, and each dispatch records a `Release dispatch` commit status keyed to
// the CI run and attempt it acted on. A later evaluation of the same CI result
// therefore skips, even before the run it dispatched appears in the run list.
//
// "Finished" is the newest CI push run's status, not its evidence: a failed
// run still starts the build so preflight reports it, and an API error throws
// instead of reading as either answer.
//
// Loaded by github-script from a sparse checkout, so it imports only the
// dependency-free safe-json helper.

import { safeJsonParse } from './lib/safe-json.mts'

export const RELEASE_WORKFLOW = 'release-mac.yml'
export const CI_WORKFLOW = 'ci.yml'
/** The commit status that records each dispatch, keyed by its target URL. */
export const RELEASE_DISPATCH_CONTEXT = 'Release dispatch'
const ACTIONS_BOT_ID = 41898282
/**
 * The release-mac.yml preflight step that stops a run dispatched before CI
 * for its commit finished. Such a run made no release decision, so it does not
 * count as the commit's one automatic run. The name must match the workflow's
 * step exactly; scripts/ci-workflow-invariants.test.ts pins it.
 */
export const RELEASE_PREFLIGHT_JOB = 'preflight'
export const CI_PENDING_STEP = 'Stop: CI for the tagged commit has not finished'

const SHA = /^[0-9a-f]{40}$/
// A plausible package version, only so a tag ref is never built from junk.
// `Release (macOS)` re-classifies it with the real channel rules.
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/

interface RepoParams {
  owner: string
  repo: string
}

/**
 * The slice of github-script's Octokit this module calls. Responses stay
 * `unknown` and are narrowed here.
 */
export interface ReleaseDispatchGitHub {
  rest: {
    repos: {
      getContent: (p: RepoParams & { path: string; ref: string }) => Promise<{ data: unknown }>
      listCommitStatusesForRef: (
        p: RepoParams & { ref: string; per_page: number },
      ) => Promise<{ data: unknown }>
      createCommitStatus: (
        p: RepoParams & {
          sha: string
          state: 'success'
          context: string
          description: string
          target_url: string
        },
      ) => Promise<unknown>
    }
    git: {
      getRef: (p: RepoParams & { ref: string }) => Promise<{ data: unknown }>
      getTag: (p: RepoParams & { tag_sha: string }) => Promise<{ data: unknown }>
    }
    actions: {
      listWorkflowRuns: (
        p: RepoParams & {
          workflow_id: string
          head_sha: string
          per_page: number
          event?: 'push'
        },
      ) => Promise<{ data: unknown }>
      listJobsForWorkflowRun: (
        p: RepoParams & { run_id: number; filter: 'latest'; per_page: number },
      ) => Promise<{ data: unknown }>
      createWorkflowDispatch: (
        p: RepoParams & { workflow_id: string; ref: string; inputs: { tag: string } },
      ) => Promise<unknown>
    }
  }
}

export interface ReleaseDispatchContext {
  github: ReleaseDispatchGitHub
  owner: string
  repo: string
  log: (message: string) => void
}

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
  return Reflect.get(value, key)
}

function httpStatus(error: unknown): unknown {
  return field(error, 'status')
}

function requireSha(sha: string): string {
  if (!SHA.test(sha)) throw new Error(`Invalid release commit SHA: ${sha}`)
  return sha
}

async function packageVersionAt(ctx: ReleaseDispatchContext, sha: string): Promise<string> {
  const { data } = await ctx.github.rest.repos.getContent({
    owner: ctx.owner,
    repo: ctx.repo,
    path: 'package.json',
    ref: sha,
  })
  const content = field(data, 'content')
  if (typeof content !== 'string') throw new Error(`package.json at ${sha} is not a file`)
  const version = safeJsonParse(Buffer.from(content, 'base64').toString('utf8'), (value) => {
    const parsed = field(value, 'version')
    return typeof parsed === 'string' ? parsed : null
  })
  if (version === null || !VERSION.test(version)) {
    throw new Error(`package.json at ${sha} has no usable version`)
  }
  return version
}

async function taggedCommit(ctx: ReleaseDispatchContext, tag: string): Promise<string | null> {
  let ref: unknown
  try {
    ref = (
      await ctx.github.rest.git.getRef({ owner: ctx.owner, repo: ctx.repo, ref: `tags/${tag}` })
    ).data
  } catch (error) {
    if (httpStatus(error) === 404) return null
    throw error
  }
  const object = field(ref, 'object')
  const type = field(object, 'type')
  const sha = field(object, 'sha')
  if (typeof sha !== 'string') throw new Error(`${tag} has no target`)
  if (type === 'commit') return sha
  if (type !== 'tag') return null
  // An annotated tag (one pushed by hand) points at a tag object first.
  const { data } = await ctx.github.rest.git.getTag({
    owner: ctx.owner,
    repo: ctx.repo,
    tag_sha: sha,
  })
  const target = field(data, 'object')
  const targetSha = field(target, 'sha')
  return field(target, 'type') === 'commit' && typeof targetSha === 'string' ? targetSha : null
}

/**
 * The `v<package version>` tag at exactly this commit, or null when the
 * commit's version is untagged or tagged elsewhere (an ordinary promotion
 * that releases nothing). Lookup failures other than a missing tag throw.
 */
export async function releaseTagAt(
  ctx: ReleaseDispatchContext,
  sha: string,
): Promise<string | null> {
  requireSha(sha)
  const tag = `v${await packageVersionAt(ctx, sha)}`
  const target = await taggedCommit(ctx, tag)
  if (target === sha) return tag
  ctx.log(
    target === null
      ? `${tag} is not tagged; ${sha} releases nothing.`
      : `${tag} is tagged at ${target}, not ${sha}; nothing to release.`,
  )
  return null
}

/**
 * Whether a Release (macOS) run stopped because CI for its commit had not
 * finished: its latest attempt's preflight reached CI_PENDING_STEP. A run that
 * has not got that far counts, since its single evidence read is still to come
 * and will see whatever CI state exists then.
 */
async function stoppedBeforeCiFinished(
  ctx: ReleaseDispatchContext,
  runId: number,
): Promise<boolean> {
  const { data } = await ctx.github.rest.actions.listJobsForWorkflowRun({
    owner: ctx.owner,
    repo: ctx.repo,
    run_id: runId,
    filter: 'latest',
    per_page: 100,
  })
  const jobs = field(data, 'jobs')
  if (!Array.isArray(jobs))
    throw new Error(`Could not read the jobs of Release (macOS) run ${String(runId)}`)
  const jobList: readonly unknown[] = jobs
  for (const job of jobList) {
    if (field(job, 'name') !== RELEASE_PREFLIGHT_JOB) continue
    const steps = field(job, 'steps')
    if (!Array.isArray(steps)) return false
    const stepList: readonly unknown[] = steps
    for (const step of stepList) {
      if (field(step, 'name') !== CI_PENDING_STEP) continue
      return field(step, 'conclusion') === 'failure' || field(step, 'status') === 'in_progress'
    }
  }
  return false
}

/** The newest CI push run at a commit: the one preflight's evidence read uses. */
export interface CiRun {
  id: number
  attempt: number
  status: unknown
}

/**
 * The CI result a dispatch acts on, as the URL of that run attempt. A re-run
 * of CI is a new attempt and so a new key: after a re-run the commit can be
 * evaluated afresh (a build stopped by the re-run is then not counted).
 */
function dispatchKey(ctx: ReleaseDispatchContext, ci: CiRun): string {
  return `https://github.com/${ctx.owner}/${ctx.repo}/actions/runs/${String(ci.id)}/attempts/${String(ci.attempt)}`
}

/** Whether this workflow already dispatched the build for this CI result. */
async function dispatchedFor(
  ctx: ReleaseDispatchContext,
  sha: string,
  key: string,
): Promise<boolean> {
  const { data } = await ctx.github.rest.repos.listCommitStatusesForRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: sha,
    per_page: 100,
  })
  if (!Array.isArray(data)) throw new Error(`Could not read the commit statuses of ${sha}`)
  const statuses: readonly unknown[] = data
  return statuses.some(
    (status) =>
      field(status, 'context') === RELEASE_DISPATCH_CONTEXT &&
      field(status, 'state') === 'success' &&
      field(status, 'target_url') === key &&
      field(field(status, 'creator'), 'id') === ACTIONS_BOT_ID,
  )
}

/**
 * Dispatches `Release (macOS)` at the tag, at most once per CI result, unless
 * the commit already has a run of it that made, or may still make, a release
 * decision. Failed runs count: a failed release is reported by that run and
 * fixed forward (docs/releasing-macos.md), not retried automatically. The
 * exception is a run that stopped because CI had not finished, which decided
 * nothing. A run dispatched at the tag carries the release SHA as its head,
 * which makes the run lookup exact.
 */
export async function startReleaseBuild(
  ctx: ReleaseDispatchContext,
  sha: string,
  tag: string,
  ci: CiRun,
): Promise<'started' | 'already-started'> {
  requireSha(sha)
  const key = dispatchKey(ctx, ci)
  if (await dispatchedFor(ctx, sha, key)) {
    ctx.log(`Release (macOS) was already dispatched for ${tag} after ${key}; nothing to dispatch.`)
    return 'already-started'
  }
  const { data } = await ctx.github.rest.actions.listWorkflowRuns({
    owner: ctx.owner,
    repo: ctx.repo,
    workflow_id: RELEASE_WORKFLOW,
    head_sha: sha,
    per_page: 100,
  })
  const runs = field(data, 'workflow_runs')
  if (!Array.isArray(runs)) throw new Error('Could not read existing Release (macOS) runs')
  const list: readonly unknown[] = runs
  for (const run of list) {
    const id = field(run, 'id')
    if (typeof id !== 'number') throw new Error('Could not read a Release (macOS) run id')
    if (await stoppedBeforeCiFinished(ctx, id)) {
      ctx.log(`Release (macOS) run ${String(id)} stopped before CI finished; it does not count.`)
      continue
    }
    ctx.log(`Release (macOS) already has run ${String(id)} for ${tag}; nothing to dispatch.`)
    return 'already-started'
  }
  // GITHUB_TOKEN may dispatch: workflow_dispatch is the documented exception
  // to "a GITHUB_TOKEN event starts no workflow".
  await ctx.github.rest.actions.createWorkflowDispatch({
    owner: ctx.owner,
    repo: ctx.repo,
    workflow_id: RELEASE_WORKFLOW,
    ref: tag,
    inputs: { tag },
  })
  // Recorded after the dispatch, so a failed dispatch is retried. If this write
  // fails the job reports it, and a re-run finds the dispatched run instead.
  await ctx.github.rest.repos.createCommitStatus({
    owner: ctx.owner,
    repo: ctx.repo,
    sha,
    state: 'success',
    context: RELEASE_DISPATCH_CONTEXT,
    description: `Dispatched Release (macOS) for ${tag}`,
    target_url: key,
  })
  ctx.log(`Dispatched Release (macOS) for ${tag}.`)
  return 'started'
}

/**
 * The newest push run of CI at the commit, or null when there is none yet.
 * Shape errors and API errors throw.
 */
export async function newestCiRun(ctx: ReleaseDispatchContext, sha: string): Promise<CiRun | null> {
  requireSha(sha)
  const { data } = await ctx.github.rest.actions.listWorkflowRuns({
    owner: ctx.owner,
    repo: ctx.repo,
    workflow_id: CI_WORKFLOW,
    head_sha: sha,
    event: 'push',
    per_page: 100,
  })
  const runs = field(data, 'workflow_runs')
  if (!Array.isArray(runs)) throw new Error('Could not read CI runs')
  const list: readonly unknown[] = runs
  let newest: { number: number; run: CiRun } | null = null
  for (const run of list) {
    const number = field(run, 'run_number')
    const id = field(run, 'id')
    const attempt = field(run, 'run_attempt')
    if (typeof number !== 'number' || typeof id !== 'number' || typeof attempt !== 'number') {
      throw new Error('Could not read a CI run number, id or attempt')
    }
    if (newest === null || number > newest.number) {
      newest = { number, run: { id, attempt, status: field(run, 'status') } }
    }
  }
  if (newest === null) ctx.log(`No CI push run found for ${sha} yet.`)
  return newest?.run ?? null
}

/**
 * Whether the newest push run of CI at the commit, the one preflight reads,
 * has finished, whatever its conclusion. A re-run in progress counts as not
 * finished: its completion triggers release-dispatch.yml again.
 */
export async function ciFinished(ctx: ReleaseDispatchContext, sha: string): Promise<boolean> {
  return (await newestCiRun(ctx, sha))?.status === 'completed'
}

/**
 * Starts the build once CI at the commit has finished; until then, leaves it
 * to CI's completion, which runs release-dispatch.yml again.
 */
export async function startReleaseWhenCiFinished(
  ctx: ReleaseDispatchContext,
  sha: string,
  tag: string,
): Promise<'ci-running' | 'started' | 'already-started'> {
  const ci = await newestCiRun(ctx, sha)
  if (ci === null || ci.status !== 'completed') {
    ctx.log(`CI for ${sha} is still running; its completion starts Release (macOS) for ${tag}.`)
    return 'ci-running'
  }
  return startReleaseBuild(ctx, sha, tag, ci)
}
