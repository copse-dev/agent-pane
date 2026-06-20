import * as esbuild from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, copyFileSync } from 'node:fs'

// Copy static renderer assets once at start
cpSync('node_modules/monaco-editor/min/vs', 'dist/renderer/monaco/vs', { recursive: true })
cpSync('node_modules/vscode-material-icons/generated/icons', 'dist/renderer/material-icons', {
  recursive: true,
})
copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
cpSync('assets', 'dist/assets', { recursive: true })
copyFileSync('assets/icons/icon-32.png', 'dist/renderer/favicon.png')

let electron: ChildProcess | null = null
function startElectron() {
  electron?.kill()
  electron = spawn('npx', ['electron', 'dist/main/index.js'], { stdio: 'inherit' })
}

const nodeOpts = {
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  external: ['electron', '@anthropic-ai/sandbox-runtime', 'shell-quote', 'node-pty'],
  sourcemap: true,
}

const sharedAlias = { '@shared': new URL('../src/shared', import.meta.url).pathname }

const onEndPlugin = (cb: () => void): esbuild.Plugin => ({
  name: 'on-end',
  setup(build) {
    build.onEnd(cb)
  },
})

const mainCtx = await esbuild.context({
  ...nodeOpts,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  alias: sharedAlias,
  plugins: [onEndPlugin(startElectron)],
})
const preloadCtx = await esbuild.context({
  ...nodeOpts,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
  alias: sharedAlias,
  plugins: [onEndPlugin(startElectron)],
})
const rendererCtx = await esbuild.context({
  entryPoints: ['src/renderer/main.ts'],
  outfile: 'dist/renderer/app.js',
  bundle: true,
  platform: 'browser',
  sourcemap: true,
  loader: { '.ts': 'ts', '.css': 'css', '.ttf': 'file' },
  alias: sharedAlias,
})

await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild(), rendererCtx.rebuild()])
startElectron()

// Watch for changes
await mainCtx.watch()
await preloadCtx.watch()
await rendererCtx.watch()
