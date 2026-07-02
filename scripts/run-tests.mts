import * as esbuild from 'esbuild'
import { glob, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const settingsShim = resolve('src/main/services/settings.test-shim.ts')
const storageShim = resolve('src/main/services/storage.test-shim.ts')

const testFiles: string[] = []
for await (const f of glob('src/**/*.test.ts')) testFiles.push(f)
for await (const f of glob('packages/*/src/**/*.test.ts')) testFiles.push(f)
await rm('dist-test', { recursive: true, force: true })
await esbuild.build({
  entryPoints: testFiles,
  outdir: 'dist-test',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'node-pty', 'jsdom', '@mozilla/readability', 'turndown'],
  alias: {
    '@shared': resolve('./src/shared'),
    '@copse/streaming-markdown': resolve('./packages/streaming-markdown/src/index.ts'),
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
const result = spawnSync('node', ['--test', 'dist-test/**/*.test.js'], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})
// Stream the full TAP output through unchanged.
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
// DIAGNOSTIC (temporary): the default TAP reporter scatters failures through
// the middle of a 1600-test run, which CI log truncation drops. Re-print the
// failing top-level entries (whole files that errored, plus failing subtests)
// at the very end so they survive tail-only log fetches.
const lines = result.stdout.split('\n')
const failingFiles = lines.filter((l) => /^not ok \d+ - dist-test\//.test(l))
const failingSubtests = lines.filter((l) => /^\s+not ok \d+ - /.test(l))
if (failingFiles.length || failingSubtests.length) {
  process.stdout.write('\n===DIAGNOSTIC: FAILING TEST FILES===\n')
  for (const l of failingFiles) process.stdout.write(l.trim() + '\n')
  process.stdout.write(`===DIAGNOSTIC: FAILING SUBTESTS (${String(failingSubtests.length)})===\n`)
  for (const l of failingSubtests.slice(0, 60)) process.stdout.write(l.trim() + '\n')
  process.stdout.write('===DIAGNOSTIC: END===\n')
}
// Set exitCode (not process.exit) so the large buffered stdout — including the
// diagnostic block above — fully drains before the process terminates.
process.exitCode = result.status ?? 1
