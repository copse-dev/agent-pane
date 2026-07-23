import { spawn, spawnSync } from 'node:child_process'
import { glob, readFile, statfs } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  inspectTerminalBenchTaskImage,
  recordTerminalBenchTaskImage,
} from './lib/terminal-bench-task-image.mts'
import {
  TERMINAL_BENCH_TASK_NAMES,
  terminalBenchCanonicalTaskName,
  terminalBenchTaskImage,
} from './lib/terminal-bench-tasks.mts'
import {
  parseTerminalBenchProfileIds,
  rotateTerminalBenchProfiles,
} from './lib/terminal-bench-profiles.mts'
import {
  terminalBenchCompletedTaskNames,
  terminalBenchDiskSpaceError,
  terminalBenchPrefetchMinimumFreeDiskBytes,
  terminalBenchRequestedTaskNames,
  terminalBenchShardEntries,
} from './lib/terminal-bench.mts'

interface StoredResult {
  path: string
  value: unknown
}

const MAX_CONSECUTIVE_FULLY_INVALID_TASKS = 3

async function storedResults(): Promise<StoredResult[]> {
  const results: StoredResult[] = []
  for await (const path of glob('bench-results/terminal-bench/*/*/result.json')) {
    try {
      results.push({ path, value: JSON.parse(await readFile(path, 'utf8')) })
    } catch (error) {
      console.warn(`bench:terminal:suite: ignoring unreadable result ${path}: ${String(error)}`)
    }
  }
  return results
}

function resultTaskName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('task_name' in value)) return undefined
  return typeof value.task_name === 'string'
    ? terminalBenchCanonicalTaskName(value.task_name)
    : undefined
}

function parseMaxTasks(args: readonly string[]): number | undefined {
  const raw = args.find((arg) => arg.startsWith('--max-tasks='))?.slice('--max-tasks='.length)
  if (raw === undefined) return undefined
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--max-tasks must be a positive integer, received '${raw}'`)
  }
  return parsed
}

function parsePositiveFlag(args: readonly string[], name: string, fallback: number): number {
  const raw = args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, received '${raw}'`)
  }
  return parsed
}

function parseNonNegativeFlag(args: readonly string[], name: string, fallback: number): number {
  const raw = args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received '${raw}'`)
  }
  return parsed
}

const rawArgs = process.argv.slice(2)
if (
  rawArgs.some(
    (arg) =>
      arg === '--all' ||
      arg === '--include-task-name' ||
      arg.startsWith('--include-task-name=') ||
      arg === '--exclude-task-name' ||
      arg.startsWith('--exclude-task-name='),
  )
) {
  throw new Error('The suite owns task selection; do not pass task include/exclude flags or --all.')
}
const resume = rawArgs.includes('--resume')
const pruneImages = rawArgs.includes('--prune-images')
const prefetchImages = rawArgs.includes('--prefetch-images')
const checkpointAfterTask = rawArgs.includes('--checkpoint-after-task')
const maxTasks = parseMaxTasks(rawArgs)
const requestedTaskNames = terminalBenchRequestedTaskNames(
  rawArgs.find((arg) => arg.startsWith('--task-names='))?.slice('--task-names='.length),
)
const shardCount = parsePositiveFlag(rawArgs, '--shard-count', 1)
const shardIndex = parseNonNegativeFlag(rawArgs, '--shard-index', 0)
const profilesFlag = rawArgs
  .find((arg) => arg.startsWith('--profiles='))
  ?.slice('--profiles='.length)
const profileFlags = rawArgs
  .filter((arg) => arg.startsWith('--profile='))
  .map((arg) => arg.slice('--profile='.length))
if (profileFlags.length > 1 || (profilesFlag !== undefined && profileFlags.length > 0)) {
  throw new Error('Pass either --profiles=<ids> or one --profile=<id>, not both.')
}
const profiles = parseTerminalBenchProfileIds(
  profilesFlag ??
    profileFlags[0] ??
    process.env['COPSE_TERMINAL_PROFILES'] ??
    process.env['COPSE_TERMINAL_PROFILE'],
)
const harborArgs = rawArgs.filter(
  (arg) =>
    arg !== '--resume' &&
    arg !== '--prune-images' &&
    arg !== '--prefetch-images' &&
    arg !== '--checkpoint-after-task' &&
    !arg.startsWith('--max-tasks=') &&
    !arg.startsWith('--task-names=') &&
    !arg.startsWith('--shard-count=') &&
    !arg.startsWith('--shard-index=') &&
    !arg.startsWith('--profiles=') &&
    !arg.startsWith('--profile='),
)
const beforeSuite = await storedResults()
const completed = new Set(
  resume ? terminalBenchCompletedTaskNames(beforeSuite.map((r) => r.value)) : [],
)
const selected = requestedTaskNames ?? TERMINAL_BENCH_TASK_NAMES
const pending = terminalBenchShardEntries(selected, maxTasks, shardCount, shardIndex).filter(
  (entry) => !completed.has(entry.value),
)

console.log(
  `bench:terminal:suite tasks=${String(pending.length)} completed=${String(completed.size)} ` +
    `shard=${String(shardIndex + 1)}/${String(shardCount)} ` +
    `profiles=${profiles.join(',')} attempts=harbor ` +
    `pruneImages=${String(pruneImages)} prefetchImages=${String(prefetchImages)} ` +
    `checkpointAfterTask=${String(checkpointAfterTask)}`,
)

let suiteFailed = false
let consecutiveFullyInvalidTasks = 0
for (const [index, entry] of pending.entries()) {
  const taskName = entry.value
  const taskProfiles = rotateTerminalBenchProfiles(profiles, entry.globalIndex)
  console.log(
    `\nbench:terminal:suite [${String(index + 1)}/${String(pending.length)}] ${taskName} ` +
      `profiles=${taskProfiles.join(',')}`,
  )
  let taskProducedValidResult = false
  const stats = await statfs(process.cwd())
  const diskError = terminalBenchDiskSpaceError(stats.bavail * stats.bsize)
  if (diskError) {
    console.error(`bench:terminal:suite: refusing to prepare ${taskName}: ${diskError}`)
    process.exit(1)
  }
  const currentImage = terminalBenchTaskImage(taskName)
  const currentPresent =
    spawnSync('docker', ['image', 'inspect', currentImage], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'ignore',
    }).status === 0
  if (!currentPresent) {
    console.log(`bench:terminal:suite preparing ${currentImage}`)
    const pull = spawnSync('docker', ['image', 'pull', currentImage], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    })
    if (pull.error || pull.status !== 0) {
      const detail = pull.error?.message ?? `docker exited ${String(pull.status)}`
      console.error(`bench:terminal:suite: unable to prepare ${currentImage}: ${detail}`)
      process.exit(1)
    }
  }
  inspectTerminalBenchTaskImage(taskName)
  const nextTaskName = pending[index + 1]?.value
  let prefetchDone: Promise<void> | undefined
  if (prefetchImages && nextTaskName !== undefined) {
    const stats = await statfs(process.cwd())
    const availableBytes = stats.bavail * stats.bsize
    const requiredBytes = terminalBenchPrefetchMinimumFreeDiskBytes()
    const nextImage = terminalBenchTaskImage(nextTaskName)
    const alreadyPresent =
      spawnSync('docker', ['image', 'inspect', nextImage], {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'ignore',
      }).status === 0
    if (alreadyPresent) {
      console.log(`bench:terminal:suite prefetch already present ${nextImage}`)
    } else if (availableBytes < requiredBytes) {
      console.warn(
        `bench:terminal:suite skipping prefetch for ${nextImage}: ` +
          `${(availableBytes / 1024 ** 3).toFixed(1)} GiB free, ` +
          `${(requiredBytes / 1024 ** 3).toFixed(1)} GiB required`,
      )
    } else {
      console.log(`bench:terminal:suite prefetching ${nextImage}`)
      const pull = spawn('docker', ['image', 'pull', nextImage], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let outputTail = ''
      const captureOutput = (chunk: string | Buffer): void => {
        outputTail = `${outputTail}${String(chunk)}`.slice(-8_000)
      }
      pull.stdout.on('data', captureOutput)
      pull.stderr.on('data', captureOutput)
      prefetchDone = new Promise((finish) => {
        let finished = false
        const complete = (): void => {
          if (finished) return
          finished = true
          finish()
        }
        pull.once('error', (error) => {
          console.warn(`bench:terminal:suite prefetch failed for ${nextImage}: ${error.message}`)
          complete()
        })
        pull.once('close', (code) => {
          if (code !== 0) {
            console.warn(
              `bench:terminal:suite prefetch failed for ${nextImage}: docker exited ${String(code)}\n${outputTail.trim()}`,
            )
          } else {
            console.log(`bench:terminal:suite prefetched ${nextImage}`)
          }
          complete()
        })
      })
    }
  }
  for (const [profileIndex, profile] of taskProfiles.entries()) {
    console.log(
      `bench:terminal:suite ${taskName} profile ${String(profileIndex + 1)}/${String(taskProfiles.length)} ${profile}`,
    )
    const beforeProfilePaths = new Set(
      (await storedResults())
        .filter((result) => resultTaskName(result.value) === taskName)
        .map((result) => result.path),
    )
    const run = spawnSync(
      process.execPath,
      [
        resolve('scripts/run-terminal-bench.mts'),
        '--include-task-name',
        taskName,
        `--profile=${profile}`,
        ...harborArgs,
      ],
      { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
    )
    const newProfileResults = (await storedResults()).filter(
      (result) => resultTaskName(result.value) === taskName && !beforeProfilePaths.has(result.path),
    )
    if (run.error || run.status !== 0) {
      const detail = run.error?.message ?? `child exited ${String(run.status)}`
      console.error(`bench:terminal:suite: ${taskName}/${profile} launcher failed: ${detail}`)
      suiteFailed = true
    }
    if (newProfileResults.length === 0) {
      console.error(`bench:terminal:suite: ${taskName}/${profile} wrote no new trial result`)
      suiteFailed = true
      continue
    }
    const invalidResults = newProfileResults.filter(
      (result) => !terminalBenchCompletedTaskNames([result.value]).includes(taskName),
    )
    if (invalidResults.length < newProfileResults.length) taskProducedValidResult = true
    if (invalidResults.length > 0) {
      console.error(
        `bench:terminal:suite: ${taskName}/${profile} produced ` +
          `${String(invalidResults.length)} infrastructure-invalid result(s); continuing the paired cohort`,
      )
      suiteFailed = true
    }
  }
  // Reap the one-ahead pull before any exit path so an invalid current task
  // cannot leave an untracked Docker CLI child behind.
  await prefetchDone
  const taskResults = (await storedResults()).filter(
    (result) => resultTaskName(result.value) === taskName,
  )
  for (const result of taskResults) await recordTerminalBenchTaskImage(taskName, result.path)
  if (checkpointAfterTask) {
    const checkpoint = spawnSync(
      'bash',
      [resolve('benchmarks/terminal_bench/checkpoint-results.sh'), `task ${taskName}`],
      { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
    )
    if (checkpoint.error || checkpoint.status !== 0) {
      const detail = checkpoint.error?.message ?? `checkpoint exited ${String(checkpoint.status)}`
      console.error(`bench:terminal:suite: unable to checkpoint ${taskName}: ${detail}`)
      suiteFailed = true
    }
  }
  if (pruneImages) {
    const image = terminalBenchTaskImage(taskName)
    const prune = spawnSync('docker', ['image', 'rm', image], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    })
    if (prune.error || prune.status !== 0) {
      console.warn(`bench:terminal:suite: unable to remove completed task image ${image}`)
    }
  }
  consecutiveFullyInvalidTasks = taskProducedValidResult ? 0 : consecutiveFullyInvalidTasks + 1
  if (consecutiveFullyInvalidTasks >= MAX_CONSECUTIVE_FULLY_INVALID_TASKS) {
    console.error(
      `bench:terminal:suite: stopping after ${String(consecutiveFullyInvalidTasks)} consecutive ` +
        'task blocks without a valid result; the worker is likely unhealthy',
    )
    break
  }
}

if (suiteFailed) process.exitCode = 1
