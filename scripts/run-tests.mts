import * as esbuild from 'esbuild'
import { glob, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { selectTestFiles, describeNoMatch, testOutputPath } from './lib/test-filter.mts'

const settingsShim = resolve('src/main/services/storage/settings.test-shim.ts')
const storageShim = resolve('src/main/services/storage/storage.test-shim.ts')

const bundleOnly = process.argv.includes('--bundle-only')
const testOnly = process.argv.includes('--test-only')
if (bundleOnly && testOnly) {
  console.error('[run-tests] pass at most one of --bundle-only / --test-only')
  process.exit(2)
}

/**
 * Positional args are filters (`npm test -- thread-store hooks/`): only the
 * matching test files are bundled and run. No filters = the whole suite, which
 * is what CI and `npm run check` do. See `lib/test-filter.mts` for the matching
 * rules and `docs/testing-strategy.md` for when a subset is the wrong call.
 */
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'))

function isEsbuildServiceDead(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('The service was stopped') || msg.includes('The service is no longer running')
}

/** Every test file the suite covers, repo-relative and sorted. */
async function allTestFiles(): Promise<string[]> {
  const testFiles: string[] = []
  for await (const f of glob('src/**/*.test.ts')) testFiles.push(f)
  for await (const f of glob('packages/*/src/**/*.test.ts')) testFiles.push(f)
  for await (const f of glob('scripts/**/*.test.ts')) testFiles.push(f)
  return testFiles.map((f) => f.replace(/\\/g, '/')).sort()
}

/** The files this invocation covers — the whole suite, or the filtered subset. */
async function selectedTestFiles(): Promise<string[]> {
  const all = await allTestFiles()
  const problem = describeNoMatch(all, filters)
  if (problem !== null) {
    console.error(problem)
    process.exit(2)
  }
  return selectTestFiles(all, filters)
}

async function bundleTests(testFiles: string[]): Promise<void> {
  // A full run starts clean; a filtered run leaves the rest of dist-test alone
  // (it only ever runs the paths it bundled, and wiping would make every
  // subset pay for the next full run).
  if (filters.length === 0) await rm('dist-test', { recursive: true, force: true })

  const buildOptions: esbuild.BuildOptions = {
    entryPoints: testFiles,
    outdir: 'dist-test',
    // Pin the output layout to the repo root. esbuild otherwise derives outbase
    // from the entry points' common ancestor, so a subset under one directory
    // would flatten to different `dist-test/` paths than the full run produces.
    outbase: '.',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: true,
    // Preserve the dependency's real ESM import.meta.url for vendored runtime assets.
    // Production externalizes it for the same reason.
    external: [
      'electron',
      'node-pty',
      'jsdom',
      '@mozilla/readability',
      'turndown',
      'mermaid',
      '@anthropic-ai/sandbox-runtime',
      // esbuild locates its native binary by a path relative to its own JS API,
      // so bundling it breaks that lookup ("cannot be bundled"). Tests that build
      // a worker bundle to assert what it links against need the real package.
      'esbuild',
      // Prettier's ESM entry builds a `createRequire(import.meta.url)`, which has
      // no meaning once bundled to CJS ("The argument 'filename' must be ...
      // Received undefined"). Left external, `require('prettier')` picks up the
      // package's own CJS build. Needed by scripts/lib/generated-file.mts.
      'prettier',
    ],
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
  }

  // Bundle in batches rather than handing esbuild all ~540 entry points at once.
  // Each entry point is bundled standalone with its dependencies inlined, so a
  // single build holds the whole ~1.7GB of output in flight and peaks around
  // 5.7GB RSS — enough that a loaded CI runner OOM-kills the esbuild child
  // ("The service was stopped"). Batching bounds the peak; `outbase` is pinned
  // above, so a batched run writes exactly the same paths as a single build.
  for (let i = 0; i < testFiles.length; i += BUNDLE_BATCH_SIZE) {
    await buildBatch({ ...buildOptions, entryPoints: testFiles.slice(i, i + BUNDLE_BATCH_SIZE) })
  }

  // Warm up Electron's binary once, serially, before the parallel test run.
  // Many src/main test files `require('electron')`, and electron@42 lazily
  // extracts its `dist/` on first require when the install did not fully populate
  // it. `node --test` runs test files in parallel, so concurrent extraction
  // races — "failed to create directory .../electron/dist/…: File exists (os
  // error 17)" / "Electron failed to install correctly". A single serial require
  // here does the one-time extraction so the parallel workers all find `dist/`
  // present. Harmless (returns immediately) when Electron is already installed.
  // A filtered run that selected no main-process test has nothing to race, and
  // the warmup is a meaningful slice of a small subset's wall clock — skip it.
  //
  // Must stay in `bundleTests`, after every batch: it ran once per full bundle
  // before batching, and it has to keep running exactly once, after the last
  // build and before `runTests` spawns the parallel workers.
  if (testFiles.some((f) => f.startsWith('src/main/'))) {
    const electronWarmup = spawnSync('node', ['-e', 'require("electron")'], { stdio: 'inherit' })
    if (electronWarmup.status !== 0) {
      console.warn(
        `[run-tests] electron warmup exited ${String(electronWarmup.status)}; continuing to tests`,
      )
    }
  }
}

/** Entry points per `esbuild.build()` call — see the comment in {@link bundleTests}. */
const BUNDLE_BATCH_SIZE = 48

/**
 * Build one batch, retrying if the esbuild child dies.
 *
 * A bare retry reuses the dead JS-side service and fails instantly with "The
 * service is no longer running", so call `stop()` first to force a fresh
 * service. Retrying per batch (rather than re-running the whole bundle) means a
 * transient death costs one batch, not all ~540 entry points.
 */
async function buildBatch(options: esbuild.BuildOptions): Promise<void> {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await esbuild.build(options)
      return
    } catch (err) {
      if (!isEsbuildServiceDead(err) || attempt === maxAttempts) throw err
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[run-tests] esbuild service stopped (${msg}); stop()+retry ${String(attempt)}/${String(maxAttempts - 1)}`,
      )
      try {
        await esbuild.stop()
      } catch {
        // stop() can throw if the service is already gone; ignore and retry.
      }
    }
  }
}

/**
 * Reporters for the run, as `node --test` arguments.
 *
 * Off CI, nothing: node picks `spec` on a TTY, which is what you want when you
 * are reading it live.
 *
 * On CI it defaults to `tap`, and 6000+ tests of TAP is ~49k lines. GitHub's
 * job-log API only returns the last ~5000, so a failure early in a green-ish
 * run is not reachable through the API at all — the `headless-agent-host`
 * failure in this repo had to be read off a screenshot of the web UI. Print the
 * `dot` reporter instead (one character per test, failures re-listed in full at
 * the end) and keep the machine-readable TAP in a file the job uploads.
 */
function reporterArgs(): string[] {
  if (!process.env['CI']) return []
  return [
    '--test-reporter=dot',
    '--test-reporter-destination=stdout',
    '--test-reporter=tap',
    `--test-reporter-destination=${UNIT_TAP_LOG}`,
  ]
}

/** Full TAP for the run, kept for artifact upload rather than the console. */
const UNIT_TAP_LOG = 'unit-tests.tap'

function runTests(testFiles: string[]): void {
  // Unfiltered: hand node the glob so it picks up whatever is in dist-test.
  // Filtered: hand it the exact bundles, so leftovers from an earlier run
  // (dist-test is not wiped for a subset) can never sneak into the results.
  const specs =
    filters.length === 0 ? ['dist-test/**/*.test.js'] : testFiles.map((f) => testOutputPath(f))
  const result = spawnSync('node', ['--test', ...reporterArgs(), ...specs], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const testFiles = await selectedTestFiles()
if (filters.length > 0) {
  console.log(`[run-tests] ${String(testFiles.length)} test file(s) selected:`)
  for (const f of testFiles) console.log(`  ${f}`)
}

if (testOnly) {
  runTests(testFiles)
} else {
  await bundleTests(testFiles)
  if (!bundleOnly) runTests(testFiles)
}
