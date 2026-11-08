// Loaded from the event's pinned base, before any candidate code executes.
// Only GitHub-owned run/job/step records can authorize reuse; no artifact,
// cache, commit status, PR body claim or previous reuse decision is evidence.
type Request = (
  route: string,
  parameters: Record<string, string | number>,
) => Promise<{ data: unknown }>

export interface ReuseInput {
  eventName: string
  payload: unknown
  sha: string
  runId: number
  checksRunner: string
  e2eRunner: string
  runnerImage: string
  now: number
}

const WORKFLOW = '.github/workflows/ci.yml'
const POLICY = 'scripts/ci-metadata-reuse.mts'
const STACK = '<!-- copse-screenshot-stack:'
const LABELS = [
  'ci-full',
  'update-screenshots',
  'bench-agent',
  'bench-doctrine',
  'eval-tool-preference',
  'bench-agent-eval',
]

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function sha(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value) ? value : ''
}

function successful(value: unknown): boolean {
  return field(value, 'conclusion') === 'success' && field(value, 'status') === 'completed'
}

function one(values: unknown[], name: string): unknown {
  const matches = values.filter((value) => field(value, 'name') === name)
  return matches.length === 1 ? matches[0] : undefined
}

function step(job: unknown, name: string): boolean {
  return successful(one(list(field(job, 'steps')), name))
}

function updated(value: unknown): number {
  const timestamp = field(value, 'updated_at')
  return typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN
}

function runSnapshot(values: unknown[]): string {
  return JSON.stringify(
    values.map((run) => [
      field(run, 'id'),
      field(run, 'run_attempt'),
      field(run, 'status'),
      field(run, 'conclusion'),
      field(run, 'updated_at'),
    ]),
  )
}

/** Matches the literal, context-bound Actions step name in ci.yml. */
export function candidateIdentity(input: ReuseInput): string {
  const pr = field(input.payload, 'pull_request')
  const base = field(pr, 'base')
  const labels = list(field(pr, 'labels')).map((label) => field(label, 'name'))
  return [
    'Candidate verification v1',
    input.sha,
    field(field(pr, 'head'), 'sha'),
    field(base, 'sha'),
    field(base, 'ref'),
    field(pr, 'draft'),
    ...LABELS.map((label) => labels.includes(label)),
    input.checksRunner || 'ubuntu-24.04',
    input.e2eRunner || 'ubuntu-24.04',
  ].join(' / ')
}

/** Fail closed to real work on every miss, ambiguous response or API failure. */
export async function findCompletedVerification(
  request: Request,
  input: ReuseInput,
): Promise<string | null> {
  const pr = field(input.payload, 'pull_request')
  const repository = field(input.payload, 'repository')
  const repositoryName = field(repository, 'full_name')
  const repositoryId = field(repository, 'id')
  const head = field(pr, 'head')
  const base = field(pr, 'base')
  const changes = field(input.payload, 'changes')
  const keys = changes && typeof changes === 'object' ? Object.keys(changes) : []
  const body = field(pr, 'body')
  const previousBody = field(field(changes, 'body'), 'from')
  const headSha = sha(field(head, 'sha'))
  const baseSha = sha(field(base, 'sha'))
  const number = field(pr, 'number')
  if (
    !/^ubuntu24\/[0-9.]+$/.test(input.runnerImage) ||
    !['', 'ubuntu-24.04'].includes(input.checksRunner) ||
    !['', 'ubuntu-24.04'].includes(input.e2eRunner) ||
    input.eventName !== 'pull_request' ||
    field(input.payload, 'action') !== 'edited' ||
    keys.length === 0 ||
    keys.some((key) => key !== 'title' && key !== 'body') ||
    keys.some((key) => !Object.hasOwn(field(changes, key) ?? {}, 'from')) ||
    typeof repositoryName !== 'string' ||
    typeof repositoryId !== 'number' ||
    field(field(head, 'repo'), 'id') !== repositoryId ||
    field(field(base, 'repo'), 'id') !== repositoryId ||
    !['main', 'codex/ci-native-reuse-probe-base-20261108'].includes(String(field(base, 'ref'))) ||
    !headSha ||
    !baseSha ||
    !sha(input.sha) ||
    typeof number !== 'number' ||
    typeof field(pr, 'draft') !== 'boolean' ||
    (body !== null && typeof body !== 'string') ||
    (typeof body === 'string' && body.includes(STACK)) ||
    (keys.includes('body') && previousBody !== null && typeof previousBody !== 'string') ||
    (typeof previousBody === 'string' && previousBody.includes(STACK))
  )
    return null

  const [owner, repo] = repositoryName.split('/')
  if (!owner || !repo) return null
  const location = { owner, repo }
  const get = async (
    route: string,
    parameters: Record<string, string | number>,
  ): Promise<unknown> => (await request(route, { ...location, ...parameters })).data
  const liveCandidate = async (): Promise<boolean> => {
    const live = await get('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: number })
    const liveBody = field(live, 'body')
    return (
      field(live, 'state') === 'open' &&
      sha(field(field(live, 'head'), 'sha')) === headSha &&
      sha(field(field(live, 'base'), 'sha')) === baseSha &&
      ['main', 'codex/ci-native-reuse-probe-base-20261108'].includes(
        String(field(field(live, 'base'), 'ref')),
      ) &&
      sha(field(live, 'merge_commit_sha')) === input.sha &&
      candidateIdentity({ ...input, payload: { pull_request: live } }) ===
        candidateIdentity(input) &&
      (liveBody === null || (typeof liveBody === 'string' && !liveBody.includes(STACK)))
    )
  }
  try {
    if (!(await liveCandidate())) return null
    // The event candidate may not change its own verifier or dispatch policy.
    // New policy PRs therefore run real suites, including their metadata edits.
    for (const path of [WORKFLOW, POLICY]) {
      const trusted = await get('GET /repos/{owner}/{repo}/contents/{path}', { path, ref: baseSha })
      const candidate = await get('GET /repos/{owner}/{repo}/contents/{path}', {
        path,
        ref: input.sha,
      })
      if (!sha(field(trusted, 'sha')) || field(candidate, 'sha') !== field(trusted, 'sha'))
        return null
    }
    const recentRuns = async (): Promise<unknown[]> => {
      const runs = await get('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
        workflow_id: 'ci.yml',
        event: 'pull_request',
        head_sha: headSha,
        per_page: 20,
      })
      const entries = list(field(runs, 'workflow_runs'))
      if (field(runs, 'total_count') !== entries.length) throw new Error('Incomplete run history')
      return (
        entries
          .filter((run) => field(run, 'id') !== input.runId)
          // An older run ID can have the newest attempt. Its failure must not be
          // hidden by a newer-ID green run that actually finished earlier.
          .sort((left, right) => updated(right) - updated(left))
      )
    }
    const candidates = await recentRuns()
    if (candidates.some((run) => !Number.isFinite(updated(run)))) return null
    // GitHub timestamps have second precision. Do not invent an ordering for
    // tied attempts; an older-ID failed retry may be the latest check.
    if (new Set(candidates.map(updated)).size !== candidates.length) return null
    // Never search only green runs: a newer failure or running verification
    // invalidates an older green. Bounded history exhaustion means real work.
    for (const run of candidates) {
      const id = field(run, 'id')
      const attempt = field(run, 'run_attempt')
      const started = field(run, 'run_started_at')
      const age = typeof started === 'string' ? input.now - Date.parse(started) : Number.NaN
      if (
        typeof id !== 'number' ||
        id >= input.runId ||
        typeof attempt !== 'number' ||
        attempt < 1 ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > 24 * 60 * 60 * 1000 ||
        field(run, 'path') !== WORKFLOW ||
        field(run, 'event') !== 'pull_request' ||
        field(run, 'head_sha') !== headSha ||
        field(field(run, 'repository'), 'id') !== repositoryId ||
        field(field(run, 'head_repository'), 'id') !== repositoryId ||
        !successful(run)
      )
        return null
      const pulls = list(field(run, 'pull_requests'))
      if (pulls.length !== 1 || field(pulls[0], 'number') !== number) return null
      const response = await get(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
        {
          run_id: id,
          attempt_number: attempt,
          per_page: 100,
        },
      )
      const jobs = list(field(response, 'jobs'))
      if (field(response, 'total_count') !== jobs.length) return null
      const precheck = one(jobs, 'precheck')
      if (
        !successful(precheck) ||
        !step(precheck, candidateIdentity(input)) ||
        !step(precheck, `Native runtime v1 / ${input.runnerImage}`)
      )
        return null
      // A reused run cannot become the source of a chain of reusable claims.
      // Walk past it only when its own fresh verification actually succeeded.
      if (step(precheck, 'Reusing verified native suites')) continue
      if (
        !['check', 'build', 'screenshot-baselines', 'screenshot-artifacts', 'CI Passed'].every(
          (name) => successful(one(jobs, name)),
        )
      )
        return null
      if (!step(precheck, 'Screenshot evidence plan: render / full / 9 shards')) return null
      const shards = jobs.filter((job) => String(field(job, 'name')).startsWith('e2e ('))
      if (shards.length !== 9) return null
      for (let index = 1; index <= 9; index++) {
        const job = one(shards, `e2e (${String(index)})`)
        if (
          !successful(job) ||
          !step(job, `Native runtime v1 / ${input.runnerImage}`) ||
          !step(
            job,
            `e2e shard ${String(index)}/9 (oracle-gated, retry on flaky session startup)`,
          ) ||
          !step(job, 'Collect changed reference screenshots') ||
          !step(job, 'Upload rendered screenshot shard')
        )
          return null
      }
      // Refuse a rerun/retarget/head movement that raced the job lookup.
      const finalRun = await get('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: id })
      if (
        !successful(finalRun) ||
        field(finalRun, 'run_attempt') !== attempt ||
        runSnapshot(await recentRuns()) !== runSnapshot(candidates) ||
        !(await liveCandidate())
      )
        return null
      return `https://github.com/${repositoryName}/actions/runs/${String(id)}/attempts/${String(attempt)}`
    }
  } catch {
    // Lack of read access, rate limits and missing base policy spend real CI;
    // they never manufacture success or block ordinary verification.
  }
  return null
}
