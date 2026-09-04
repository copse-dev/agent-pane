/**
 * `pnpm run thread:container -- …` — run one thread unattended inside a
 * disposable local Docker container (docs/plans/thread-in-container.md).
 *
 * The runner lives in the main process (`src/main/services/container-runtime/`),
 * which plain Node cannot import directly, so this wrapper bundles the CLI entry
 * and the guest worker with esbuild — the same way the autonomy eval runner
 * does — then execs the CLI with the worker path it just built. Every flag is
 * forwarded; see `cli.ts` for the list.
 */
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { MAIN_EXTERNALS } from './main-externals.mts'
import { bundleThreadContainerWorker } from './lib/thread-container-worker-bundle.mts'

const outDir = resolve('dist-test')
mkdirSync(outDir, { recursive: true })
const cliBundle = resolve(outDir, 'copse-thread-container-cli.cjs')
const workerBundle = resolve(outDir, 'copse-thread-container-worker.cjs')

await esbuild.build({
  entryPoints: [resolve('src/main/services/container-runtime/cli.ts')],
  outfile: cliBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  target: 'node22',
  external: [...MAIN_EXTERNALS],
  alias: { '@shared': resolve('./src/shared') },
  define: { __COPSE_TEST_DIRECTIVES__: 'false' },
  logLevel: 'warning',
})
await bundleThreadContainerWorker(workerBundle)

const args = process.argv.slice(2)
const result = spawnSync(
  'node',
  [cliBundle, ...args, ...(args.includes('--build') ? ['--worker-bundle', workerBundle] : [])],
  { stdio: 'inherit', cwd: process.cwd(), env: process.env },
)
process.exit(result.status ?? 1)
