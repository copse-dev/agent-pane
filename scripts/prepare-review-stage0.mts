/**
 * Prepare Copse for the isolated Stage 0 reviewer cell.
 *
 * Keep arbitrary dependency lifecycle scripts disabled. Linux does not ship in
 * node-pty's npm prebuilds, however, so explicitly run only that dependency's
 * reviewed native build after pnpm has materialised the offline install.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, constants } from 'node:fs'
import { appendFile, cp, mkdtemp } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

interface Step {
  readonly label: string
  readonly args: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

// pnpm registers each install in its store. Keep the shared seed immutable by
// giving this disposable checkout its own writable store (reflink where supported).
const sourceStore = process.env['npm_config_store_dir']
let installEnv = process.env
if (sourceStore) {
  const store = await mkdtemp(join(process.cwd(), '.copse-review-pnpm-store-'))
  await cp(join(sourceStore, 'v10'), join(store, 'v10'), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  })
  await appendFile('.npmrc', `\nstore-dir=${relative(process.cwd(), store)}\n`)
  installEnv = { ...process.env, npm_config_store_dir: store }
}

const nodeRoot = dirname(dirname(process.execPath))
const nodeHeader = join(nodeRoot, 'include', 'node', 'node.h')
const rebuildEnv = existsSync(nodeHeader)
  ? { ...installEnv, npm_config_nodedir: nodeRoot }
  : installEnv

const steps: readonly Step[] = [
  {
    label: 'offline dependency install',
    args: ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'],
    env: installEnv,
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
