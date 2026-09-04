import * as esbuild from 'esbuild'
import { resolve } from 'node:path'
import { STANDALONE_MAIN_BUNDLES } from '../main-bundles.mts'

/**
 * Bundle the container worker exactly as `pnpm run build` does, for tooling
 * that runs without a built `dist/` (the CLI wrapper and the integration
 * test). The entry, externals and aliases come from the one list both
 * builders use, so this cannot drift from the shipped bundle.
 */
export async function bundleThreadContainerWorker(outfile: string): Promise<string> {
  const bundle = STANDALONE_MAIN_BUNDLES.find((entry) =>
    entry.outfile.endsWith('thread-container-worker.cjs'),
  )
  if (!bundle) throw new Error('thread-container worker is not registered in main-bundles.mts')
  await esbuild.build({
    entryPoints: [resolve(bundle.entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: false,
    target: 'node22',
    ...(bundle.external ? { external: bundle.external } : {}),
    alias: {
      '@shared': resolve('./src/shared'),
      ...Object.fromEntries(
        Object.entries(bundle.alias ?? {}).map(([from, to]) => [from, resolve(to)]),
      ),
    },
    define: { __COPSE_TEST_DIRECTIVES__: 'false' },
    logLevel: 'warning',
  })
  return outfile
}
