/**
 * Prepare Copse for the isolated Stage 0 reviewer cell.
 *
 * Keep arbitrary dependency lifecycle scripts disabled. Linux does not ship in
 * node-pty's npm prebuilds, however, so explicitly run only that dependency's
 * reviewed native build after pnpm has materialised the offline install.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface Step {
  readonly label: string
  readonly args: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

const nodeRoot = dirname(dirname(process.execPath))
const nodeHeader = join(nodeRoot, 'include', 'node', 'node.h')
const rebuildEnv = existsSync(nodeHeader)
  ? { ...process.env, npm_config_nodedir: nodeRoot }
  : process.env

const steps: readonly Step[] = [
  {
    label: 'offline dependency install',
    args: ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'],
  },
  { label: 'node-pty native build', args: ['rebuild', 'node-pty'], env: rebuildEnv },
]

for (const step of steps) {
  console.log(`==> Stage 0 ${step.label}…`)
  const result = spawnSync('pnpm', step.args, { env: step.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Stage 0 ${step.label} failed (${result.signal ?? String(result.status)})`)
  }
}
