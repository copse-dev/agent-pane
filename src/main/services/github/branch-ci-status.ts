import { z } from 'zod'
import { decodeWithSchema } from '@shared/safe-json.ts'
import { getCurrentBranchName } from './git-service.ts'
import { parseGhJson, runGh } from './gh-service.ts'
import { getCiStatus, rollupToCiChecks, type CiStatus } from './github-ci-service.ts'
import { optionalNumber, optionalString } from './gh-json-schemas.ts'

const RUN_LIMIT = 100
const branchRunSchema = z.object({
  databaseId: optionalNumber,
  workflowDatabaseId: optionalNumber,
  workflowName: optionalString,
  headBranch: optionalString,
  headSha: optionalString,
  event: optionalString,
  status: optionalString,
  conclusion: optionalString,
  url: optionalString,
})
const branchRunsSchema = z.array(branchRunSchema)
type BranchWorkflowRun = z.infer<typeof branchRunSchema>

export interface BranchCiStatus extends CiStatus {
  scope: 'branch_push_workflows'
  evidenceLimit: number
  coverage: string
}

/** gh lists newest first. A rerun supersedes only the same workflow at the same tip. */
export function buildBranchCiStatus(
  branch: string,
  headSha: string,
  runs: readonly BranchWorkflowRun[],
): BranchCiStatus {
  const matching = runs.filter(
    (run) => run.headBranch === branch && run.headSha === headSha && run.event === 'push',
  )
  const latest = new Map<string, BranchWorkflowRun>()
  let unidentified = false
  for (const [index, run] of matching.entries()) {
    if (!run.workflowDatabaseId || !Number.isSafeInteger(run.workflowDatabaseId))
      unidentified = true
    const identity =
      run.workflowDatabaseId !== undefined
        ? `id:${String(run.workflowDatabaseId)}`
        : run.workflowName
          ? `name:${run.workflowName}`
          : `unidentified:${String(index)}`
    if (!latest.has(identity)) latest.set(identity, run)
  }
  const selected = [...latest.values()]
  const checks = rollupToCiChecks(
    selected.map((run) => ({
      name:
        run.workflowName ?? `Workflow ${String(run.workflowDatabaseId ?? run.databaseId ?? '?')}`,
      status: run.status,
      conclusion: run.conclusion?.trim() ? run.conclusion : undefined,
      detailsUrl: run.url,
    })),
  )
  const incomplete = runs.length >= RUN_LIMIT || matching.length !== runs.length || unidentified
  const pending =
    incomplete ||
    checks.length === 0 ||
    checks.some((check) => check.bucket === 'pending' || check.bucket === 'unknown')
  const failed = checks.some((check) => check.bucket === 'fail' || check.bucket === 'cancel')
  const passed = checks.some((check) => check.bucket === 'pass')
  return {
    overall: pending ? 'pending' : failed ? 'failure' : passed ? 'success' : 'pending',
    branch,
    headSha,
    scope: 'branch_push_workflows',
    evidenceLimit: RUN_LIMIT,
    coverage:
      'Observed push-triggered workflows at this exact remote tip; PR-only checks and branch-protection requirements are outside this scope.' +
      (incomplete
        ? ' Evidence is incomplete or reached the limit; success is not established.'
        : '') +
      (checks.length === 0 ? ' No matching workflow runs; status is unknown.' : ''),
    prNumber: null,
    prTitle: null,
    prUrl: null,
    checks,
    latestRunId: selected[0]?.databaseId ?? null,
    latestRunUrl: selected[0]?.url ?? null,
  }
}

async function readBranchCiStatus(branch: string, cwd: string | null): Promise<BranchCiStatus> {
  if (!cwd) throw new Error('No workspace open for branch CI status.')
  const tip = await runGh(
    ['api', `repos/{owner}/{repo}/commits/${encodeURIComponent(branch)}`, '--jq', '.sha'],
    { cwd },
  )
  if (tip.code !== 0) throw new Error(tip.stderr.trim() || 'Cannot read the remote branch tip.')
  const headSha = tip.stdout.trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(headSha)) {
    throw new Error('GitHub did not return a valid remote tip SHA; CI status is unknown.')
  }
  const result = await runGh(
    [
      'run',
      'list',
      '--branch',
      branch,
      '--commit',
      headSha,
      '--event',
      'push',
      '--limit',
      String(RUN_LIMIT),
      '--json',
      'databaseId,workflowDatabaseId,workflowName,headBranch,headSha,event,status,conclusion,url',
    ],
    { cwd },
  )
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || 'Cannot read branch workflow runs.')
  const runs = parseGhJson(result.stdout, decodeWithSchema(branchRunsSchema))
  if (!runs) throw new Error('GitHub returned invalid workflow evidence; CI status is unknown.')
  return buildBranchCiStatus(branch, headSha, runs)
}

/** Interactive status only: durable watches continue to use their existing PR service. */
export async function getInteractiveCiStatus(
  prNumber: number | undefined,
  cwd: string | null,
  branch?: string,
): Promise<CiStatus | BranchCiStatus> {
  if (branch !== undefined && prNumber !== undefined)
    throw new Error('Choose either branch or pr_number.')
  if (branch !== undefined) return readBranchCiStatus(branch, cwd)
  try {
    const status = await getCiStatus(prNumber, cwd)
    if (prNumber !== undefined || status.prNumber !== null) return status
  } catch (error) {
    if (
      prNumber !== undefined ||
      !(error instanceof Error) ||
      !/no pull requests found for branch/i.test(error.message)
    )
      throw error
  }
  const current = await getCurrentBranchName(cwd)
  if (!current)
    throw new Error('No current branch resolved. Use the branch selector for CI status.')
  return readBranchCiStatus(current, cwd)
}
