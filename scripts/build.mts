import * as esbuild from 'esbuild'
import { execSync, spawnSync } from 'node:child_process'
import {
  accessSync,
  cpSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { copyMonacoWorkers } from './copy-monaco-workers.mts'

const bundledGortexName = process.platform === 'win32' ? 'gortex.exe' : 'gortex'
const isDemo = process.argv.includes('--demo')

const sharedAlias = {
  '@shared': resolve('./src/shared'),
  '@copse/agent': resolve('./packages/agent/src'),
  '@copse/llm': resolve('./packages/llm/src'),
  '@copse/plan-usage': resolve('./packages/plan-usage/src'),
}

// Emit a scenario manifest (id + label) alongside the demo build so the per-PR
// demo-preview PR comment can link each selectable `?scenario=` state without
// hard-coding the list. `demo-scenarios.ts` has only a type-only import, so
// esbuild bundles it standalone; we import the emitted module and read the
// exported list back. Best-effort: any failure writes `[]` rather than breaking
// the demo build, since the comment degrades gracefully without it.
async function writeDemoScenarioManifest(outPath: string): Promise<void> {
  const tempModule = resolve('dist', '.demo-scenarios.mjs')
  try {
    await esbuild.build({
      entryPoints: ['src/shared/demo-scenarios.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: tempModule,
      alias: sharedAlias,
    })
    const imported: unknown = await import(pathToFileURL(tempModule).href)
    const list =
      imported !== null && typeof imported === 'object' && 'DEMO_SCENARIOS' in imported
        ? imported.DEMO_SCENARIOS
        : undefined
    const manifest: { id: string; label: string }[] = []
    if (Array.isArray(list)) {
      for (const item of list as unknown[]) {
        if (item !== null && typeof item === 'object' && 'id' in item && 'label' in item) {
          const record = item as Record<string, unknown>
          manifest.push({ id: String(record['id']), label: String(record['label']) })
        }
      }
    }
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
  } catch (error) {
    console.warn(`[build] demo scenario manifest generation failed: ${String(error)}`)
    writeFileSync(outPath, '[]\n')
  } finally {
    rmSync(tempModule, { force: true })
  }
}

function fetchBundledCursorSkillsForBuild(): void {
  if (process.env['SKIP_BUNDLED_CURSOR_SKILLS_FETCH'] === '1') return
  try {
    execSync('node scripts/fetch-bundled-cursor-skills.mts', { stdio: 'inherit' })
  } catch {
    console.warn('[build] bundled Cursor skills fetch failed — continuing without bundled skills')
  }
}

/**
 * Syntax-check a bundle that is exec'd as a standalone script rather than
 * required by another bundle. Nothing else loads these at build or test time,
 * so a malformed emit (see the askpass hashbang note below) otherwise only
 * surfaces as a runtime crash in a shipped app.
 */
function assertParses(outfile: string): void {
  const check = spawnSync(process.execPath, ['--check', outfile], { encoding: 'utf8' })
  if (check.status !== 0) {
    throw new Error(`[build] ${outfile} is not parseable by Node:\n${check.stderr.trim()}`)
  }
}

// Release builds (`COPSE_RELEASE=1`, used by `npm run build:release` → packaging)
// strip the MockLLMProvider test directives so the parser is absent from shipped
// apps. The `define` turns the guard into `if (false)`; `minifySyntax` is what
// actually dead-code-eliminates that dead branch (esbuild keeps it otherwise).
// Non-release builds keep the directives for dev/e2e and stay un-minified.
const isRelease = process.env['COPSE_RELEASE'] === '1'
const define = { __COPSE_TEST_DIRECTIVES__: String(!isRelease) }

const nodeOpts = {
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  external: [
    'electron',
    '@anthropic-ai/sandbox-runtime',
    'shell-quote',
    'node-pty',
    'jsdom',
    '@mozilla/readability',
    'turndown',
    // electron-updater lazy-requires its provider backends (GitHub/S3/generic)
    // and js-yaml at runtime; bundling breaks those dynamic requires. It ships as
    // a production dependency, so electron-builder packs it into the app's
    // node_modules where the asar-aware require resolves it at runtime.
    'electron-updater',
  ],
  sourcemap: true,
  target: 'node22',
  alias: sharedAlias,
  define,
  minifySyntax: isRelease,
}

if (!isDemo) {
  fetchBundledCursorSkillsForBuild()
  await esbuild.build({
    ...nodeOpts,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
  })
  await esbuild.build({
    ...nodeOpts,
    entryPoints: ['src/main/project-sandbox/sandbox-fs-worker.ts'],
    outfile: 'dist/main/sandbox-fs-worker.js',
  })
  await esbuild.build({
    ...nodeOpts,
    entryPoints: ['src/main/services/packs/pack-tool-worker.ts'],
    outfile: 'dist/main/pack-tool-worker.js',
  })
  assertParses('dist/main/pack-tool-worker.js')
  // No `banner` here: askpass-helper.ts already starts with `#!/usr/bin/env node`
  // and esbuild preserves a source hashbang verbatim. Adding the banner too put a
  // second `#!…` on line 2 of the bundle, where it is not a hashbang but a syntax
  // error — every SSH password/passphrase/host-key prompt died in the helper, so
  // OpenSSH silently skipped the prompt and burned through auth attempts instead.
  await esbuild.build({
    ...nodeOpts,
    entryPoints: ['src/main/services/ssh-workspace/askpass-helper.ts'],
    outfile: 'dist/main/ssh-askpass-helper.js',
  })
  assertParses('dist/main/ssh-askpass-helper.js')
  await esbuild.build({
    ...nodeOpts,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.js',
  })
  await esbuild.build({
    ...nodeOpts,
    entryPoints: ['src/preload/video-decoder.ts'],
    outfile: 'dist/preload/video-decoder.js',
  })
}
const browserOpts = {
  bundle: true,
  platform: 'browser' as const,
  // Demo previews are committed to the machine-managed `demo-previews` branch and
  // fetched by every Secret scan (`gitleaks` with `fetch-depth: 0`). Source maps
  // there trip high-entropy secret heuristics and fail unrelated PR tips — so the
  // demo build must not emit them.
  sourcemap: !isDemo,
  loader: { '.ts': 'ts', '.css': 'css', '.ttf': 'file' } as const,
  alias: sharedAlias,
  define,
  minifySyntax: isRelease,
}

const rendererOutDir = isDemo ? 'dist/demo' : 'dist/renderer'
const rendererEntry = isDemo ? 'src/renderer/demo/main.ts' : 'src/renderer/main.ts'

await esbuild.build({
  ...browserOpts,
  entryPoints: [rendererEntry],
  outfile: `${rendererOutDir}/app.js`,
})
// Monaco is bundled on its own and injected lazily by monaco/setup.ts, keeping
// the multi-megabyte editor (and its CSS) out of the initial app.js.
await esbuild.build({
  ...browserOpts,
  entryPoints: ['src/renderer/monaco/monaco-global.ts'],
  outfile: `${rendererOutDir}/monaco-bundle.js`,
})
// The hidden video-frame decoder runs in its own window, so it gets its own
// bundle rather than riding along in app.js (see main/services/video/). The
// demo build has no main process to open that window, so it skips this.
if (!isDemo) {
  await esbuild.build({
    ...browserOpts,
    entryPoints: ['src/renderer/video/decoder.ts'],
    outfile: `${rendererOutDir}/video/decoder.js`,
  })
  copyFileSync('src/renderer/video/decoder.html', `${rendererOutDir}/video/decoder.html`)
}

copyFileSync('src/renderer/index.html', `${rendererOutDir}/index.html`)
copyFileSync('src/renderer/theme-boot.js', `${rendererOutDir}/theme-boot.js`)
copyFileSync('assets/icons/rose/icon-32.png', `${rendererOutDir}/favicon.png`)
cpSync('src/renderer/icon-previews', `${rendererOutDir}/icon-previews`, { recursive: true })
copyMonacoWorkers(rendererOutDir)
cpSync('node_modules/vscode-material-icons/generated/icons', `${rendererOutDir}/material-icons`, {
  recursive: true,
})

if (isDemo) {
  await writeDemoScenarioManifest(`${rendererOutDir}/scenarios.json`)
  // Fail closed: demo trees are committed to `demo-previews` and scanned by
  // gitleaks across every PR tip. A source map here is a repo-wide CI outage.
  const maps: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.map')) maps.push(path)
    }
  }
  walk(rendererOutDir)
  if (maps.length > 0) {
    throw new Error(`demo build must not emit source maps (gitleaks): ${maps.join(', ')}`)
  }
  console.log(`Demo build written to ${rendererOutDir}`)
  process.exit(0)
}

cpSync('assets', 'dist/assets', { recursive: true })

const bundledGortex = resolve('vendor/gortex', bundledGortexName)
try {
  accessSync(bundledGortex)
  cpSync('vendor/gortex', 'dist/resources/gortex', { recursive: true })
} catch {
  // Optional — postinstall may be skipped on unsupported platforms.
}

try {
  accessSync(resolve('vendor/bundled-cursor-skills'))
  cpSync('vendor/bundled-cursor-skills', 'dist/resources/bundled-cursor-skills', {
    recursive: true,
  })
} catch {
  // Optional — fetch-bundled-cursor-skills.mts may be skipped offline.
}

// Fail fast if a release build ever ships the MockLLMProvider test directives:
// the `__COPSE_TEST_DIRECTIVES__` guard + minifySyntax must have eliminated them.
// `mock:delay_ms` / `mcp:([` are fragments of the directive regexes and never
// appear in product code (real MCP tool names use the `mcp__` separator).
if (isRelease) {
  const mainBundle = readFileSync('dist/main/index.js', 'utf8')
  const leaked = ['mock:delay_ms', 'mcp:(['].filter((marker) => mainBundle.includes(marker))
  if (leaked.length > 0) {
    throw new Error(
      `Release build leaked test-only mock directives (${leaked.join(', ')}). ` +
        'The __COPSE_TEST_DIRECTIVES__ guard should have stripped them.',
    )
  }
}
