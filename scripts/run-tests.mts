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
    external: ['electron', 'node-pty', 'jsdom', '@mozilla/readability', 'turndown', 'mermaid'],
    alias: {
      '@shared': resolve('./src/shared'),
      '@copse/agent': resolve('./packages/agent/src'),
      '@copse/llm': resolve('./packages/llm/src'),
      '@copse/plan-usage': resolve('./packages/plan-usage/src'),
    },
    // Unit tests cover the directive parser, so they always build with it enabled.
    //
    // `import.meta.url` is the CJS-bundling escape hatch. The output format is
    // `cjs`, where esbuild has no `import.meta` to hand out: it synthesises an
    // empty object and warns, so any bundled ESM dependency that reads
    // `import.meta.url` gets `undefined`. That is only a latent papercut until a
    // dependency does it at module scope — `@anthropic-ai/sandbox-runtime@0.0.67`
    // added `export const VENDORED_SRT_WIN_EXE = path.join(repoRoot(), …)`, whose
    // `repoRoot()` calls `fileURLToPath(import.meta.url)` while the module is
    // still evaluating. `fileURLToPath(undefined)` throws ERR_INVALID_ARG_TYPE,
    // which killed all 131 test files that transitively import the sandbox
    // runtime before a single assertion ran. Pointing `import.meta.url` at the
    // bundle's own path keeps such module-scope reads working (the value is the
    // dist-test bundle rather than the dependency's own file — fine for tests,
    // which never consume these paths, and the production build in build.mts
    // keeps the sandbox runtime `external` so it resolves for real there).
    define: { __COPSE_TEST_DIRECTIVES__: 'true', 'import.meta.url': '__copseImportMetaUrl' },
    // esbuild only substitutes a `define` value that is a JSON literal or a bare
    // identifier, so the expression lives here and `define` points at its name.
    banner: {
      js: "const __copseImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
    },
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

function runTests(testFiles: string[]): void {
  // Unfiltered: hand node the glob so it picks up whatever is in dist-test.
  // Filtered: hand it the exact bundles, so leftovers from an earlier run
  // (dist-test is not wiped for a subset) can never sneak into the results.
  const specs =
    filters.length === 0 ? ['dist-test/**/*.test.js'] : testFiles.map((f) => testOutputPath(f))
  const result = spawnSync('node', ['--test', ...specs], { stdio: 'inherit' })
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
