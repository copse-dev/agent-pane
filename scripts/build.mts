import * as esbuild from 'esbuild'
import { execSync } from 'node:child_process'
import { accessSync, cpSync, copyFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { copyMonacoWorkers } from './copy-monaco-workers.mts'

const bundledGortexName = process.platform === 'win32' ? 'gortex.exe' : 'gortex'
const isDemo = process.argv.includes('--demo')

const sharedAlias = {
  '@shared': resolve('./src/shared'),
  '@copse/agent': resolve('./packages/agent/src'),
  '@copse/llm': resolve('./packages/llm/src'),
  '@copse/plan-usage': resolve('./packages/plan-usage/src'),
}

function fetchBundledCursorSkillsForBuild(): void {
  if (process.env['SKIP_BUNDLED_CURSOR_SKILLS_FETCH'] === '1') return
  try {
    execSync('node scripts/fetch-bundled-cursor-skills.mts', { stdio: 'inherit' })
  } catch {
    console.warn('[build] bundled Cursor skills fetch failed — continuing without bundled skills')
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
    entryPoints: ['src/main/services/ssh-workspace/askpass-helper.ts'],
    outfile: 'dist/main/ssh-askpass-helper.js',
    banner: { js: '#!/usr/bin/env node' },
  })
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
  sourcemap: true,
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
