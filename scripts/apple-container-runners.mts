import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import {
  appleRunnerBuildCommand,
  appleRunnerName,
  appleRunnerProbeArgs,
  appleRunnerRunArgs,
  appleRunnerStopArgs,
  defaultAppleRunnerLabels,
  positiveRunnerCount,
} from './lib/apple-container-runners.mts'
import {
  normalizeContainerScriptArgs,
  resolveContainerEngine,
  type ContainerArchitecture,
  type ContainerCommand,
} from './lib/container-engine.mts'

type RunnerAction = 'run' | 'build' | 'probe' | 'status'

interface RunnerCliOptions {
  action: RunnerAction
  architecture: ContainerArchitecture
  count: number
  envFile: string
  noBuild: boolean
}

const USAGE = `Usage:
  pnpm run runners:apple -- [run] [--count N] [--arch amd64|arm64] [--no-build]
  pnpm run runners:apple -- build [--arch amd64|arm64]
  pnpm run runners:apple -- probe [--arch amd64|arm64]
  pnpm run runners:apple -- status

The run command is a foreground supervisor. It launches one clean, ephemeral
GitHub Actions runner per slot and replaces it after every job. Stop it with
Ctrl-C so each runner deregisters cleanly.

Options:
  --count N       Concurrent runners (default: APPLE_RUNNER_COUNT or 1)
  --arch ARCH     Linux guest architecture (default: amd64 for CI parity)
  --env-file PATH Runner registration environment (default: ci-runners/.env)
  --no-build      Reuse copse-ci-runner:latest
`

function optionValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  return value
}

function parseArchitecture(value: string): ContainerArchitecture {
  if (value === 'amd64' || value === 'arm64') return value
  throw new Error('--arch must be amd64 or arm64.')
}

function parseCli(rawArgs: readonly string[], env: NodeJS.ProcessEnv): RunnerCliOptions {
  const args = normalizeContainerScriptArgs(rawArgs)
  let action: RunnerAction = 'run'
  let architecture: ContainerArchitecture = 'amd64'
  let countValue = env['APPLE_RUNNER_COUNT']
  let envFile = 'ci-runners/.env'
  let noBuild = false

  let index = 0
  const first = args[0]
  if (first === 'run' || first === 'build' || first === 'probe' || first === 'status') {
    action = first
    index++
  }

  while (index < args.length) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    }
    if (arg === '--no-build') {
      noBuild = true
      index++
      continue
    }
    if (arg === '--count') {
      countValue = optionValue(args, index, '--count')
      index += 2
      continue
    }
    if (arg?.startsWith('--count=')) {
      countValue = arg.slice('--count='.length)
      index++
      continue
    }
    if (arg === '--arch') {
      architecture = parseArchitecture(optionValue(args, index, '--arch'))
      index += 2
      continue
    }
    if (arg?.startsWith('--arch=')) {
      architecture = parseArchitecture(arg.slice('--arch='.length))
      index++
      continue
    }
    if (arg === '--env-file') {
      envFile = optionValue(args, index, '--env-file')
      index += 2
      continue
    }
    if (arg?.startsWith('--env-file=')) {
      envFile = arg.slice('--env-file='.length)
      index++
      continue
    }
    throw new Error(`Unknown argument: ${String(arg)}`)
  }

  return {
    action,
    architecture,
    count: positiveRunnerCount(countValue),
    envFile: resolve(envFile),
    noBuild,
  }
}

function loadRunnerEnv(path: string): NodeJS.ProcessEnv {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}; copy ci-runners/.env.example and add runner credentials.`)
  }
  return { ...parseEnv(readFileSync(path, 'utf8')), ...process.env }
}

function nonEmptyOr(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? fallback : trimmed
}

function runSync(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdio: 'inherit' | 'ignore' = 'inherit',
): number {
  const result = spawnSync(command, args, { cwd: process.cwd(), env, stdio })
  if (result.error) throw result.error
  return result.status ?? 1
}

function runRequired(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  const status = runSync(command, args, env)
  if (status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${String(status)}.`)
  }
}

function buildRunnerImage(options: RunnerCliOptions, env: NodeJS.ProcessEnv): void {
  const command = appleRunnerBuildCommand({
    architecture: options.architecture,
    targetRepo: nonEmptyOr(env['TARGET_REPO'], 'copse-dev/agent-pane'),
    targetRef: nonEmptyOr(env['TARGET_REF'], 'main'),
    hasBuildToken: Boolean(env['BUILD_GH_TOKEN']?.trim()),
  })
  runRequired(command.command, command.args, env)
}

function probeRunnerImage(architecture: ContainerArchitecture, env: NodeJS.ProcessEnv): void {
  console.log('==> Verifying bubblewrap user namespaces before runner registration')
  runRequired('container', appleRunnerProbeArgs(architecture), env)
}

function assertSlotsFree(count: number, env: NodeJS.ProcessEnv): void {
  for (let slot = 1; slot <= count; slot++) {
    const name = appleRunnerName(slot)
    if (runSync('container', ['inspect', name], env, 'ignore') === 0) {
      throw new Error(
        `Apple container ${name} already exists. Stop the other supervisor or remove the stale container.`,
      )
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function runSlot(
  slot: number,
  args: string[],
  env: NodeJS.ProcessEnv,
  shouldStop: () => boolean,
): Promise<void> {
  let quickFailures = 0
  while (!shouldStop()) {
    const startedAt = Date.now()
    const status = await new Promise<number>((resolveStatus, reject) => {
      const child = spawn('container', args, { cwd: process.cwd(), env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('close', (code) => {
        resolveStatus(code ?? 1)
      })
    })
    if (shouldStop()) return

    const duration = Date.now() - startedAt
    quickFailures = duration < 30_000 && status !== 0 ? quickFailures + 1 : 0
    if (quickFailures >= 5) {
      throw new Error(
        `${appleRunnerName(slot)} failed quickly ${String(quickFailures)} times; refusing an unbounded restart loop.`,
      )
    }
    const backoff = quickFailures === 0 ? 250 : Math.min(2 ** quickFailures * 1_000, 30_000)
    console.log(
      `==> Runner slot ${String(slot)} exited with status ${String(status)}; restarting in ${String(backoff)}ms`,
    )
    await delay(backoff)
  }
}

async function supervise(options: RunnerCliOptions, env: NodeJS.ProcessEnv): Promise<void> {
  if (!env['GITHUB_URL']?.trim()) throw new Error('GITHUB_URL is required in the runner env file.')
  if (!env['ACCESS_TOKEN']?.trim() && !env['RUNNER_TOKEN']?.trim()) {
    throw new Error('ACCESS_TOKEN or RUNNER_TOKEN is required in the runner env file.')
  }

  if (!options.noBuild) buildRunnerImage(options, env)
  probeRunnerImage(options.architecture, env)
  assertSlotsFree(options.count, env)

  const slots = Array.from({ length: options.count }, (_, index) => index + 1)
  const labels = nonEmptyOr(
    env['APPLE_RUNNER_LABELS'],
    defaultAppleRunnerLabels(options.architecture),
  )
  const namePrefix = `${hostname().replaceAll(/[^A-Za-z0-9._-]/g, '-')}-apple-container`
  let stopping = false
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    console.log(`\n==> ${signal}: stopping Apple container runners`)
    runSync('container', appleRunnerStopArgs(slots), env, 'inherit')
  }
  process.once('SIGINT', () => {
    stop('SIGINT')
  })
  process.once('SIGTERM', () => {
    stop('SIGTERM')
  })

  console.log(
    `==> Supervising ${String(options.count)} Apple container runner(s), architecture=${options.architecture}`,
  )
  try {
    await Promise.all(
      slots.map((slot) =>
        runSlot(
          slot,
          appleRunnerRunArgs(slot, {
            architecture: options.architecture,
            envFile: options.envFile,
            labels,
            namePrefix,
          }),
          env,
          () => stopping,
        ),
      ),
    )
  } finally {
    stop('SIGTERM')
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2), process.env)
  resolveContainerEngine({
    env: { ...process.env, COPSE_CONTAINER_ENGINE: 'apple' },
  })

  if (options.action === 'status') {
    runRequired('container', ['list', '--all'], process.env)
    return
  }

  const env = loadRunnerEnv(options.envFile)
  const command: ContainerCommand | undefined =
    options.action === 'build'
      ? appleRunnerBuildCommand({
          architecture: options.architecture,
          targetRepo: nonEmptyOr(env['TARGET_REPO'], 'copse-dev/agent-pane'),
          targetRef: nonEmptyOr(env['TARGET_REF'], 'main'),
          hasBuildToken: Boolean(env['BUILD_GH_TOKEN']?.trim()),
        })
      : undefined
  if (command !== undefined) {
    runRequired(command.command, command.args, env)
    return
  }
  if (options.action === 'probe') {
    probeRunnerImage(options.architecture, env)
    return
  }
  await supervise(options, env)
}

main().catch((error: unknown) => {
  console.error(`runners:apple: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
