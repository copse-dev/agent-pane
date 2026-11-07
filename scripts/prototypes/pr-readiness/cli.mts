import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { parseArgs, promisify } from 'node:util'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { isDirectExecution } from '../../lib/direct-execution.mts'
import { assessPrReadiness, readinessSnapshotSchema, type ReadinessSnapshot } from './model.mts'
import { observePrReadiness, READINESS_QUERY, type ReadPrEvidence } from './observe.mts'
import { z } from 'zod'

const exec = promisify(execFile)
const readGitHub: ReadPrEvidence = async ({ repository, number }) => {
  const [owner, repo] = repository.split('/')
  const { stdout } = await exec(
    'gh',
    [
      'api',
      'graphql',
      '--hostname',
      'github.com',
      '-f',
      `query=${READINESS_QUERY}`,
      '-f',
      `owner=${owner ?? ''}`,
      '-f',
      `repo=${repo ?? ''}`,
      '-F',
      `number=${String(number)}`,
    ],
    { timeout: 30_000, maxBuffer: 512 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
  )
  return safeJsonParse(stdout, decodeWithSchema(z.unknown()))
}

export async function runReadinessCli(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      snapshot: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(
      'Read-only PR readiness prototype\n  --repo owner/repo --pr N\n  --snapshot file.json\nPrints snapshot and decision as JSON. Exit 0: declared evidence ready; 2: not ready; 1: read/input error. Live reads leave local acceptance unknown and never authorize a write.',
    )
    return 0
  }
  if (values.snapshot && (values.repo || values.pr))
    throw new Error('Choose a snapshot or a repository/PR, not both.')
  let snapshot: ReadinessSnapshot
  if (values.snapshot) {
    if ((await stat(values.snapshot)).size > 2 * 1024 * 1024)
      throw new Error('Snapshot exceeds 2 MiB.')
    const decoded = safeJsonParse(
      await readFile(values.snapshot, 'utf8'),
      decodeWithSchema(readinessSnapshotSchema),
    )
    if (!decoded) throw new Error('Invalid readiness snapshot.')
    snapshot = decoded
  } else {
    if (
      !values.repo ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repo) ||
      !values.pr ||
      !/^[1-9][0-9]*$/.test(values.pr) ||
      !Number.isSafeInteger(Number(values.pr))
    )
      throw new Error('Supply --repo owner/repo and --pr N, or --snapshot file.json.')
    snapshot = await observePrReadiness(
      { repository: values.repo, number: Number(values.pr) },
      readGitHub,
    )
  }
  const decision = assessPrReadiness(snapshot, Date.now())
  console.log(JSON.stringify({ snapshot, decision }, null, 2))
  return decision.state === 'ready' ? 0 : 2
}

if (isDirectExecution(import.meta.url, 'cli')) {
  runReadinessCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch(() => {
      // Do not echo child-process errors: they can include untrusted response bodies.
      console.error(
        'PR readiness could not be read. Check arguments, GitHub access and snapshot format; no readiness verdict was established.',
      )
      process.exitCode = 1
    })
}
