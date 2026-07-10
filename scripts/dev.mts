import * as esbuild from 'esbuild'
import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { copyMonacoWorkers } from './copy-monaco-workers.mts'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string

// Copy static renderer assets once at start
copyMonacoWorkers('dist/renderer')
cpSync('node_modules/vscode-material-icons/generated/icons', 'dist/renderer/material-icons', {
  recursive: true,
})
copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
cpSync('assets', 'dist/assets', { recursive: true })
copyFileSync('assets/icons/rose/icon-32.png', 'dist/renderer/favicon.png')
cpSync('src/renderer/icon-previews', 'dist/renderer/icon-previews', { recursive: true })

let electron: ChildProcess | null = null
let shuttingDown = false
let restartOnBuild = false
let restartSerial = 0
const buildContexts: esbuild.BuildContext[] = []

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function stopElectron(signal: NodeJS.Signals = 'SIGINT'): Promise<void> {
  const child = electron
  electron = null
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  child.kill(signal)
  await waitForExit(child, 5_000)
  // exitCode/signalCode are mutated by the OS as the child exits during the await above;
  // TS narrows them to null from the line-40 guard but they are genuinely re-read here.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (child.exitCode !== null || child.signalCode !== null) return

  child.kill('SIGTERM')
  await waitForExit(child, 2_000)
  // Same async-mutation caveat as above: re-read post-await, not the narrowed null.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await stopElectron(signal)
  await Promise.allSettled(buildContexts.map((ctx) => ctx.dispose()))
  process.exitCode = signal === 'SIGINT' ? 130 : 143
}

function startElectron(): void {
  if (shuttingDown) return
  const serial = ++restartSerial
  void stopElectron('SIGTERM').finally(() => {
    if (shuttingDown || serial !== restartSerial) return
    electron = spawn(electronPath, ['dist/main/index.js'], {
      detached: process.platform !== 'win32',
      stdio: 'inherit',
    })
  })
}

// Dev builds always keep the MockLLMProvider test directives (never shipped).
const define = { __COPSE_TEST_DIRECTIVES__: 'true' }

const nodeOpts = {
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  external: ['electron', '@anthropic-ai/sandbox-runtime', 'shell-quote', 'node-pty'],
  sourcemap: true,
  define,
}

const sharedAlias = { '@shared': new URL('../src/shared', import.meta.url).pathname }

const onEndPlugin = (cb: () => void): esbuild.Plugin => ({
  name: 'on-end',
  setup(build): void {
    build.onEnd(() => {
      if (restartOnBuild) cb()
    })
  },
})

const mainCtx = await esbuild.context({
  ...nodeOpts,
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  alias: sharedAlias,
  plugins: [onEndPlugin(startElectron)],
})
buildContexts.push(mainCtx)
const preloadCtx = await esbuild.context({
  ...nodeOpts,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
  alias: sharedAlias,
  plugins: [onEndPlugin(startElectron)],
})
buildContexts.push(preloadCtx)
const rendererCtx = await esbuild.context({
  entryPoints: ['src/renderer/main.ts'],
  outfile: 'dist/renderer/app.js',
  bundle: true,
  platform: 'browser',
  sourcemap: true,
  loader: { '.ts': 'ts', '.css': 'css', '.ttf': 'file' },
  alias: sharedAlias,
  define,
})
buildContexts.push(rendererCtx)

await Promise.all([mainCtx.rebuild(), preloadCtx.rebuild(), rendererCtx.rebuild()])
startElectron()
restartOnBuild = true

// Watch for changes
await mainCtx.watch()
await preloadCtx.watch()
await rendererCtx.watch()

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
