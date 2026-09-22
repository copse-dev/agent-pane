#!/usr/bin/env node
// Base freshness: does an open pull request's green CI still describe the
// commit that would actually land?
//
// `CI Passed` is attached to a HEAD SHA. GitHub tests `refs/pull/N/merge` —
// head merged into the base branch as it stood when the run was dispatched —
// but branch protection only ever reads the check's name and conclusion. It
// has no idea which base that run merged. So once the base branch advances,
// an untouched pull request keeps a green `CI Passed` describing a merge
// result that no longer exists, and merging it authorizes a combination CI
// never executed. That is the "base advancement" half of #2520, left open by
// #2722 (cancellation) and the retarget trigger work.
//
// The usual fixes are unavailable or unaffordable here:
//   - GitHub's merge queue needs Enterprise Cloud for a private repository and
//     this org is on Team (see ci.yml's `merge_group` note).
//   - Re-dispatching CI for every open pull request on each push to `main`
//     would multiply the day's load across an ephemeral self-hosted fleet that
//     already serves both tiers.
//
// So this does the cheap half only: it RE-EVALUATES, it never re-runs. On each
// push to a protected base, and on each event that moves a pull request's head
// or base, it asks GitHub how far behind that pull request is and publishes the
// answer as its own check run, `Base Current`. No checkout, no dependency
// restore, no fleet — one comparison and one check run per candidate.
//
// Deliberately ADDITIVE. `CI Passed` keeps its exact current meaning, so no
// existing branch rule or consumer changes, and nothing here can open a merge
// window that was closed before. Making `Base Current` required is a separate,
// owner-sequenced repository-settings change; until then this reports without
// enforcing. docs/plans/ci-base-freshness.md records that sequence.
//
// Fails closed on purpose: when freshness cannot be established the verdict is
// `failure`, never a quiet pass. Every path self-heals — the next push to the
// base and the pull request's own next event both re-evaluate it.
//
// Run locally:  GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=... BASE_REF=main \
//                 pnpm run ci:base-freshness -- --dry-run

// Node builtins only — no import from `src/`, no workspace package, no
// `node_modules` at all. Same doctrine as ci.yml's `ci-passed` aggregate: a job
// that decides whether a merge is authorized must not be able to fail because a
// dependency restore did. The small decoders below exist for that reason.

/** The additive check context this script publishes. */
export const CHECK_NAME = 'Base Current'

/**
 * Hard ceiling on candidates evaluated in one run. Reaching it is an error, not
 * a truncation: silently skipping the tail would hand back exactly the quiet
 * pass this control exists to remove.
 */
export const MAX_CANDIDATES = 500

const API_ROOT = 'https://api.github.com'

export type Candidate = {
  number: number
  headSha: string
  baseRef: string
  draft: boolean
}

export type Verdict = {
  conclusion: 'success' | 'failure'
  title: string
  summary: string
}

/**
 * The whole policy, as a pure function of one comparison.
 *
 * `behindBy` is GitHub's own count of commits on the base that the head does
 * not contain — the same measure "Require branches to be up to date before
 * merging" uses. Zero means the tested merge result is still the merge result.
 *
 * `behindBy === null` means the comparison could not be established at all.
 * That is a failure, not a neutral: an unestablished base is indistinguishable
 * from a stale one at merge time.
 */
export function decideBaseFreshness(candidate: Candidate, behindBy: number | null): Verdict {
  const where = `\`${candidate.baseRef}\``
  // Success is reachable from exactly one value. Anything else — absent,
  // fractional, negative — is a comparison this run did not establish, and an
  // unestablished base must not read as a current one.
  if (behindBy === null || !Number.isInteger(behindBy) || behindBy < 0) {
    return {
      conclusion: 'failure',
      title: 'Base freshness could not be established',
      summary:
        `Could not establish how far ${candidate.headSha} is behind ${where}, so this ` +
        `pull request's ` +
        `CI result cannot be shown to describe the commit that would land. This check fails ` +
        `closed. It is re-evaluated on the next push to ${where} and on this pull request's ` +
        `next push, retarget or reopen.`,
    }
  }
  if (behindBy > 0) {
    const commits = behindBy === 1 ? '1 commit' : `${String(behindBy)} commits`
    return {
      conclusion: 'failure',
      title: `${commits} behind ${candidate.baseRef}`,
      summary:
        `${where} has moved on by ${commits} since this pull request was last tested. CI ran ` +
        `against the earlier base, so a green \`CI Passed\` here describes a merge result that ` +
        `no longer exists. Update the branch from ${where} to re-test the combination that ` +
        `would actually land.`,
    }
  }
  return {
    conclusion: 'success',
    title: `Up to date with ${candidate.baseRef}`,
    summary:
      `This pull request contains every commit on ${where}, so the merge result CI tested is ` +
      `the merge result that would land.`,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not a JSON object`)
  return value
}

function decodeCandidate(value: unknown): Candidate {
  const pull = expectRecord(value, 'pull request')
  const head = expectRecord(pull['head'], 'pull request head')
  const base = expectRecord(pull['base'], 'pull request base')
  const number = pull['number']
  const headSha = head['sha']
  const baseRef = base['ref']
  if (typeof number !== 'number') throw new Error('pull request has no number')
  if (typeof headSha !== 'string') throw new Error('pull request has no head sha')
  if (typeof baseRef !== 'string') throw new Error('pull request has no base ref')
  return { number, headSha, baseRef, draft: pull['draft'] === true }
}

export function decodeCandidates(text: string): Candidate[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value)) throw new Error('pull request listing was not a JSON array')
  return value.map(decodeCandidate)
}

export function decodeCandidateResponse(text: string): Candidate {
  const value: unknown = JSON.parse(text)
  return decodeCandidate(value)
}

/**
 * `behind_by` from a base...head comparison, or null when the response does not
 * carry one. Callers turn null into a fail-closed verdict rather than guessing.
 */
export function decodeBehindBy(text: string): number | null {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) return null
  const behindBy = value['behind_by']
  if (typeof behindBy !== 'number' || !Number.isInteger(behindBy) || behindBy < 0) return null
  return behindBy
}

type Api = {
  get: (path: string) => Promise<string>
  post: (path: string, body: unknown) => Promise<void>
}

export function githubApi(repository: string, token: string, fetchImpl: typeof fetch = fetch): Api {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  }
  return {
    async get(path): Promise<string> {
      const res = await fetchImpl(`${API_ROOT}/repos/${repository}${path}`, { headers })
      if (!res.ok) throw new Error(`GET ${path} -> ${String(res.status)} ${res.statusText}`)
      return await res.text()
    },
    async post(path, body): Promise<void> {
      const res = await fetchImpl(`${API_ROOT}/repos/${repository}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`POST ${path} -> ${String(res.status)} ${res.statusText}`)
    },
  }
}

/**
 * Open pull requests targeting `baseRef`, newest first, drafts already removed.
 *
 * Drafts are skipped on the fan-out path because they cannot merge, and their
 * own `ready_for_review` event re-evaluates them the moment they can. That
 * keeps a push to a busy base to roughly one request per mergeable candidate,
 * which is what holds this inside the Actions token's hourly budget.
 */
export async function listCandidates(api: Api, baseRef: string): Promise<Candidate[]> {
  const candidates: Candidate[] = []
  // Bounded on PAGES, not on kept candidates: a base fronted by hundreds of
  // drafts would otherwise page forever without the kept count ever moving.
  const maxPages = Math.ceil(MAX_CANDIDATES / 100)
  for (let page = 1; page <= maxPages; page += 1) {
    const encoded = encodeURIComponent(baseRef)
    const body = await api.get(
      `/pulls?state=open&base=${encoded}&per_page=100&page=${String(page)}`,
    )
    const batch = decodeCandidates(body)
    candidates.push(...batch.filter((candidate) => !candidate.draft))
    if (batch.length < 100) return candidates
  }
  throw new Error(
    `more than ${String(MAX_CANDIDATES)} open pull requests target ${baseRef}; refusing to ` +
      `evaluate a truncated set`,
  )
}

export async function behindBy(api: Api, candidate: Candidate): Promise<number | null> {
  try {
    const base = encodeURIComponent(candidate.baseRef)
    return decodeBehindBy(await api.get(`/compare/${base}...${candidate.headSha}`))
  } catch {
    // A comparison this run could not make is not evidence of freshness. The
    // null flows into decideBaseFreshness and becomes an explicit failure.
    return null
  }
}

export async function publish(api: Api, candidate: Candidate, verdict: Verdict): Promise<void> {
  await api.post('/check-runs', {
    name: CHECK_NAME,
    head_sha: candidate.headSha,
    status: 'completed',
    conclusion: verdict.conclusion,
    output: { title: verdict.title, summary: verdict.summary },
  })
}

export async function evaluate(
  api: Api,
  candidates: Candidate[],
  publishImpl: (candidate: Candidate, verdict: Verdict) => Promise<void>,
): Promise<Verdict[]> {
  const verdicts: Verdict[] = []
  for (const candidate of candidates) {
    const verdict = decideBaseFreshness(candidate, await behindBy(api, candidate))
    verdicts.push(verdict)
    await publishImpl(candidate, verdict)
  }
  return verdicts
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is required`)
  return value
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const repository = requireEnv('GITHUB_REPOSITORY')
  const api = githubApi(repository, requireEnv('GITHUB_TOKEN'))
  const pullNumber = process.env['PR_NUMBER']

  // One pull request when its own head or base moved; the whole open set for
  // that base when the base itself moved.
  const candidates =
    pullNumber === undefined || pullNumber === ''
      ? await listCandidates(api, requireEnv('BASE_REF'))
      : [decodeCandidateResponse(await api.get(`/pulls/${pullNumber}`))]

  const verdicts = await evaluate(api, candidates, async (candidate, verdict) => {
    console.log(`#${String(candidate.number)} ${verdict.conclusion}: ${verdict.title}`)
    if (!dryRun) await publish(api, candidate, verdict)
  })

  const stale = verdicts.filter((verdict) => verdict.conclusion === 'failure').length
  console.log(`${CHECK_NAME}: ${String(verdicts.length)} evaluated, ${String(stale)} not current`)

  // Reporting a stale candidate is this workflow succeeding at its job. Only a
  // failure to evaluate should redden the run itself.
}

if (process.argv[1]?.endsWith('base-freshness.mts') === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
