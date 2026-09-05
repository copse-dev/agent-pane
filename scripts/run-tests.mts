import * as esbuild from 'esbuild'
import { glob, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { selectTestFiles, describeNoMatch, testOutputPath } from './lib/test-filter.mts'
import { rewriteModuleRelativeTestPaths } from './lib/module-relative-test-paths.mts'

const settingsShim = resolve('src/main/services/storage/settings.test-shim.ts')
const storageShim = resolve('src/main/services/storage/storage.test-shim.ts')
const repoRoot = resolve('.')

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
  // Shared chunks are content-addressed. Always start clean so a filtered run
  // cannot leave orphan chunks behind, and so --bundle-only produces exactly
  // the tree the following --test-only invocation will execute.
  await rm('dist-test', { recursive: true, force: true })

  const buildOptions: esbuild.BuildOptions = {
    entryPoints: testFiles,
    outdir: 'dist-test',
    // Pin the output layout to the repo root. esbuild otherwise derives outbase
    // from the entry points' common ancestor, so a subset under one directory
    // would flatten to different `dist-test/` paths than the full run produces.
    outbase: '.',
    bundle: true,
    platform: 'node',
    // Keep every test file as its own Node test entry, but emit shared modules
    // once. The old CJS build inlined the same application graph into 800+
    // entries, producing 2.4 GB of output and forcing batching/OOM retries.
    // esbuild supports code splitting for ESM output, and Node still isolates
    // the resulting entries in its ordinary test-file worker processes.
    format: 'esm',
    splitting: true,
    chunkNames: '_chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    // Bundled code contains a small number of intentional CommonJS calls. Give
    // ESM output a local require; source-relative metadata is handled per module
    // below because shared chunks do not retain the entry file's directory.
    banner: {
      js: [
        "import { createRequire as __copseCreateRequire } from 'node:module';",
        'const require = __copseCreateRequire(import.meta.url);',
      ].join('\n'),
    },
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
      // The LM Studio SDK is large and reaches many tests through the provider
      // barrel. Inlining it into every standalone test bundle exhausts the CI
      // runner heap; leave it as a normal runtime dependency instead.
      '@lmstudio/sdk',
      // esbuild locates its native binary by a path relative to its own JS API,
      // so bundling it breaks that lookup ("cannot be bundled"). Tests that build
      // a worker bundle to assert what it links against need the real package.
      'esbuild',
      // The TypeScript compiler API (scripts/lib/api-protocol.mts) is ~9 MB of
      // JS; the protocol drift test needs the real package, not a bundled copy.
      'typescript',
      // Keep oxfmt external — it resolves its native binding at runtime and
      // scripts/lib/oxfmt.mts spawns its CLI from node_modules/.bin.
      'oxfmt',
    ],
    alias: {
      '@shared': resolve('./src/shared'),
    },
    // Unit tests cover the directive parser, so they always build with it enabled.
    define: { __COPSE_TEST_DIRECTIVES__: 'true' },
    plugins: [
      {
        name: 'electron-esm-interop',
        setup(build): void {
          // Electron's package entry is CommonJS and does not advertise named
          // exports to Node's ESM loader. Production source uses Electron's
          // typed named-import API, so expose those properties through a tiny
          // statically-named ESM facade while leaving the package external.
          build.onResolve({ filter: /^electron$/ }, (args) => {
            if (args.namespace === 'electron-esm-interop')
              return { path: 'electron', external: true }
            return { path: 'electron', namespace: 'electron-esm-interop' }
          })
          build.onLoad({ filter: /.*/, namespace: 'electron-esm-interop' }, () => ({
            loader: 'js',
            contents: [
              "import electron from 'electron';",
              'export default electron;',
              ...[
                'app',
                'BrowserWindow',
                'clipboard',
                'contextBridge',
                'dialog',
                'globalShortcut',
                'ipcMain',
                'ipcRenderer',
                'Menu',
                'nativeImage',
                'nativeTheme',
                'Notification',
                'safeStorage',
                'screen',
                'session',
                'shell',
                'webContents',
              ].map((name) => `export const ${name} = electron.${name};`),
            ].join('\n'),
          }))
        },
      },
      {
        name: 'module-relative-test-paths',
        setup(build): void {
          // Once a module moves into a shared chunk, import.meta.url identifies
          // that chunk rather than the source file. Preserve source-relative
          // asset/config lookups and direct-run guards at bundle time.
          build.onLoad({ filter: /\.(?:ts|mts)$/ }, async (args) => {
            if (!args.path.startsWith(`${repoRoot}/`)) return undefined
            const source = await readFile(args.path, 'utf8')
            const outputPath = resolve('dist-test', relative(repoRoot, args.path)).replace(
              /\.(?:ts|mts)$/,
              '.mjs',
            )
            const contents = rewriteModuleRelativeTestPaths(source, args.path, outputPath)
            return { contents, loader: 'ts', resolveDir: dirname(args.path) }
          })
        },
      },
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

  // Code splitting needs the complete entry graph in one build so esbuild can
  // identify common modules. Unlike the former standalone bundles, output now
  // scales with unique code rather than test-file count.
  await esbuild.build(buildOptions)

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
  // Must stay in `bundleTests`, after the build and before `runTests` spawns
  // the parallel workers.
  if (testFiles.some((f) => f.startsWith('src/main/'))) {
    const electronWarmup = spawnSync('node', ['-e', 'require("electron")'], { stdio: 'inherit' })
    if (electronWarmup.status !== 0) {
      console.warn(
        `[run-tests] electron warmup exited ${String(electronWarmup.status)}; continuing to tests`,
      )
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
// Several hook/process suites deliberately spawn subprocess trees. Letting
// Node derive file concurrency from a large developer/runner host can put dozens
// of short-lived children in flight and turn fixed 2s safety deadlines into
// load-dependent failures. Four keeps independent file workers parallel while
// bounding that shared OS pressure.
const TEST_FILE_CONCURRENCY = 4

function runTests(testFiles: string[]): void {
  // Unfiltered: hand node the glob so it picks up every emitted test entry.
  // Filtered: hand it the exact entries selected above.
  const specs =
    filters.length === 0 ? ['dist-test/**/*.test.mjs'] : testFiles.map((f) => testOutputPath(f))
  const result = spawnSync(
    'node',
    ['--test', `--test-concurrency=${String(TEST_FILE_CONCURRENCY)}`, ...reporterArgs(), ...specs],
    { stdio: 'inherit' },
  )
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
