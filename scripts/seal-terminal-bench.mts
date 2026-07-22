import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { glob, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { c as createTar } from 'tar'
import { terminalBenchTrialOutcome } from './lib/terminal-bench-outcome.mts'
import {
  TERMINAL_BENCH_DATASET_DESCRIPTOR,
  terminalBenchCanonicalTaskName,
  terminalBenchTaskMetadata,
} from './lib/terminal-bench-tasks.mts'
import { terminalBenchProfile } from './lib/terminal-bench-profiles.mts'

const RESULTS_ROOT = resolve('bench-results/terminal-bench')
const CAPSULES_ROOT = resolve('bench-results/terminal-bench-capsules')
const SECRET_ENV_NAMES = [
  'SCW_GENERATIVE_API_KEY',
  'LM_STUDIO_API_KEY',
  'LM_API_TOKEN',
  'BENCH_ANALYST_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'SCW_OBJECT_STORAGE_SECRET_KEY',
]

interface FileManifest {
  path: string
  bytes: number
  sha256: string
}

function nested(value: unknown, ...keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, key)
  }
  return current
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const code = (value as Record<string, unknown>)['code']
  return typeof code === 'string' ? code : undefined
}

function git(args: readonly string[]): string {
  try {
    // stderr is ignored so that running outside a git checkout (e.g. the
    // worker image, where sources are COPYed rather than cloned) records
    // 'unavailable' quietly instead of leaking git's error text and usage.
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unavailable'
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function trialId(resultPath: string, result: unknown): string {
  const namespace = process.env['COPSE_BENCH_RUN_ID']?.trim() || 'local'
  const identity = JSON.stringify({
    namespace,
    path: relative(RESULTS_ROOT, resultPath),
    task: nested(result, 'task_name'),
    startedAt: nested(result, 'started_at'),
  })
  return `${namespace}-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`
}

function secretValues(): Array<{ name: string; value: Buffer }> {
  return SECRET_ENV_NAMES.flatMap((name) => {
    const value = process.env[name]
    return value && value.length >= 12 ? [{ name, value: Buffer.from(value) }] : []
  })
}

async function assertNoKnownSecrets(
  path: string,
  secrets: ReturnType<typeof secretValues>,
): Promise<void> {
  if (secrets.length === 0) return
  const contents = await readFile(path)
  const leaked = secrets.find(({ value }) => contents.includes(value))
  if (leaked) {
    throw new Error(
      `Refusing to seal ${relative(process.cwd(), path)} because it contains ${leaked.name}.`,
    )
  }
}

async function trialFiles(directory: string): Promise<FileManifest[]> {
  const files: FileManifest[] = []
  const secrets = secretValues()
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      const info = await lstat(path)
      if (!info.isFile()) continue
      await assertNoKnownSecrets(path, secrets)
      files.push({
        path: relative(directory, path),
        bytes: info.size,
        sha256: await sha256File(path),
      })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function safeName(value: unknown): string {
  const text = typeof value === 'string' ? value : 'unknown-task'
  return text.replaceAll(/[^a-zA-Z0-9._-]+/g, '-').replaceAll(/^-|-$/g, '') || 'unknown-task'
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function elapsedSeconds(startedAt: unknown, finishedAt: unknown): number | null {
  if (typeof startedAt !== 'string' || typeof finishedAt !== 'string') return null
  const started = Date.parse(startedAt)
  const finished = Date.parse(finishedAt)
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, (finished - started) / 1_000)
    : null
}

interface StoredTrial {
  resultPath: string
  result: unknown
}

const storedTrials: StoredTrial[] = []
for await (const resultPath of glob(join(RESULTS_ROOT, '*/*/result.json'))) {
  try {
    storedTrials.push({ resultPath, result: JSON.parse(await readFile(resultPath, 'utf8')) })
  } catch (error) {
    console.warn(`bench:terminal:seal: ignoring unreadable result ${resultPath}: ${String(error)}`)
  }
}
storedTrials.sort((a, b) => {
  const taskDifference = String(nested(a.result, 'task_name')).localeCompare(
    String(nested(b.result, 'task_name')),
  )
  if (taskDifference !== 0) return taskDifference
  const timeDifference = String(nested(a.result, 'started_at')).localeCompare(
    String(nested(b.result, 'started_at')),
  )
  return timeDifference || a.resultPath.localeCompare(b.resultPath)
})

await mkdir(CAPSULES_ROOT, { recursive: true })
const capsules: Array<{
  trialId: string
  taskName: string
  archive: string
  bytes: number
  sha256: string
  startedAt: string | null
  outcome: ReturnType<typeof terminalBenchTrialOutcome>
  attemptIndex: number
  profile: string
  profileHash: string
}> = []
const attemptsByTask = new Map<string, number>()

for (const { resultPath, result } of storedTrials) {
  const directory = dirname(resultPath)
  const id = trialId(resultPath, result)
  const rawTaskName = nested(result, 'task_name')
  const taskName =
    typeof rawTaskName === 'string' && rawTaskName
      ? terminalBenchCanonicalTaskName(rawTaskName)
      : 'unknown-task'
  const taskMetadata = terminalBenchTaskMetadata(taskName)
  const attemptIndex = (attemptsByTask.get(taskName) ?? 0) + 1
  attemptsByTask.set(taskName, attemptIndex)
  const rawStartedAt = nested(result, 'started_at')
  const startedAt = typeof rawStartedAt === 'string' && rawStartedAt ? rawStartedAt : null
  const rawReward = nested(result, 'verifier_result', 'rewards', 'reward')
  const reward = typeof rawReward === 'number' && Number.isFinite(rawReward) ? rawReward : undefined
  const rawExceptionType = nested(result, 'exception_info', 'exception_type')
  const exceptionType =
    typeof rawExceptionType === 'string' && rawExceptionType ? rawExceptionType : undefined
  const outcome = terminalBenchTrialOutcome({ reward, exceptionType })
  const rawProfile = nested(result, 'agent_result', 'metadata', 'profile')
  const profile = terminalBenchProfile(
    typeof rawProfile === 'string' ? rawProfile.replace(/@1$/, '') : undefined,
  )
  const recordedProfileHash = nested(result, 'agent_result', 'metadata', 'profile_hash')
  if (recordedProfileHash !== profile.contentHash) {
    throw new Error(`Missing or inconsistent profile hash for ${taskName}.`)
  }
  const manifestPath = join(directory, 'run-manifest.json')
  const imageMetadataPath = join(directory, 'task-image.json')
  let imageMetadata: unknown
  try {
    imageMetadata = JSON.parse(await readFile(imageMetadataPath, 'utf8'))
  } catch (error) {
    throw new Error(`Missing or invalid task image metadata for ${taskName}: ${String(error)}`, {
      cause: error,
    })
  }
  if (
    nested(imageMetadata, 'datasetId') !== TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId ||
    nested(imageMetadata, 'datasetRevision') !==
      TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision ||
    nested(imageMetadata, 'reference') !== taskMetadata.image ||
    nested(imageMetadata, 'taskConfigSha256') !== taskMetadata.configSha256
  ) {
    throw new Error(`Task image metadata does not match the pinned descriptor for ${taskName}.`)
  }
  const imageId = nested(imageMetadata, 'imageId')
  const repoDigests = nested(imageMetadata, 'repoDigests')
  if (
    typeof imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !Array.isArray(repoDigests) ||
    repoDigests.length === 0 ||
    repoDigests.some(
      (digest) => typeof digest !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(digest),
    )
  ) {
    throw new Error(`Task image metadata lacks an immutable digest for ${taskName}.`)
  }
  const rawStarted = nested(result, 'started_at')
  const rawFinished = nested(result, 'finished_at')
  const manifest = {
    schemaVersion: 2,
    trialId: id,
    suiteRunId: process.env['COPSE_BENCH_RUN_ID']?.trim() || 'local',
    createdAt: new Date().toISOString(),
    task: {
      name: taskName,
      attemptIndex,
      startedAt: rawStarted ?? null,
      finishedAt: rawFinished ?? null,
      reward: nested(result, 'verifier_result', 'rewards', 'reward') ?? null,
      exception: nested(result, 'exception_info') ?? null,
    },
    model: process.env['LM_STUDIO_MODEL']?.trim() || nested(result, 'config', 'model') || null,
    dataset: {
      id: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetId,
      version: TERMINAL_BENCH_DATASET_DESCRIPTOR.datasetVersion,
      revision: TERMINAL_BENCH_DATASET_DESCRIPTOR.upstreamRevision,
      taskConfigSha256: taskMetadata.configSha256,
      harborTaskChecksum: nested(result, 'task_checksum') ?? null,
      imageReference: taskMetadata.image,
      imageId,
      imageDigest: String(repoDigests[0]).slice(String(repoDigests[0]).indexOf('@') + 1),
      imageDigests: repoDigests,
    },
    profile: {
      id: profile.id,
      versionedId: profile.versionedId,
      contentHash: profile.contentHash,
    },
    source: {
      repository: process.env['GITHUB_REPOSITORY']?.trim() || null,
      commit: process.env['GITHUB_SHA']?.trim() || git(['rev-parse', 'HEAD']),
      ref: process.env['GITHUB_REF']?.trim() || git(['branch', '--show-current']),
      status: git(['status', '--short']),
    },
    configuration: {
      maxSteps: process.env['COPSE_TERMINAL_MAX_STEPS']?.trim() || '80',
      maxLlmCalls: process.env['COPSE_TERMINAL_MAX_LLM_CALLS']?.trim() || 'maxSteps+3',
      contextTokens: process.env['COPSE_TERMINAL_CONTEXT_TOKENS']?.trim() || '32768',
      maxStreamOutputTokens:
        process.env['COPSE_TERMINAL_MAX_STREAM_OUTPUT_TOKENS']?.trim() || '2048',
      commandTimeoutSeconds: process.env['COPSE_TERMINAL_COMMAND_TIMEOUT_SEC']?.trim() || '120',
      maxCommandTimeoutSeconds:
        process.env['COPSE_TERMINAL_MAX_COMMAND_TIMEOUT_SEC']?.trim() || '600',
    },
    metrics: {
      elapsedSeconds: elapsedSeconds(rawStarted, rawFinished),
      inputTokens: finiteNumber(nested(result, 'agent_result', 'n_input_tokens')),
      outputTokens: finiteNumber(nested(result, 'agent_result', 'n_output_tokens')),
      toolCalls: finiteNumber(nested(result, 'agent_result', 'metadata', 'tool_calls')),
      modelRequests: finiteNumber(nested(result, 'agent_result', 'metadata', 'model_requests')),
      commandTimeouts: finiteNumber(nested(result, 'agent_result', 'metadata', 'command_timeouts')),
    },
    lineage: {
      parentTrialId: nested(result, 'agent_result', 'metadata', 'parent_trial_id') ?? null,
      interventionId: nested(result, 'agent_result', 'metadata', 'intervention_id') ?? null,
    },
    files: await trialFiles(directory),
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const archiveName = `${safeName(taskName)}-${id}.tar.gz`
  const archivePath = join(CAPSULES_ROOT, archiveName)
  await createTar({ cwd: directory, file: archivePath, gzip: true, portable: true }, ['.'])
  const archiveInfo = await lstat(archivePath)
  capsules.push({
    trialId: id,
    taskName,
    archive: basename(archivePath),
    bytes: archiveInfo.size,
    sha256: await sha256File(archivePath),
    startedAt,
    outcome,
    attemptIndex,
    profile: profile.versionedId,
    profileHash: profile.contentHash,
  })
  console.log(
    `bench:terminal:seal ${relative(process.cwd(), directory)} -> ${archiveName} (${String(archiveInfo.size)} bytes)`,
  )
}

const sourcePatch = git(['diff', '--binary', 'HEAD'])
const sourcePatchPath = join(CAPSULES_ROOT, 'source.patch')
await writeFile(sourcePatchPath, sourcePatch)
await assertNoKnownSecrets(sourcePatchPath, secretValues())
const sourceAnalysisPlan = resolve('bench-results/terminal-bench-analysis-plan.json')
let analysisPlan: string | null = null
try {
  const contents = await readFile(sourceAnalysisPlan)
  const target = join(CAPSULES_ROOT, 'analysis-plan.json')
  await writeFile(target, contents)
  await assertNoKnownSecrets(target, secretValues())
  analysisPlan = 'analysis-plan.json'
} catch (error) {
  if (errorCode(error) !== 'ENOENT') throw error
}
const index = {
  schemaVersion: 2,
  suiteRunId: process.env['COPSE_BENCH_RUN_ID']?.trim() || 'local',
  createdAt: new Date().toISOString(),
  source: {
    repository: process.env['GITHUB_REPOSITORY']?.trim() || null,
    commit: process.env['GITHUB_SHA']?.trim() || git(['rev-parse', 'HEAD']),
    ref: process.env['GITHUB_REF']?.trim() || git(['branch', '--show-current']),
    patch: 'source.patch',
  },
  analysisPlan,
  profiles: [
    ...new Map(
      capsules.map((capsule) => [
        capsule.profile,
        { versionedId: capsule.profile, contentHash: capsule.profileHash },
      ]),
    ).values(),
  ],
  capsules,
}
await writeFile(join(CAPSULES_ROOT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
console.log(`bench:terminal:seal wrote ${String(capsules.length)} capsule(s) to ${CAPSULES_ROOT}`)
