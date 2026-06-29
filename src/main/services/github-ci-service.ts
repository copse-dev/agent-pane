import {
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_RUNNER_LONG_TIMEOUT_MS,
  truncateCommandOutput,
} from './subprocess-output-cap.ts'
import { parseGhJson, runGh } from './gh-service.ts'

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

interface GhPrView {
  state?: string
  number?: number
  title?: string
  url?: string
  headRefName?: string
  headRefOid?: string
  statusCheckRollup?: Array<{
    __typename?: string
    name?: string
    context?: string
    status?: string
    conclusion?: string
    state?: string
    detailsUrl?: string
  }>
}

interface GhPrCheckRow {
  name?: string
  state?: string
  bucket?: string
  link?: string
  workflow?: string
}

interface GhWorkflowRun {
  databaseId?: number
  headSha?: string
  conclusion?: string
  status?: string
  url?: string
  name?: string
  displayTitle?: string
}

const CHECK_BUCKET_VALUES = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel'])

export function normalizeCheckBucket(raw: string | undefined): CiCheck['bucket'] {
  const bucket = (raw ?? '').toLowerCase()
  if (CHECK_BUCKET_VALUES.has(bucket)) return bucket as CiCheck['bucket']
  return 'unknown'
}

export function rollupToCiChecks(rollup: GhPrView['statusCheckRollup']): CiCheck[] {
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

export function deriveOverallState(checks: CiCheck[]): CiOverallState {
  if (checks.length === 0) return 'no_checks'
  if (checks.some((check) => check.bucket === 'pending')) return 'pending'
  if (checks.some((check) => check.bucket === 'fail')) return 'failure'
  return 'success'
}

export function parseGhPrChecks(raw: string): CiCheck[] {
  const rows = parseGhJson<GhPrCheckRow[]>(raw)
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

async function loadOpenPr(prNumber?: number): Promise<GhPrView | null> {
  const args = [
    'pr',
    'view',
    ...prSelector(prNumber),
    '--json',
    'state,number,title,url,headRefName,headRefOid,statusCheckRollup',
  ]
  const result = await runGh(args)
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'gh pr view failed')
  }
  const pr = parseGhJson<GhPrView>(result.stdout)
  if (!pr || pr.state !== 'OPEN') return null
  return pr
}

async function loadPrChecks(prNumber?: number): Promise<CiCheck[]> {
  const args = [
    'pr',
    'checks',
    ...prSelector(prNumber),
    '--json',
    'name,state,bucket,link,workflow',
  ]
  const result = await runGh(args)
  if (result.code !== 0 && result.code !== 8) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || 'gh pr checks failed')
  }
  const parsed = parseGhPrChecks(result.stdout)
  return parsed.length > 0 ? parsed : []
}

async function loadLatestRun(
  branch: string | null,
  headSha: string | null,
): Promise<GhWorkflowRun | null> {
  if (!branch) return null
  const result = await runGh([
    'run',
    'list',
    '--branch',
    branch,
    '--limit',
    '10',
    '--json',
    'databaseId,headSha,conclusion,status,url,name,displayTitle',
  ])
  if (result.code !== 0) return null
  const runs = parseGhJson<GhWorkflowRun[]>(result.stdout)
  if (!Array.isArray(runs)) return null
  return pickLatestRunForHead(runs, headSha)
}

function buildCiStatus(
  pr: GhPrView | null,
  checks: CiCheck[],
  latestRun: GhWorkflowRun | null,
): CiStatus {
  const rollupChecks = pr ? rollupToCiChecks(pr.statusCheckRollup) : []
  const mergedChecks = checks.length > 0 ? checks : rollupChecks
  return {
    prNumber: typeof pr?.number === 'number' ? pr.number : null,
    prTitle: pr?.title?.trim() || null,
    prUrl: pr?.url ?? null,
    branch: pr?.headRefName ?? null,
    headSha: pr?.headRefOid ?? null,
    overall: deriveOverallState(mergedChecks),
    checks: mergedChecks,
    latestRunId: typeof latestRun?.databaseId === 'number' ? latestRun.databaseId : null,
    latestRunUrl: latestRun?.url ?? null,
  }
}

export async function getCiStatus(prNumber?: number): Promise<CiStatus> {
  const pr = await loadOpenPr(prNumber)
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
  const checks = await loadPrChecks(prNumber)
  const latestRun = await loadLatestRun(pr.headRefName ?? null, pr.headRefOid ?? null)
  return buildCiStatus(pr, checks, latestRun)
}

export async function waitForCiChecks(
  opts: {
    prNumber?: number | undefined
    timeoutMs?: number | undefined
    pollIntervalSec?: number | undefined
  },
  signal: AbortSignal,
): Promise<CiStatus> {
  const timeoutMs = opts.timeoutMs ?? COMMAND_RUNNER_LONG_TIMEOUT_MS
  const pollIntervalSec = opts.pollIntervalSec ?? 15
  const watchArgs = [
    'pr',
    'checks',
    ...prSelector(opts.prNumber),
    '--watch',
    '--interval',
    String(pollIntervalSec),
  ]
  const watch = await runGh(watchArgs, { timeout_ms: timeoutMs, signal })
  if (watch.code !== 0 && watch.code !== 8) {
    throw new Error(watch.stderr.trim() || watch.stdout.trim() || 'gh pr checks --watch failed')
  }
  return getCiStatus(opts.prNumber)
}

export async function getCiFailureLogs(opts: {
  prNumber?: number | undefined
  runId?: number | undefined
  maxBytes?: number | undefined
}): Promise<string> {
  const maxBytes = opts.maxBytes ?? COMMAND_OUTPUT_MAX_BYTES
  const pr = await loadOpenPr(opts.prNumber)
  if (!pr && opts.runId === undefined) {
    throw new Error('No open pull request found for this branch.')
  }

  let runId = opts.runId
  if (runId === undefined) {
    const latestRun = await loadLatestRun(pr?.headRefName ?? null, pr?.headRefOid ?? null)
    if (!latestRun?.databaseId) {
      throw new Error('No workflow run found for the pull request head commit.')
    }
    runId = latestRun.databaseId
  }

  const result = await runGh(['run', 'view', String(runId), '--log-failed'], {
    timeout_ms: COMMAND_RUNNER_LONG_TIMEOUT_MS,
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
