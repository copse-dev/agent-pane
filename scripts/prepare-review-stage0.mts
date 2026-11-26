/**
 * Prepare Copse for the isolated Stage 0 reviewer cell.
 *
 * Keep arbitrary dependency lifecycle scripts disabled. Linux does not ship in
 * node-pty's npm prebuilds, however, so explicitly run only that dependency's
 * reviewed native build after pnpm has materialised the offline install.
 *
 * Electron's binary is never downloaded here (no scripts, no network). Its
 * loader still has to resolve, though, because main-process unit tests
 * `require('electron')` for a path; see `placeholderElectron` below.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, constants } from 'node:fs'
import { appendFile, chmod, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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

/**
 * Electron's `index.js` returns `dist/<path.txt>`, and otherwise tries to
 * download the binary, which throws in a network-disabled cell and so fails
 * every test file that imports it before a single test runs; a run like that
 * has no failure list to compare. Unit tests only need the path, so give the
 * cell a placeholder executable there: the files load and their tests run, and
 * anything that does launch Electron fails by name with this message.
 */
async function placeholderElectron(): Promise<void> {
  const electron = join('node_modules', 'electron')
  if (process.platform !== 'linux') return
  if (!existsSync(join(electron, 'package.json')) || existsSync(join(electron, 'path.txt'))) return
  console.log('==> Stage 0 placeholder Electron executable…')
  await mkdir(join(electron, 'dist'), { recursive: true })
  const executable = join(electron, 'dist', 'electron')
  await writeFile(
    executable,
    [
      '#!/bin/sh',
      "echo 'Electron is not installed in this review cell (dependency scripts are off and it has no network), so nothing here can launch it.' >&2",
      'exit 1',
      '',
    ].join('\n'),
  )
  await chmod(executable, 0o755)
  await writeFile(join(electron, 'path.txt'), 'electron')
}

await placeholderElectron()
