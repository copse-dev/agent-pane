import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { getElectronUserDataPath, isElectronAppPackaged } from '../electron-app-runtime.ts'

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
  childSession: z.string().optional(),
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

  private readonly childTargets = new Map<number, string>()

  async startChild(
    id: string,
    bundle: string,
    entry: string,
    profile: string,
  ): Promise<DesktopApp> {
    const app = await this.call('startChild', { session: id, bundle, entry, profile }, appSchema)
    this.childTargets.set(app.pid, id)
    return { ...app, childSession: id }
  }

  async validateChild(id: string): Promise<DesktopApp> {
    const app = await this.call('validateChild', { session: id }, appSchema)
    return { ...app, childSession: id }
  }

  async stopChild(id: string): Promise<void> {
    if (!this.helper) return
    // Keep the PID's session tag as a tombstone: in-flight/stale calls must
    // still fail validation after stop or helper restart, never become bare PID calls.
    await this.call('stopChild', { session: id }, anyResultSchema)
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

  async windows(
    pid: number | DesktopApp | undefined,
    signal?: AbortSignal,
  ): Promise<DesktopWindow[]> {
    return this.call('windows', pid === undefined ? {} : { pid }, z.array(windowSchema), signal)
  }

  /** Resolve a bundle id to its running process; the tools address apps by bundle id. */
  async resolveApp(bundleId: string, signal?: AbortSignal): Promise<DesktopApp> {
    const app = (await this.apps(signal)).find((candidate) => candidate.bundleId === bundleId)
    if (!app) throw new Error(`${bundleId} is not running. Launch it first.`)
    return app
  }

  async snapshot(
    pid: number | DesktopApp,
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
    pid?: number | DesktopApp,
  ): Promise<DesktopScreenshot> {
    const result = await this.call('screenshot', { windowId, path, pid }, screenshotSchema, signal)
    this.captures.set(windowId, { frame: result.frame, width: result.width, height: result.height })
    return result
  }

  async press(
    pid: number | DesktopApp,
    ref: string,
    action: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('press', action ? { pid, ref, action } : { pid, ref }, anyResultSchema, signal)
  }

  async setValue(
    pid: number | DesktopApp,
    ref: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('setValue', { pid, ref, value }, anyResultSchema, signal)
  }

  async type(pid: number | DesktopApp, text: string, signal?: AbortSignal): Promise<void> {
    await this.call('type', { pid, text }, anyResultSchema, signal)
  }

  async key(
    pid: number | DesktopApp,
    keyCode: number,
    modifiers: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('key', { pid, keyCode, modifiers }, anyResultSchema, signal)
  }

  async menu(
    pid: number | DesktopApp,
    path: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('menu', { pid, path }, anyResultSchema, signal)
  }

  /**
   * Click at a point in the most recent `desktop_screenshot` of this window,
   * in that image's pixels. Requiring a prior capture keeps the model from
   * clicking coordinates it has never seen.
   */
  async clickInCapture(
    pid: number | DesktopApp,
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
    // Capture identity from the resolved target, not the latest occupant of a PID.
    const target = params['pid']
    const parsedTarget = appSchema.safeParse(target)
    if (parsedTarget.success) {
      params = {
        ...params,
        pid: parsedTarget.data.pid,
        childSession: parsedTarget.data.childSession,
      }
    }
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
      const childSession =
        typeof params['pid'] === 'number' ? this.childTargets.get(params['pid']) : undefined
      const scopedParams =
        childSession && typeof params['childSession'] !== 'string'
          ? { ...params, childSession }
          : params
      helper.child.stdin.write(`${JSON.stringify({ id, method, params: scopedParams })}\n`)
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

/** Run a build tool and resolve with its stdout. */
function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, COMPILE_TIMEOUT_MS)
    timer.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_DIAGNOSTIC_CHARS)
    })
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
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${file} exited with code ${String(code)}`))
    })
  })
}

let compiled: Promise<string> | null = null

/**
 * The designated requirement from `codesign -d -r-` output. Ad-hoc signatures
 * print theirs as a comment (`# designated => cdhash H"…"`). Null when the
 * output has none or it is not plain printable ASCII.
 */
export function parseDesignatedRequirement(output: string): string | null {
  const match = /^(?:# )?designated => (.+)$/m.exec(output)
  const requirement = match?.[1]?.trim()
  return requirement && /^[\x20-\x7e]+$/.test(requirement) ? requirement : null
}

/**
 * The helper source with the caller requirement prepended as a Swift constant.
 * The requirement is printable ASCII, so escaping `\` and `"` is enough.
 */
export function helperSourceWithCallerRequirement(source: string, requirement: string): string {
  const literal = requirement.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `let expectedCallerRequirement = "${literal}"\n${source}`
}

/** The code requirement of the running Copse executable: the helper's only accepted caller. */
async function copseCallerRequirement(env: NodeJS.ProcessEnv): Promise<string> {
  const output = await run('/usr/bin/codesign', ['-d', '-r-', process.execPath], env).catch(
    () => '',
  )
  const requirement = parseDesignatedRequirement(output)
  if (!requirement) {
    throw new Error(
      'Computer use needs a code-signed Copse: the desktop helper only accepts Copse as its caller.',
    )
  }
  return requirement
}

// ── Electron fuses ──────────────────────────────────────────────────────────
//
// The helper trusts any process with Copse's code signature. Electron can run
// that same signed executable as plain Node (ELECTRON_RUN_AS_NODE), take
// NODE_OPTIONS or --inspect, or load app code from outside the signed
// app.asar, so any of those would let another local program pass the caller
// check and drive the helper without Copse's approvals. A packaged build
// therefore serves computer use only when its fuses close all of them.

const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1')
const FUSE_WIRE_VERSION = 0x01
const FUSE_DISABLED = 0x30
const FUSE_ENABLED = 0x31

const REQUIRED_FUSES = [
  { index: 0, name: 'RunAsNode', state: FUSE_DISABLED },
  { index: 2, name: 'EnableNodeOptionsEnvironmentVariable', state: FUSE_DISABLED },
  { index: 3, name: 'EnableNodeCliInspectArguments', state: FUSE_DISABLED },
  { index: 4, name: 'EnableEmbeddedAsarIntegrityValidation', state: FUSE_ENABLED },
  { index: 5, name: 'OnlyLoadAppFromAsar', state: FUSE_ENABLED },
] as const

/**
 * The fuse wires in an Electron binary, one per architecture slice: the bytes
 * after each sentinel, its version byte and its length byte. Streamed, because
 * the framework binary is hundreds of megabytes.
 */
export async function readFuseWires(chunks: AsyncIterable<unknown>): Promise<Buffer[]> {
  const wires: Buffer[] = []
  let carry = Buffer.alloc(0)
  for await (const chunk of chunks) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary chunks')
    const buffer = Buffer.concat([carry, chunk])
    let keepFrom = Math.max(0, buffer.length - (FUSE_SENTINEL.length - 1))
    let searchFrom = 0
    for (;;) {
      const at = buffer.indexOf(FUSE_SENTINEL, searchFrom)
      if (at === -1) break
      const header = at + FUSE_SENTINEL.length
      const length = buffer[header + 1]
      if (length === undefined || header + 2 + length > buffer.length) {
        keepFrom = at
        break
      }
      if (buffer[header] !== FUSE_WIRE_VERSION)
        throw new Error('Unknown Electron fuse wire version')
      wires.push(Buffer.from(buffer.subarray(header + 2, header + 2 + length)))
      searchFrom = header + 2 + length
      keepFrom = Math.max(keepFrom, searchFrom)
    }
    carry = Buffer.from(buffer.subarray(keepFrom))
  }
  return wires
}

/** Names of the required fuses that any wire leaves open; all of them when there is no wire. */
export function openFuses(wires: readonly Buffer[]): string[] {
  return REQUIRED_FUSES.filter(
    ({ index, state }) => wires.length === 0 || wires.some((wire) => wire[index] !== state),
  ).map(({ name }) => name)
}

/** Refuse a packaged build whose fuses let another program run as Copse. */
async function assertFusesCloseOtherCallers(): Promise<void> {
  if (!isElectronAppPackaged()) return
  const framework = join(
    dirname(process.execPath),
    '..',
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework',
  )
  const open = openFuses(
    await readFuseWires(createReadStream(framework, { highWaterMark: 1 << 20 })).catch(() => []),
  )
  if (open.length) {
    throw new Error(
      `Computer use is unavailable in this build of Copse: its Electron fuses (${open.join(', ')}) would let other programs run as Copse and use the desktop helper's permissions.`,
    )
  }
}

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
 *
 * The Copse executable's own code requirement is compiled in, and the helper
 * refuses any other parent, so its privacy grants are not usable by other
 * local processes that run the binary directly. A packaged build must also
 * have its Electron fuses closed; a development build, which runs as Node by
 * design, is trusted as the developer's own.
 */
async function compileHelper(): Promise<string> {
  await assertFusesCloseOtherCallers()
  const sourceDirectory = helperSourceDirectory()
  const source = join(sourceDirectory, 'copse-desktop.swift')
  const plist = join(sourceDirectory, 'Info.plist')
  const [sourceText, plistBytes] = await Promise.all([readFile(source, 'utf8'), readFile(plist)])
  const directory = join(getElectronUserDataPath(), 'native-helpers', 'desktop-control')
  const binary = join(directory, 'copse-desktop')
  const moduleCache = join(directory, 'module-cache')
  const env = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCache,
    SWIFT_MODULE_CACHE_PATH: moduleCache,
  }
  const generatedSource = helperSourceWithCallerRequirement(
    sourceText,
    await copseCallerRequirement(env),
  )
  const digest = createHash('sha256')
    .update(generatedSource)
    .update(plistBytes)
    .digest('hex')
    .slice(0, 16)
  const configuredIdentity = process.env['CSC_NAME']?.trim()
  const identity = configuredIdentity?.length ? configuredIdentity : '-'
  const stamp = join(directory, 'build-stamp')
  const expectedStamp = `${digest} ${identity}`
  const currentStamp = await readFile(stamp, 'utf8').catch(() => '')
  if (currentStamp === expectedStamp && (await exists(binary))) return binary
  await mkdir(moduleCache, { recursive: true })
  const compiledSource = join(directory, 'copse-desktop.swift')
  await writeFile(compiledSource, generatedSource)
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
      compiledSource,
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

export function peekDesktopControlService(): DesktopControlService | null {
  return service
}

export function disposeDesktopControlService(): void {
  service?.dispose()
  service = null
}
