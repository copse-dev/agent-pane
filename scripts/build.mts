import * as esbuild from 'esbuild'
import { accessSync, cpSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

const bundledCodesearchName = process.platform === 'win32' ? 'codesearch.exe' : 'codesearch'

const sharedAlias = { '@shared': resolve('./src/shared') }

const nodeOpts = {
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  external: ['electron', '@anthropic-ai/sandbox-runtime', 'shell-quote', 'node-pty'],
  sourcemap: true,
  target: 'node22',
  alias: sharedAlias,
}

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
})

copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
cpSync('assets', 'dist/assets', { recursive: true })
copyFileSync('assets/icons/wave/icon-32.png', 'dist/renderer/favicon.png')
cpSync('src/renderer/icon-previews', 'dist/renderer/icon-previews', { recursive: true })
cpSync('node_modules/monaco-editor/min/vs', 'dist/renderer/monaco/vs', { recursive: true })
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
