import * as esbuild from 'esbuild'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cpSync, copyFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { copyMonacoWorkers } from './copy-monaco-workers.mts'
import { STANDALONE_MAIN_BUNDLES } from './main-bundles.mts'
import { expectString } from '../src/shared/unknown-value.mts'

const require = createRequire(import.meta.url)
const electronPath = expectString(require('electron'))

// Copy static renderer assets once at start
copyMonacoWorkers('dist/renderer')
cpSync('node_modules/vscode-material-icons/generated/icons', 'dist/renderer/material-icons', {
  recursive: true,
})
copyFileSync('src/renderer/index.html', 'dist/renderer/index.html')
copyFileSync('src/renderer/theme-boot.js', 'dist/renderer/theme-boot.js')
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

function gitOutput(args: string[]): string | null {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

// Dev builds always keep the MockLLMProvider test directives (never shipped),
// while still identifying the source revision behind Debug trace exports.
const devBuildCommit = gitOutput(['rev-parse', 'HEAD']) ?? 'unknown'
const devBuildStatus = gitOutput(['status', '--porcelain', '--untracked-files=normal'])
const define = {
  __COPSE_TEST_DIRECTIVES__: 'true',
  __COPSE_BUILD_COMMIT__: JSON.stringify(devBuildCommit),
  __COPSE_BUILD_DIRTY__: JSON.stringify(devBuildStatus === null ? null : devBuildStatus.length > 0),
}

const nodeOpts = {
  bundle: true,
  platform: 'node' as const,
  format: 'cjs' as const,
  external: ['electron', '@anthropic-ai/sandbox-runtime', 'shell-quote', 'node-pty'],
  sourcemap: true,
  define,
}

const sharedAlias = {
  '@shared': new URL('../src/shared', import.meta.url).pathname,
  '@copse/agent': new URL('../packages/agent/src', import.meta.url).pathname,
  '@copse/llm': new URL('../packages/llm/src', import.meta.url).pathname,
  '@copse/plan-usage': new URL('../packages/plan-usage/src', import.meta.url).pathname,
}

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
// The workers/helpers the main process spawns by path. `esbuild.context()` only
// prepares a build — nothing lands in `dist/` until `rebuild()` — so these are
// rebuilt and watched alongside the bundles above, not merely constructed.
//
// No restart hook: the main process resolves each of these per use and execs it
// fresh, so a rebuilt worker is picked up by the next call. Relaunching Electron
// for them would only add startup churn (`watch()` runs its own initial build,
// which would fire the hook again once restarts are armed).
const standaloneCtxs = await Promise.all(
  STANDALONE_MAIN_BUNDLES.map(({ entry, outfile }) =>
    esbuild.context({ ...nodeOpts, entryPoints: [entry], outfile, alias: sharedAlias }),
  ),
)
buildContexts.push(...standaloneCtxs)
const preloadCtx = await esbuild.context({
  ...nodeOpts,
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
  alias: sharedAlias,
  plugins: [onEndPlugin(startElectron)],
})
buildContexts.push(preloadCtx)
const videoPreloadCtx = await esbuild.context({
  ...nodeOpts,
  entryPoints: ['src/preload/video-decoder.ts'],
  outfile: 'dist/preload/video-decoder.js',
  alias: sharedAlias,
  plugins: [onEndPlugin(startElectron)],
})
buildContexts.push(videoPreloadCtx)
// The hidden video-frame decoder window loads its own bundle, not app.js.
const videoDecoderCtx = await esbuild.context({
  entryPoints: ['src/renderer/video/decoder.ts'],
  outfile: 'dist/renderer/video/decoder.js',
  bundle: true,
  platform: 'browser',
  sourcemap: true,
  loader: { '.ts': 'ts' },
  alias: sharedAlias,
  define,
})
buildContexts.push(videoDecoderCtx)
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

// Every context is built before the first launch — Electron must not start
// against a `dist/` that is missing a bundle it spawns by path (the missing
// `sandbox-fs-worker.js` broke every sandboxed `fs:*` call, see main-bundles.mts).
await Promise.all([
  mainCtx.rebuild(),
  preloadCtx.rebuild(),
  videoPreloadCtx.rebuild(),
  rendererCtx.rebuild(),
  videoDecoderCtx.rebuild(),
  ...standaloneCtxs.map((ctx) => ctx.rebuild()),
])
copyFileSync('src/renderer/video/decoder.html', 'dist/renderer/video/decoder.html')
startElectron()
restartOnBuild = true

// Watch for changes
await mainCtx.watch()
await preloadCtx.watch()
await videoPreloadCtx.watch()
await rendererCtx.watch()
await videoDecoderCtx.watch()
for (const ctx of standaloneCtxs) await ctx.watch()

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
