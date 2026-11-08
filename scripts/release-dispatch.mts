// Starts `Release (macOS)` for a cut tag once CI for its commit has finished.
//
// Two workflows call this, and each covers the order the other cannot see:
//   - release-dispatch.yml runs when CI completes. It finds the tag that
//     release-cut.yml created at the commit, if any, and starts the build.
//   - release-cut.yml, after creating or confirming the tag, starts the build
//     only when CI already finished (a recovery run cut after CI completed).
// Release-cut tags before it reads CI, and the dispatcher reads the tag after
// CI completed, so at least one of them sees both the tag and final CI.
//
// Loaded by github-script from a sparse checkout, so it imports only the
// dependency-free safe-json helper.

import { safeJsonParse } from './lib/safe-json.mts'

export const RELEASE_WORKFLOW = 'release-mac.yml'

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
    }
    git: {
      getRef: (p: RepoParams & { ref: string }) => Promise<{ data: unknown }>
      getTag: (p: RepoParams & { tag_sha: string }) => Promise<{ data: unknown }>
    }
    actions: {
      listWorkflowRuns: (
        p: RepoParams & { workflow_id: string; head_sha: string; per_page: number },
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
 * Dispatches `Release (macOS)` at the tag unless the commit already has a run
 * of it. Any earlier run counts, failed ones included: a failed release is
 * reported by that run and fixed forward (docs/releasing-macos.md), not
 * retried automatically. A run dispatched at the tag carries the release SHA
 * as its head, which makes this lookup exact.
 */
export async function startReleaseBuild(
  ctx: ReleaseDispatchContext,
  sha: string,
  tag: string,
): Promise<'started' | 'already-started'> {
  requireSha(sha)
  const { data } = await ctx.github.rest.actions.listWorkflowRuns({
    owner: ctx.owner,
    repo: ctx.repo,
    workflow_id: RELEASE_WORKFLOW,
    head_sha: sha,
    per_page: 1,
  })
  const count = field(data, 'total_count')
  if (typeof count !== 'number') throw new Error('Could not read existing Release (macOS) runs')
  if (count > 0) {
    ctx.log(`Release (macOS) already has a run for ${tag}; nothing to dispatch.`)
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
  ctx.log(`Dispatched Release (macOS) for ${tag}.`)
  return 'started'
}
