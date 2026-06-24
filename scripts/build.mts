import * as esbuild from 'esbuild'
import { execSync } from 'node:child_process'
import { accessSync, cpSync, copyFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { copyMonacoWorkers } from './copy-monaco-workers.mts'

const bundledCodesearchName = process.platform === 'win32' ? 'codesearch.exe' : 'codesearch'

const sharedAlias = { '@shared': resolve('./src/shared') }

function fetchBundledCursorSkillsForBuild(): void {
  if (process.env.SKIP_BUNDLED_CURSOR_SKILLS_FETCH === '1') return
  try {
    execSync('npx tsx scripts/fetch-bundled-cursor-skills.mts', { stdio: 'inherit' })
  } catch {
    console.warn('[build] bundled Cursor skills fetch failed — continuing without bundled skills')
  }
}

// Release builds (`COPSE_RELEASE=1`, used by `npm run build:release` → packaging)
// strip the MockLLMProvider test directives so the parser is absent from shipped
// apps. The `define` turns the guard into `if (false)`; `minifySyntax` is what
// actually dead-code-eliminates that dead branch (esbuild keeps it otherwise).
// Non-release builds keep the directives for dev/e2e and stay un-minified.
const isRelease = process.env.COPSE_RELEASE === '1'
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
await esbuild.build({
  entryPoints: ['src/renderer/main.ts'],
  outfile: 'dist/renderer/app.js',
  bundle: true,
  platform: 'browser',
  sourcemap: true,
  loader: { '.ts': 'ts', '.css': 'css', '.ttf': 'file' },
  alias: sharedAlias,
  define,
  minifySyntax: isRelease,
})

copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
cpSync('assets', 'dist/assets', { recursive: true })
copyFileSync('assets/icons/wave/icon-32.png', 'dist/renderer/favicon.png')
cpSync('src/renderer/icon-previews', 'dist/renderer/icon-previews', { recursive: true })
copyMonacoWorkers('dist/renderer')
cpSync('node_modules/vscode-material-icons/generated/icons', 'dist/renderer/material-icons', {
  recursive: true,
})

const bundledCodesearch = resolve('vendor/codesearch', bundledCodesearchName)
try {
  accessSync(bundledCodesearch)
  cpSync('vendor/codesearch', 'dist/resources/codesearch', { recursive: true })
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
