import * as esbuild from 'esbuild'
import { glob, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
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
// DIAGNOSTIC (temporary): live TAP still streams to stdout (stdio inherit, so
// the job never looks hung), while a second TAP reporter captures the same
// output to a file we post-process. The default reporter scatters failures
// through a 1600-test run and CI log fetches truncate to the tail, so we
// re-print the failing files/subtests in a delimited block at the very end
// where a tail-only fetch will still see them. Revert once diagnosed.
const tapLog = resolve('dist-test/tap.log')
const result = spawnSync(
  'node',
  [
    '--test',
    '--test-reporter=tap',
    '--test-reporter-destination=stdout',
    '--test-reporter=tap',
    `--test-reporter-destination=${tapLog}`,
    'dist-test/**/*.test.js',
  ],
  { stdio: 'inherit' },
)
try {
  const lines = readFileSync(tapLog, 'utf8').split('\n')
  const failingSubtests = lines.filter((l) => /^\s+not ok \d+ - /.test(l))
  const failingIdx = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /^not ok \d+ - dist-test\//.test(l))
  if (failingIdx.length || failingSubtests.length) {
    process.stdout.write('\n===DIAGNOSTIC: FAILING TEST FILES===\n')
    for (const { l, i } of failingIdx) {
      process.stdout.write(l.trim() + '\n')
      // Capture the failing file's TAP YAML diagnostic (error/stack/type) so
      // we can tell a real load error from flaky spawn/resource failures.
      for (let j = i + 1; j < lines.length && j < i + 30; j++) {
        const y = lines[j] ?? ''
        if (/^not ok |^ok /.test(y)) break
        if (/(failureType|error|code|Error|throw|ENOENT|ECONN|EADDR|spawn|timed out):/i.test(y)) {
          process.stdout.write('    ' + y.trim() + '\n')
        }
      }
    }
    process.stdout.write(`===DIAGNOSTIC: FAILING SUBTESTS (${String(failingSubtests.length)})===\n`)
    for (const l of failingSubtests.slice(0, 40)) process.stdout.write(l.trim() + '\n')
    process.stdout.write('===DIAGNOSTIC: END===\n')
  }
} catch {
  // No TAP log (e.g. the run crashed before writing) — nothing to summarize.
}
process.exitCode = result.status ?? 1
