import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { autonomyContainerRunArgs } from './lib/autonomy-container.mts'

const IMAGE = 'copse-autonomy-eval:local'
const rawArgs = process.argv.slice(2)
const skipBuild = rawArgs.includes('--no-build')
const unsupported = rawArgs.filter((arg) => arg !== '--no-build')
if (unsupported.length > 0) {
  throw new Error(`Unsupported container eval arguments: ${unsupported.join(' ')}`)
}

function runDocker(args: string[]): number {
  const result = spawnSync('docker', args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

if (
  !skipBuild &&
  runDocker(['build', '--file', 'benchmarks/autonomy/Dockerfile', '--tag', IMAGE, '.']) !== 0
) {
  process.exit(1)
}

const artifactDir = resolve(process.env['COPSE_EVAL_ARTIFACT_DIR'] ?? 'tests/e2e/artifacts')
mkdirSync(artifactDir, { recursive: true })

process.exit(runDocker(autonomyContainerRunArgs(IMAGE, artifactDir, process.env)))
