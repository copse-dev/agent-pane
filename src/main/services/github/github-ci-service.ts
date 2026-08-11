import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_RUNNER_LONG_TIMEOUT_MS,
  truncateCommandOutput,
} from '../exec/subprocess-output-cap.ts'
import { parseGhJson, runGh } from './gh-service.ts'
import { firstNonEmptyString } from '@shared/unknown-value.ts'
import { decodeWithSchema } from '@shared/safe-json.ts'
import {
  ghPrViewSchema,
  optionalNumber,
  optionalString,
  type GhPrView,
  type GhStatusCheckRollup,
} from './gh-json-schemas.ts'
import { z } from 'zod'

export type CiOverallState = 'pending' | 'success' | 'failure' | 'no_checks'

export interface CiCheck {
  name: string
  state: string
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | 'unknown'
  link?: string
  workflow?: string
}

export interface CiStatus {
  prNumber: number | null
  prTitle: string | null
  prUrl: string | null
  branch: string | null
  headSha: string | null
  overall: CiOverallState
  checks: CiCheck[]
  latestRunId: number | null
  latestRunUrl: string | null
}

const ghPrChecksSchema = z.array(
  z.object({
    name: optionalString,
    state: optionalString,
    bucket: optionalString,
    link: optionalString,
    workflow: optionalString,
  }),
)
const ghWorkflowRunsSchema = z.array(
  z.object({
    databaseId: optionalNumber,
    headSha: optionalString,
    conclusion: optionalString,
    status: optionalString,
    url: optionalString,
    name: optionalString,
    displayTitle: optionalString,
  }),
)

type GhPrCheckRow = z.infer<typeof ghPrChecksSchema>[number]
type GhWorkflowRun = z.infer<typeof ghWorkflowRunsSchema>[number]

export function normalizeCheckBucket(raw: string | undefined): CiCheck['bucket'] {
  const bucket = (raw ?? '').toLowerCase()
  switch (bucket) {
    case 'pass':
    case 'fail':
    case 'pending':
    case 'skipping':
    case 'cancel':
      return bucket
    default:
      return 'unknown'
  }
}

export function rollupToCiChecks(rollup: GhStatusCheckRollup): CiCheck[] {
  const checks: CiCheck[] = []
  for (const item of rollup ?? []) {
    const name = item.name ?? item.context
    if (!name) continue
    const conclusion = (item.conclusion ?? item.state ?? item.status ?? '').toUpperCase()
    const bucket = rollupItemBucket(item.status, conclusion)
    const check: CiCheck = {
      name,
      state: item.conclusion ?? item.state ?? item.status ?? 'UNKNOWN',
      bucket,
    }
    if (item.detailsUrl) check.link = item.detailsUrl
    checks.push(check)
  }
  return checks
}

function rollupItemBucket(status: string | undefined, conclusion: string): CiCheck['bucket'] {
  const normalizedStatus = (status ?? '').toUpperCase()
  if (
    normalizedStatus === 'IN_PROGRESS' ||
    normalizedStatus === 'QUEUED' ||
    normalizedStatus === 'PENDING'
  ) {
    return 'pending'
  }
  if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') return 'pass'
  if (
    conclusion === 'FAILURE' ||
    conclusion === 'ERROR' ||
    conclusion === 'TIMED_OUT' ||
    conclusion === 'ACTION_REQUIRED'
  ) {
    return 'fail'
  }
  if (conclusion === 'CANCELLED') return 'cancel'
  if (conclusion === 'SKIPPED') return 'skipping'
  return 'unknown'
}

export function deriveOverallState(
  checks: CiCheck[],
  opts: { checksPending?: boolean } = {},
): CiOverallState {
  if (checks.length === 0) {
    // `gh pr checks` exits 8 while checks are queued / not yet reported by
    // GitHub. Surfacing `no_checks` there is misleading — it reads as "this PR
    // genuinely has no CI" when checks are merely pending. (#521)
    return opts.checksPending ? 'pending' : 'no_checks'
  }
  if (checks.some((check) => check.bucket === 'pending')) return 'pending'
  if (checks.some((check) => check.bucket === 'fail')) return 'failure'
  return 'success'
}

export function parseGhPrChecks(raw: string): CiCheck[] {
  const rows = parseGhJson(raw, decodeWithSchema(ghPrChecksSchema))
  if (!Array.isArray(rows)) return []
  return rows
    .filter(
      (row): row is GhPrCheckRow & { name: string } =>
        typeof row.name === 'string' && row.name.length > 0,
    )
    .map((row) => {
      const check: CiCheck = {
        name: row.name,
        state: row.state ?? 'UNKNOWN',
        bucket: normalizeCheckBucket(row.bucket),
      }
      if (row.link) check.link = row.link
      if (row.workflow) check.workflow = row.workflow
      return check
    })
}

export function ghPrHasCiFailures(pr: GhPrView): boolean {
  for (const item of pr.statusCheckRollup ?? []) {
    const conclusion = (item.conclusion ?? item.state ?? item.status ?? '').toUpperCase()
    if (rollupItemBucket(item.status, conclusion) === 'fail') return true
  }
  return false
}

export function pickLatestRunForHead(
  runs: GhWorkflowRun[],
  headSha: string | null,
): GhWorkflowRun | null {
  if (runs.length === 0) return null
  if (headSha) {
    const match = runs.find((run) => run.headSha === headSha)
    if (match) return match
  }
  return runs[0] ?? null
}

function prSelector(prNumber: number | undefined): string[] {
  return prNumber === undefined ? [] : [String(prNumber)]
}

async function loadOpenPr(prNumber?: number, cwd?: string): Promise<GhPrView | null> {
  const args = [
    'pr',
    'view',
    ...prSelector(prNumber),
    '--json',
    'state,number,title,url,headRefName,headRefOid,statusCheckRollup',
  ]
  const result = await runGh(args, cwd ? { cwd } : {})
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'gh pr view failed')
  }
  const pr = parseGhJson(result.stdout, decodeWithSchema(ghPrViewSchema))
  if (!pr || pr.state !== 'OPEN') return null
  return pr
}

interface PrChecksResult {
  checks: CiCheck[]
  /**
   * `gh pr checks` exits 8 while checks are queued / not yet reported by
   * GitHub. We swallow that exit code (it is not an error), but keep the signal
   * so an empty check list can surface `pending` rather than `no_checks`. (#521)
   */
  pending: boolean
}

async function loadPrChecks(prNumber?: number, cwd?: string): Promise<PrChecksResult> {
  const args = [
    'pr',
    'checks',
    ...prSelector(prNumber),
    '--json',
    'name,state,bucket,link,workflow',
  ]
  const result = await runGh(args, cwd ? { cwd } : {})
  if (result.code !== 0 && result.code !== 8) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'gh pr checks failed')
  }
  return { checks: parseGhPrChecks(result.stdout), pending: result.code === 8 }
}

async function loadLatestRun(
  branch: string | null,
  headSha: string | null,
  cwd?: string,
): Promise<GhWorkflowRun | null> {
  if (!branch) return null
  const result = await runGh(
    [
      'run',
      'list',
      '--branch',
      branch,
      '--limit',
      '10',
      '--json',
      'databaseId,headSha,conclusion,status,url,name,displayTitle',
    ],
    cwd ? { cwd } : {},
  )
  if (result.code !== 0) return null
  const runs = parseGhJson(result.stdout, decodeWithSchema(ghWorkflowRunsSchema))
  if (!Array.isArray(runs)) return null
  return pickLatestRunForHead(runs, headSha)
}

function buildCiStatus(
  pr: GhPrView | null,
  prChecks: PrChecksResult,
  latestRun: GhWorkflowRun | null,
): CiStatus {
  const rollupChecks = pr ? rollupToCiChecks(pr.statusCheckRollup) : []
  const mergedChecks = prChecks.checks.length > 0 ? prChecks.checks : rollupChecks
  return {
    prNumber: typeof pr?.number === 'number' ? pr.number : null,
    prTitle: firstNonEmptyString(pr?.title?.trim()) ?? null,
    prUrl: pr?.url ?? null,
    branch: pr?.headRefName ?? null,
    headSha: pr?.headRefOid ?? null,
    overall: deriveOverallState(mergedChecks, { checksPending: prChecks.pending }),
    checks: mergedChecks,
    latestRunId: typeof latestRun?.databaseId === 'number' ? latestRun.databaseId : null,
    latestRunUrl: latestRun?.url ?? null,
  }
}

export async function getCiStatus(prNumber?: number, cwd?: string): Promise<CiStatus> {
  const pr = await loadOpenPr(prNumber, cwd)
  if (!pr) {
    return {
      prNumber: prNumber ?? null,
      prTitle: null,
      prUrl: null,
      branch: null,
      headSha: null,
      overall: 'no_checks',
      checks: [],
      latestRunId: null,
      latestRunUrl: null,
    }
  }
  const prChecks = await loadPrChecks(prNumber, cwd)
  const latestRun = await loadLatestRun(pr.headRefName ?? null, pr.headRefOid ?? null, cwd)
  return buildCiStatus(pr, prChecks, latestRun)
}

/** One-call status read for durable watches; detailed tools can enrich after the wake. */
export async function getCiWatchStatus(
  prNumber: number | undefined,
  cwd: string,
): Promise<CiStatus> {
  const pr = await loadOpenPr(prNumber, cwd)
  if (!pr) {
    return {
      prNumber: prNumber ?? null,
      prTitle: null,
      prUrl: null,
      branch: null,
      headSha: null,
      overall: 'no_checks',
      checks: [],
      latestRunId: null,
      latestRunUrl: null,
    }
  }
  const checks = rollupToCiChecks(pr.statusCheckRollup)
  return buildCiStatus(pr, { checks, pending: false }, null)
}

export async function getCiFailureLogs(opts: {
  prNumber?: number | undefined
  runId?: number | undefined
  maxBytes?: number | undefined
  cwd?: string | undefined
}): Promise<string> {
  const maxBytes = opts.maxBytes ?? COMMAND_OUTPUT_MAX_BYTES
  const pr = await loadOpenPr(opts.prNumber, opts.cwd)
  if (!pr && opts.runId === undefined) {
    throw new Error('No open pull request found for this branch.')
  }

  let runId = opts.runId
  if (runId === undefined) {
    const latestRun = await loadLatestRun(pr?.headRefName ?? null, pr?.headRefOid ?? null, opts.cwd)
    if (!latestRun?.databaseId) {
      throw new Error('No workflow run found for the pull request head commit.')
    }
    runId = latestRun.databaseId
  }

  const result = await runGh(['run', 'view', String(runId), '--log-failed'], {
    timeout_ms: COMMAND_RUNNER_LONG_TIMEOUT_MS,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  })
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || 'gh run view --log-failed failed',
    )
  }
  const output = result.stdout.trim() || result.stderr.trim()
  if (!output) return 'No failed log output returned for this workflow run.'
  return truncateCommandOutput(output, maxBytes)
}
