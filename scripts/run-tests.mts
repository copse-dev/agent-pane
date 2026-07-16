import * as esbuild from 'esbuild'
import { glob, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const settingsShim = resolve('src/main/services/storage/settings.test-shim.ts')
const storageShim = resolve('src/main/services/storage/storage.test-shim.ts')

const testFiles: string[] = []
for await (const f of glob('src/**/*.test.ts')) testFiles.push(f)
for await (const f of glob('packages/*/src/**/*.test.ts')) testFiles.push(f)
for await (const f of glob('scripts/**/*.test.ts')) testFiles.push(f)
await rm('dist-test', { recursive: true, force: true })
await esbuild.build({
  entryPoints: testFiles,
  outdir: 'dist-test',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'node-pty', 'jsdom', '@mozilla/readability', 'turndown', 'mermaid'],
  alias: {
    '@shared': resolve('./src/shared'),
    '@copse/agent': resolve('./packages/agent/src'),
    '@copse/llm': resolve('./packages/llm/src'),
    '@copse/plan-usage': resolve('./packages/plan-usage/src'),
  },
  // Unit tests cover the directive parser, so they always build with it enabled.
  define: { __COPSE_TEST_DIRECTIVES__: 'true' },
  plugins: [
    {
      name: 'main-services-test-shims',
      setup(build): void {
        build.onResolve({ filter: /\/settings\.ts$/ }, (args) => {
          if (!args.path.includes('settings.test-shim')) return { path: settingsShim }
          return undefined
        })
        build.onResolve({ filter: /\/storage\.ts$/ }, (args) => {
          if (!args.path.includes('storage.test-shim')) return { path: storageShim }
          return undefined
        })
      },
    },
  ],
})
// Warm up Electron's binary once, serially, before the parallel test run.
// Many src/main test files `require('electron')`, and electron@42 lazily
// extracts its `dist/` on first require when the install did not fully populate
// it. `node --test` runs test files in parallel, so concurrent extraction
// races — "failed to create directory .../electron/dist/…: File exists (os
// error 17)" / "Electron failed to install correctly". A single serial require
// here does the one-time extraction so the parallel workers all find `dist/`
// present. Harmless (returns immediately) when Electron is already installed.
const electronWarmup = spawnSync('node', ['-e', 'require("electron")'], { stdio: 'inherit' })
if (electronWarmup.status !== 0) {
  console.warn(
    `[run-tests] electron warmup exited ${String(electronWarmup.status)}; continuing to tests`,
  )
}
const result = spawnSync('node', ['--test', 'dist-test/**/*.test.js'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
