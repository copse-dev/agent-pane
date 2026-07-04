import * as esbuild from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Runner for the thread-store benchmark (issue #644). Bundles
 * `bench-thread-store-entry.ts` (with the same storage/settings test shims the
 * unit-test runner uses, so it needs no Electron) and runs it under Node.
 *
 * Usage: `node scripts/bench-thread-store.mts [--threads=200] [--messages=100]
 * [--result-bytes=1500] [--iters=5]`. Sandbox/CI fs timing is noisy — run a few
 * times and prefer the p50. Authoritative numbers come from a real machine.
 */

const settingsShim = resolve('src/main/services/settings.test-shim.ts')
const storageShim = resolve('src/main/services/storage.test-shim.ts')
const outfile = join(mkdtempSync(join(tmpdir(), 'copse-bench-build-')), 'bench.cjs')

await esbuild.build({
  entryPoints: [resolve('scripts/bench-thread-store-entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: false,
  external: ['electron', 'node-pty', 'jsdom', '@mozilla/readability', 'turndown'],
  alias: { '@shared': resolve('./src/shared') },
  define: { __COPSE_TEST_DIRECTIVES__: 'false' },
  plugins: [
    {
      name: 'main-services-test-shims',
      setup(build): void {
        build.onResolve({ filter: /\/settings\.ts$/ }, (args) =>
          args.path.includes('settings.test-shim') ? undefined : { path: settingsShim },
        )
        build.onResolve({ filter: /\/storage\.ts$/ }, (args) =>
          args.path.includes('storage.test-shim') ? undefined : { path: storageShim },
        )
      },
    },
  ],
})

const result = spawnSync('node', [outfile, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
