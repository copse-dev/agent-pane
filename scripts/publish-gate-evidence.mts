/** Trusted workflow_run entry point. Artifacts are data; never import their code. */
import {
  existsSync,
  readdirSync,
  readFileSync,
  lstatSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { parseGatePlan, parseOutcome, compareOutcomes } from './lib/gate-evidence.mts'

const env = process.env
function required(name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const run = required('SOURCE_RUN_ID'),
  attempt = required('SOURCE_RUN_ATTEMPT')
if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw new Error('Invalid source run')
const directory = process.argv[2] ?? 'incoming'
const files: string[] = []
function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name),
      stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('Symlink in evidence')
    if (stat.isDirectory()) walk(path)
    else {
      if (!name.endsWith('.json') || stat.size > 2_000_000 || files.length >= 5000)
        throw new Error('Unexpected evidence file')
      files.push(path)
    }
  }
}
// download-artifact does not create the directory when no artifacts match.
if (existsSync(directory)) walk(directory)
if (
  files.length === 0 &&
  (env['SOURCE_CONCLUSION'] === 'cancelled' || env['SOURCE_CONCLUSION'] === 'failure')
) {
  const text = `Shadow unavailable; ${env['SOURCE_CONCLUSION']} CI run produced no evidence artifacts. No successful replay is recorded.`
  writeFileSync('gate-publication.json', JSON.stringify({ text, count: 0, shadowAvailable: false }))
  console.log(text)
  process.exit(0)
}
// Preserve earlier artifacts for audit, but only the current workflow attempt
// can establish complete coverage; reused jobs cannot prove rerun execution.
const plans = files.filter(
  (path) => path.endsWith('/plan.json') || path.endsWith('/selected-plan.json'),
)
const candidates = plans
  .map((path) => ({ path, plan: parseGatePlan(readFileSync(path, 'utf8')) }))
  .filter(({ plan }) => Number(plan.runAttempt) <= Number(attempt))
  .sort(
    (a, b) =>
      Number(b.plan.runAttempt) - Number(a.plan.runAttempt) ||
      Number(a.plan.shadowAvailable === false) - Number(b.plan.shadowAvailable === false),
  )
const plan = candidates[0]?.plan
if (!plan) throw new Error('Missing selected CI plan')
if (plan.runId !== run || (plan.head ?? plan.commit) !== required('SOURCE_HEAD_SHA'))
  throw new Error('Plan provenance mismatch')
const outcomes = files
  .filter((path) => !plans.includes(path))
  .map((path) => parseOutcome(readFileSync(path, 'utf8')))
  .filter((row) => Number(row.runAttempt) <= Number(attempt))
for (const row of outcomes) {
  if (row.runId !== run || row.commit !== plan.commit || !plan.actual.specs.includes(row.spec))
    throw new Error('Outcome provenance mismatch')
}
const seen = new Set<string>()
for (const row of outcomes) {
  const key = `${row.spec}:${row.runAttempt}:${String(row.attempt)}`
  if (seen.has(key)) throw new Error('Duplicate outcome')
  seen.add(key)
}
const comparison = compareOutcomes(plan, outcomes, [], Number(attempt))
const record =
  JSON.stringify({
    version: 1,
    sourceRun: run,
    sourceAttempt: attempt,
    sourceConclusion: env['SOURCE_CONCLUSION'],
    plan,
    outcomes,
    comparison,
    trust: 'Source artifacts are observations, not release attestation.',
  }) + '\n'
const digest = createHash('sha256').update(record).digest('hex')
const key = `ci-evidence/v1/${run}/${attempt}/${digest}.json`
const account = required('SCREENSHOT_R2_ACCOUNT_ID')
if (!/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid R2 account')
const staging = mkdtempSync(join(tmpdir(), 'gate-evidence-'))
const body = join(staging, 'record.json'),
  fetched = join(staging, 'verified.json')
const awsEnv = {
  ...env,
  AWS_ACCESS_KEY_ID: required('SCREENSHOT_R2_ACCESS_KEY_ID'),
  AWS_SECRET_ACCESS_KEY: required('SCREENSHOT_R2_SECRET_ACCESS_KEY'),
  AWS_SESSION_TOKEN: '',
  AWS_PAGER: '',
}
const aws = (args: string[]): Buffer =>
  execFileSync(
    'aws',
    [
      '--endpoint-url',
      `https://${account}.r2.cloudflarestorage.com`,
      '--region',
      'auto',
      's3api',
      ...args,
    ],
    { env: awsEnv, timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'] },
  )
try {
  writeFileSync(body, record)
  const bucket = required('SCREENSHOT_R2_BUCKET')
  try {
    aws([
      'put-object',
      '--bucket',
      bucket,
      '--key',
      key,
      '--body',
      body,
      '--content-type',
      'application/json',
      '--cache-control',
      'public, max-age=31536000, immutable',
      '--if-none-match',
      '*',
    ])
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('PreconditionFailed')) throw error
  }
  aws(['get-object', '--bucket', bucket, '--key', key, fetched])
  if (createHash('sha256').update(readFileSync(fetched)).digest('hex') !== digest)
    throw new Error('R2 integrity mismatch')
  const url = `${required('SCREENSHOT_R2_PUBLIC_URL').replace(/\/$/, '')}/${key}`
  const text =
    plan.shadowAvailable === false
      ? `Shadow unavailable; actual CI plan preserved. Incomplete specs: ${String(comparison.incomplete.length)}. Evidence: ${url}`
      : `Would run ${String(plan.proposed.count)} specs on ${String(plan.proposed.shards)} shards; actual ${plan.actual.mode}. Estimated spec minutes saved: ${plan.estimate.savedSpecMinutes.toFixed(1)}. Unclassified failures: ${String(comparison.unclassified.length)}; incomplete specs: ${String(comparison.incomplete.length)}. No real-failure miss rate is established without classifications. Evidence: ${url}`
  writeFileSync(
    'gate-publication.json',
    JSON.stringify({
      url,
      text,
      count: plan.proposed.count,
      shadowAvailable: plan.shadowAvailable !== false,
    }),
  )
  console.log(text)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
