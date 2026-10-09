/**
 * Build the benchmark-only Harbor container payload into
 * `dist-test/harbor-container/` (never `dist/`):
 *
 * - `worker.cjs`: the worker the task container runs (`worker-entry-harbor.ts`),
 * - `node_modules/`: the one external package that worker loads at start, staged
 *   by the product's own `stageSandboxRuntime`,
 * - `driver.cjs`: the host driver that serves the worker's stdio link
 *   (`harbor-container-driver.mts`).
 *
 * `benchmarks/terminal_bench/copse_container_agent.py` uploads the first two into
 * the task container and runs the third on the host.
 */
import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { MAIN_EXTERNALS } from './main-externals.mts'
import { bundleHarborWorker } from './lib/thread-container-worker-bundle.mts'

export async function buildHarborContainer(
  outDir = resolve('dist-test/harbor-container'),
): Promise<{ worker: string; driver: string; outDir: string }> {
  mkdirSync(outDir, { recursive: true })
  const worker = await bundleHarborWorker(resolve(outDir, 'worker.cjs'))
  const driver = resolve(outDir, 'driver.cjs')
  await esbuild.build({
    entryPoints: [resolve('scripts/harbor-container-driver.mts')],
    outfile: driver,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    target: 'node22',
    external: [...MAIN_EXTERNALS],
    alias: { '@shared': resolve('./src/shared') },
    define: { __COPSE_TEST_SCENARIOS__: 'false' },
    logLevel: 'warning',
  })
  rmSync(resolve(outDir, 'node_modules'), { recursive: true, force: true })
  const staged = spawnSync(process.execPath, [driver, 'stage', outDir], { stdio: 'inherit' })
  if (staged.status !== 0) throw new Error('staging the sandbox runtime failed')
  return { worker, driver, outDir }
}

if (process.argv[1]?.endsWith('build-harbor-container.mts')) {
  const built = await buildHarborContainer()
  console.log(`harbor payload=${built.outDir}`)
}
