import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { getElectronUserDataPath } from '../electron-app-runtime.ts'

/**
 * Owns the native `copse-desktop` helper (native/copse-desktop.swift): one
 * long-lived process, one JSON request per line, responses matched by id.
 *
 * The helper re-spawns itself with TCC responsibility disclaimed, so macOS
 * attributes Accessibility and Screen Recording to "Copse Desktop Control"
 * rather than to Copse. The main process therefore never holds either grant.
 */

const REQUEST_TIMEOUT_MS = 20_000
const READY_TIMEOUT_MS = 10_000
const IDLE_SHUTDOWN_MS = 5 * 60_000
const COMPILE_TIMEOUT_MS = 180_000
const MAX_DIAGNOSTIC_CHARS = 8_192

const permissionsSchema = z.object({ accessibility: z.boolean(), screenRecording: z.boolean() })
export type DesktopPermissions = z.infer<typeof permissionsSchema>

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
export type DesktopRect = z.infer<typeof rectSchema>

const appSchema = z.object({
  pid: z.number().int(),
  name: z.string(),
  bundleId: z.string().optional(),
  active: z.boolean(),
  hidden: z.boolean(),
})
export type DesktopApp = z.infer<typeof appSchema>

const windowSchema = z.object({
  windowId: z.number().int(),
  pid: z.number().int(),
  app: z.string(),
  onScreen: z.boolean(),
  bounds: rectSchema,
  title: z.string().optional(),
})
export type DesktopWindow = z.infer<typeof windowSchema>

const snapshotSchema = z.object({
  tree: z.string(),
  nodes: z.number().int(),
  truncated: z.boolean(),
  elapsedMs: z.number(),
  windowId: z.number().int().optional(),
})
export type DesktopSnapshot = z.infer<typeof snapshotSchema>

const screenshotSchema = z.object({
  path: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  frame: rectSchema,
})
export type DesktopScreenshot = z.infer<typeof screenshotSchema>

const anyResultSchema = z.unknown()

const responseSchema = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number().int(), ok: z.literal(false), error: z.string() }),
])
const readySchema = z.object({ ready: z.literal(true), permissions: permissionsSchema })

export type DesktopHelperLauncher = () => Promise<ChildProcessWithoutNullStreams>

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface RunningHelper {
  child: ChildProcessWithoutNullStreams
  ready: Promise<DesktopPermissions>
  pending: Map<number, Pending>
  stderr: string
}

export class DesktopControlService {
  private helper: RunningHelper | null = null
  private starting: Promise<RunningHelper> | null = null
  private nextId = 1
  private idleTimer: NodeJS.Timeout | null = null
  /** Last capture geometry per window, so image-pixel clicks map to screen points. */
  private readonly captures = new Map<
    number,
    { frame: DesktopRect; width: number; height: number }
  >()

  private readonly launch: DesktopHelperLauncher

  constructor(launch: DesktopHelperLauncher = launchCompiledHelper) {
    this.launch = launch
  }

  async permissions(signal?: AbortSignal): Promise<DesktopPermissions> {
    return this.call('permissions', {}, permissionsSchema, signal)
  }

  async requestPermissions(signal?: AbortSignal): Promise<DesktopPermissions> {
    return this.call('requestPermissions', {}, permissionsSchema, signal)
  }

  async apps(signal?: AbortSignal): Promise<DesktopApp[]> {
    return this.call('apps', {}, z.array(appSchema), signal)
  }

  async windows(pid: number | undefined, signal?: AbortSignal): Promise<DesktopWindow[]> {
    return this.call('windows', pid === undefined ? {} : { pid }, z.array(windowSchema), signal)
  }

  /** Resolve a bundle id to its running process; the tools address apps by bundle id. */
  async resolveApp(bundleId: string, signal?: AbortSignal): Promise<DesktopApp> {
    const app = (await this.apps(signal)).find((candidate) => candidate.bundleId === bundleId)
    if (!app) throw new Error(`${bundleId} is not running. Launch it first.`)
    return app
  }

  async snapshot(
    pid: number,
    options: { windowId?: number | undefined; maxNodes?: number | undefined },
    signal?: AbortSignal,
  ): Promise<DesktopSnapshot> {
    return this.call(
      'snapshot',
      {
        pid,
        ...(options.windowId === undefined ? {} : { windowId: options.windowId }),
        ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
      },
      snapshotSchema,
      signal,
    )
  }

  async screenshot(
    windowId: number,
    path: string,
    signal?: AbortSignal,
  ): Promise<DesktopScreenshot> {
    const result = await this.call('screenshot', { windowId, path }, screenshotSchema, signal)
    this.captures.set(windowId, { frame: result.frame, width: result.width, height: result.height })
    return result
  }

  async press(
    pid: number,
    ref: string,
    action: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('press', action ? { pid, ref, action } : { pid, ref }, anyResultSchema, signal)
  }

  async setValue(pid: number, ref: string, value: string, signal?: AbortSignal): Promise<void> {
    await this.call('setValue', { pid, ref, value }, anyResultSchema, signal)
  }

  async type(pid: number, text: string, signal?: AbortSignal): Promise<void> {
    await this.call('type', { pid, text }, anyResultSchema, signal)
  }

  async key(
    pid: number,
    keyCode: number,
    modifiers: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('key', { pid, keyCode, modifiers }, anyResultSchema, signal)
  }

  async menu(pid: number, path: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.call('menu', { pid, path }, anyResultSchema, signal)
  }

  /**
   * Click at a point in the most recent `desktop_screenshot` of this window,
   * in that image's pixels. Requiring a prior capture keeps the model from
   * clicking coordinates it has never seen.
   */
  async clickInCapture(
    pid: number,
    windowId: number,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const capture = this.captures.get(windowId)
    if (!capture)
      throw new Error('Take a desktop_screenshot of this window before clicking by coordinates.')
    if (x < 0 || y < 0 || x > capture.width || y > capture.height) {
      throw new Error(
        `(${String(x)}, ${String(y)}) is outside the ${String(capture.width)}×${String(capture.height)} screenshot.`,
      )
    }
    const point = {
      x: Math.round(capture.frame.x + (x * capture.frame.width) / capture.width),
      y: Math.round(capture.frame.y + (y * capture.frame.height) / capture.height),
    }
    await this.call('click', { pid, windowId, ...point }, anyResultSchema, signal)
    return point
  }

  dispose(): void {
    this.stop(new Error('Desktop control stopped'))
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted()
    const helper = await this.ensureHelper()
    await helper.ready
    signal?.throwIfAborted()
    this.touch()
    const id = this.nextId++
    const raw = await new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        const entry = helper.pending.get(id)
        if (!entry) return
        clearTimeout(entry.timer)
        helper.pending.delete(id)
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'))
      }
      const timer = setTimeout(() => {
        helper.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(new Error(`Desktop helper timed out on ${method}`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref()
      helper.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      helper.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new Error(`Desktop helper returned an unexpected ${method} result`)
    return parsed.data
  }

  private async ensureHelper(): Promise<RunningHelper> {
    if (this.helper) return this.helper
    // Concurrent first calls share one launch (and one compile).
    this.starting ??= this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(): Promise<RunningHelper> {
    const child = await this.launch()
    const pending = new Map<number, Pending>()
    let markReady: (permissions: DesktopPermissions) => void = () => undefined
    let failReady: (error: Error) => void = () => undefined
    const ready = new Promise<DesktopPermissions>((resolve, reject) => {
      markReady = resolve
      failReady = reject
    })
    const helper: RunningHelper = { child, ready, pending, stderr: '' }
    this.helper = helper
    const readyTimer = setTimeout(() => {
      failReady(new Error('Desktop helper did not start'))
      this.stop(new Error('Desktop helper did not start'))
    }, READY_TIMEOUT_MS)
    readyTimer.unref()

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      helper.stderr = (helper.stderr + chunk).slice(-MAX_DIAGNOSTIC_CHARS)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      const response = safeJsonParse(line, decodeWithSchema(responseSchema))
      if (response) {
        const entry = pending.get(response.id)
        if (!entry) return
        pending.delete(response.id)
        clearTimeout(entry.timer)
        if (response.ok) entry.resolve(response.result)
        else entry.reject(new Error(response.error))
        return
      }
      const readyLine = safeJsonParse(line, decodeWithSchema(readySchema))
      if (readyLine) {
        clearTimeout(readyTimer)
        markReady(readyLine.permissions)
      }
    })
    child.once('error', (error) => {
      clearTimeout(readyTimer)
      failReady(error)
      this.release(helper, error)
    })
    child.once('exit', (code) => {
      clearTimeout(readyTimer)
      const detail = helper.stderr.trim()
      const error = new Error(
        `Desktop helper exited (${String(code)})${detail ? `: ${detail.slice(-500)}` : ''}`,
      )
      failReady(error)
      this.release(helper, error)
    })
    // A rejected ready promise with no listener yet must not crash the process.
    ready.catch(() => undefined)
    return helper
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.stop(new Error('Desktop helper idle'))
    }, IDLE_SHUTDOWN_MS)
    this.idleTimer.unref()
  }

  private stop(reason: Error): void {
    const helper = this.helper
    if (!helper) return
    this.release(helper, reason)
    helper.child.kill('SIGTERM')
  }

  private release(helper: RunningHelper, reason: Error): void {
    if (this.helper === helper) this.helper = null
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    // Refs and capture geometry die with the helper process.
    this.captures.clear()
    for (const entry of helper.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(reason)
    }
    helper.pending.clear()
  }
}

// ── Building the helper ─────────────────────────────────────────────────────

function helperSourceDirectory(): string {
  return join(__dirname, '..', 'resources', 'desktop-control')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, COMPILE_TIMEOUT_MS)
    timer.unref()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_CHARS)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `${file} exited with code ${String(code)}`))
    })
  })
}

let compiled: Promise<string> | null = null

/**
 * Compile the helper when its source changes, always to the same path.
 *
 * macOS keys a bare binary's privacy grant to its path *and* its code
 * signature's designated requirement. An ad-hoc signature's requirement is the
 * binary's hash, so the grant is lost on every rebuild; a Developer ID
 * signature's requirement is identifier + team, which survives rebuilds as
 * long as the path is stable. `CSC_NAME` (electron-builder's identity name)
 * selects that signature for development; a shipped build should carry a
 * prebuilt, notarized helper instead.
 */
async function compileHelper(): Promise<string> {
  const sourceDirectory = helperSourceDirectory()
  const source = join(sourceDirectory, 'copse-desktop.swift')
  const plist = join(sourceDirectory, 'Info.plist')
  const [sourceBytes, plistBytes] = await Promise.all([readFile(source), readFile(plist)])
  const digest = createHash('sha256')
    .update(sourceBytes)
    .update(plistBytes)
    .digest('hex')
    .slice(0, 16)
  const directory = join(getElectronUserDataPath(), 'native-helpers', 'desktop-control')
  const binary = join(directory, 'copse-desktop')
  const configuredIdentity = process.env['CSC_NAME']?.trim()
  const identity = configuredIdentity?.length ? configuredIdentity : '-'
  const stamp = join(directory, 'build-stamp')
  const expectedStamp = `${digest} ${identity}`
  const currentStamp = await readFile(stamp, 'utf8').catch(() => '')
  if (currentStamp === expectedStamp && (await exists(binary))) return binary
  const moduleCache = join(directory, 'module-cache')
  await mkdir(moduleCache, { recursive: true })
  const env = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCache,
    SWIFT_MODULE_CACHE_PATH: moduleCache,
  }
  const partial = `${binary}.partial`
  await run(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-swift-version',
      '5',
      '-module-cache-path',
      moduleCache,
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      '-framework',
      'ScreenCaptureKit',
      '-Xlinker',
      '-sectcreate',
      '-Xlinker',
      '__TEXT',
      '-Xlinker',
      '__info_plist',
      '-Xlinker',
      plist,
      source,
      '-o',
      partial,
    ],
    env,
  ).catch((error: unknown) => {
    throw new Error(`Could not compile the desktop-control helper: ${String(error)}`)
  })
  // The identifier is what System Settings shows and what the grant is keyed to.
  await run(
    '/usr/bin/codesign',
    [
      '-f',
      '-s',
      identity,
      '-i',
      'dev.copse.desktop-control',
      ...(identity === '-' ? [] : ['--options', 'runtime', '--timestamp=none']),
      partial,
    ],
    env,
  )
  await run('/bin/mv', ['-f', partial, binary], env)
  await writeFile(stamp, expectedStamp)
  return binary
}

async function launchCompiledHelper(): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform !== 'darwin') throw new Error('Computer use is only available on macOS.')
  compiled ??= compileHelper().catch((error: unknown) => {
    compiled = null
    throw error
  })
  return spawn(await compiled, [], { stdio: ['pipe', 'pipe', 'pipe'] })
}

let service: DesktopControlService | null = null

export function getDesktopControlService(): DesktopControlService {
  service ??= new DesktopControlService()
  return service
}

export function disposeDesktopControlService(): void {
  service?.dispose()
  service = null
}
