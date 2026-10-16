import * as esbuild from 'esbuild'
import { resolve } from 'node:path'
import { STANDALONE_MAIN_BUNDLES } from '../main-bundles.mts'

/** The benchmark-only entry; deliberately absent from `STANDALONE_MAIN_BUNDLES`. */
export const HARBOR_WORKER_ENTRY = 'src/main/services/container-runtime/worker-entry-harbor.ts'

function productBundle(): (typeof STANDALONE_MAIN_BUNDLES)[number] {
  const bundle = STANDALONE_MAIN_BUNDLES.find((entry) =>
    entry.outfile.endsWith('thread-container-worker.cjs'),
  )
  if (!bundle) throw new Error('thread-container worker is not registered in main-bundles.mts')
  return bundle
}

async function bundleWorkerEntry(entry: string, outfile: string): Promise<string> {
  const bundle = productBundle()
  await esbuild.build({
    entryPoints: [resolve(entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    target: 'node22',
    ...(bundle.external ? { external: bundle.external } : {}),
    ...(bundle.logOverride ? { logOverride: bundle.logOverride } : {}),
    alias: {
      '@shared': resolve('./src/shared'),
      ...Object.fromEntries(
        Object.entries(bundle.alias ?? {}).map(([from, to]) => [from, resolve(to)]),
      ),
    },
    define: { __COPSE_TEST_SCENARIOS__: 'false' },
    logLevel: 'warning',
  })
  return outfile
}

/**
 * Bundle the container worker exactly as `pnpm run build` does, for tooling
 * that runs without a built `dist/` (the CLI wrapper and the integration
 * test). The entry, externals and aliases come from the one list both
 * builders use, so this cannot drift from the shipped bundle.
 */
export function bundleThreadContainerWorker(outfile: string): Promise<string> {
  return bundleWorkerEntry(productBundle().entry, outfile)
}

/**
 * The benchmark-only worker (`worker-entry-harbor.ts`): the same shared worker
 * and the same externals and aliases as the product bundle, behind a different
 * entry. Refuses an output path outside `dist-test/`, so it cannot be written
 * into `dist/` or a packaged app.
 */
export async function bundleHarborWorker(outfile: string): Promise<string> {
  const target = resolve(outfile)
  if (!target.startsWith(`${resolve('dist-test')}/`)) {
    throw new Error(
      `The Harbor worker bundle is benchmark-only; build it under dist-test/, not ${target}`,
    )
  }
  return await bundleWorkerEntry(HARBOR_WORKER_ENTRY, target)
}
