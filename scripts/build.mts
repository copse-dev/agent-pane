import * as esbuild from 'esbuild'
import { execSync } from 'node:child_process'
import { accessSync, cpSync, copyFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { copyMonacoWorkers } from './copy-monaco-workers.mts'

const bundledGortexName = process.platform === 'win32' ? 'gortex.exe' : 'gortex'

const sharedAlias = {
  '@shared': resolve('./src/shared'),
  '@copse/agent': resolve('./packages/agent/src'),
  '@copse/llm': resolve('./packages/llm/src'),
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
    '@openai/codex-sdk',
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
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
})
const browserOpts = {
  bundle: true,
  platform: 'browser' as const,
  sourcemap: true,
  loader: { '.ts': 'ts', '.css': 'css', '.ttf': 'file' } as const,
  alias: sharedAlias,
  define,
  minifySyntax: isRelease,
}

await esbuild.build({
  ...browserOpts,
  entryPoints: ['src/renderer/main.ts'],
  outfile: 'dist/renderer/app.js',
})
// Monaco is bundled on its own and injected lazily by monaco/setup.ts, keeping
// the multi-megabyte editor (and its CSS) out of the initial app.js.
await esbuild.build({
  ...browserOpts,
  entryPoints: ['src/renderer/monaco/monaco-global.ts'],
  outfile: 'dist/renderer/monaco-bundle.js',
})

copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
cpSync('assets', 'dist/assets', { recursive: true })
copyFileSync('assets/icons/wave/icon-32.png', 'dist/renderer/favicon.png')
cpSync('src/renderer/icon-previews', 'dist/renderer/icon-previews', { recursive: true })
copyMonacoWorkers('dist/renderer')
cpSync('node_modules/vscode-material-icons/generated/icons', 'dist/renderer/material-icons', {
  recursive: true,
})

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
