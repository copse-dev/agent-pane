/** Trusted main-only workflow: archive generated measurement, never execute downloaded data. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { safeJsonParse, decodeWithSchema } from './lib/safe-json.mts'
import { gateManifestSchema, buildGateReport } from './lib/gate-report.mts'
const directory = process.argv[2]
if (!directory) throw new Error('Usage: node scripts/archive-gate-report.mts <directory>')
const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}
const run = required('GITHUB_RUN_ID'),
  attempt = required('GITHUB_RUN_ATTEMPT')
if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw new Error('Invalid archive run')
const collectionOutcome = required('COLLECTION_OUTCOME')
if (!['success', 'failure', 'cancelled'].includes(collectionOutcome))
  throw new Error('Invalid collection outcome')
const manifestText = readFileSync(join(directory, 'manifest.json'), 'utf8')
const manifest = safeJsonParse(manifestText, decodeWithSchema(gateManifestSchema))
if (!manifest || manifest.length > 1000) throw new Error('Invalid manifest')
for (const entry of manifest)
  if (entry.record && entry.record !== `${entry.runId}-${entry.attempt}.json`)
    throw new Error('Unexpected record path')
const report = buildGateReport(manifestText, (path) => readFileSync(join(directory, path), 'utf8'))
const bytes =
  JSON.stringify({
    version: 1,
    sourceRun: run,
    sourceAttempt: attempt,
    collectionOutcome,
    manifest,
    report,
  }) + '\n'
const digest = createHash('sha256').update(bytes).digest('hex')
const key = `ci-reports/v1/${run}/${attempt}/${digest}.json`
const account = required('SCREENSHOT_R2_ACCOUNT_ID')
if (!/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid R2 account')
const bucket = required('SCREENSHOT_R2_BUCKET')
const root = mkdtempSync(join(tmpdir(), 'gate-report-archive-'))
const body = join(root, 'report.json'),
  fetched = join(root, 'verified.json')
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
    {
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: required('SCREENSHOT_R2_ACCESS_KEY_ID'),
        AWS_SECRET_ACCESS_KEY: required('SCREENSHOT_R2_SECRET_ACCESS_KEY'),
        AWS_SESSION_TOKEN: '',
        AWS_PAGER: '',
      },
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
try {
  writeFileSync(body, bytes)
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
    throw new Error('Archive read-back digest mismatch')
  const url = `${required('SCREENSHOT_R2_PUBLIC_URL').replace(/\/$/, '')}/${key}`
  writeFileSync(
    join(directory, 'archive.json'),
    JSON.stringify({ url, digest, collectionOutcome }) + '\n',
  )
  writeFileSync(join(directory, 'bundle.json'), bytes)
  const summary = `### Gate shadow report\n\nCollection: ${collectionOutcome}. Candidate runs: ${String(report.totals.runs)}. Complete full replays: ${String(report.totals.completeFullReplays)}. Missing: ${String(report.totals.missing)}. Invalid: ${String(report.totals.invalid)}. Incomplete: ${String(report.totals.incomplete)}. Excluded: ${String(report.totals.excluded)}. Known real misses: ${String(report.totals.knownMissedRealFailures)}.\n\nGate change ready: false. [Durable report and manifest](${url}). Original record keys are derivable from each manifest run/attempt/digest. Actions retention may be capped at five days; this archive survives that expiry.\n`
  if (process.env['GITHUB_STEP_SUMMARY'])
    appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary)
  console.log(summary)
} finally {
  rmSync(root, { recursive: true, force: true })
}
