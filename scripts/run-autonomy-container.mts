import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { autonomyContainerRunArgs } from './lib/autonomy-container.mts'
import {
  containerBuildCommand,
  normalizeContainerScriptArgs,
  resolveContainerEngine,
} from './lib/container-engine.mts'

const IMAGE = 'copse-autonomy-eval:local'
const nodeVersion = readFileSync(resolve('.nvmrc'), 'utf8').trim()
const rawArgs = normalizeContainerScriptArgs(process.argv.slice(2))
const skipBuild = rawArgs.includes('--no-build')
const unsupported = rawArgs.filter((arg) => arg !== '--no-build')
if (unsupported.length > 0) {
  throw new Error(`Unsupported container eval arguments: ${unsupported.join(' ')}`)
}

function runContainerCommand(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

let engine
try {
  engine = resolveContainerEngine()
} catch (error) {
  console.error(`eval:autonomy: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

console.log(`eval:autonomy: container engine=${engine}`)

if (!skipBuild) {
  const build = containerBuildCommand(engine, {
    file: 'benchmarks/autonomy/Dockerfile',
    tag: IMAGE,
    context: '.',
    buildArgs: { NODE_VERSION: nodeVersion },
  })
  if (runContainerCommand(build.command, build.args) !== 0) process.exit(1)
}

const artifactDir = resolve(process.env['COPSE_EVAL_ARTIFACT_DIR'] ?? 'tests/e2e/artifacts')
mkdirSync(artifactDir, { recursive: true })

process.exit(
  runContainerCommand(
    engine === 'apple' ? 'container' : 'docker',
    autonomyContainerRunArgs(engine, IMAGE, artifactDir, process.env),
  ),
)
