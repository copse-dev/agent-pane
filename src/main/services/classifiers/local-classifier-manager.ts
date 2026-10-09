import { spawn, type ChildProcess } from 'node:child_process'
import { CLASSIFIER_PRESETS, classifierEndpointKey } from '@copse/llm/classifiers/presets.ts'
import type { ClassifierProfile } from '@copse/llm/classifiers/types.ts'
import type {
  HostedClassifierHint,
  LocalClassifierOverview,
  LocalClassifierPhase,
  LocalClassifierStatus,
} from '@shared/local-classifiers.ts'
import { errorMessage } from '@shared/errors.ts'
import {
  LOCAL_CLASSIFIER_SERVERS,
  cacheEnvironment,
  cachePaths,
  cacheRoot,
  isClassifierInstalled,
  localClassifierEntry,
  prepareClassifierCache,
  removeClassifierInstall,
  type CachePaths,
  type CatalogEntry,
} from './local-server.mts'
import { getExplicitSettingsProfile } from '../storage/settings-context.ts'

/** How long a freshly started server may spend loading its weights before Copse gives up. */
const START_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 1_000
const STOP_GRACE_MS = 5_000
const OUTPUT_TAIL_LINES = 12
/** Weights unpack, and the virtual environment and checkout add to them: ask for headroom. */
const DISK_HEADROOM = 1.25
const GB = 1e9

/** Everything the manager touches outside itself, so tests can run it without Python or a network. */
export interface LocalClassifierDeps {
  prepare: typeof prepareClassifierCache
  isInstalled: typeof isClassifierInstalled
  portListening: (port: number) => Promise<boolean>
  programAvailable: (program: string) => Promise<boolean>
  /** Free bytes on the volume that will hold the cache; null when unknown. */
  freeBytes: (path: string) => Promise<number | null>
  uninstall: typeof removeClassifierInstall
  spawnServer: (command: readonly string[], paths: CachePaths) => ChildProcess
  listProfiles: () => ClassifierProfile[]
  saveProfile: (profile: ClassifierProfile) => Promise<unknown>
  env: NodeJS.ProcessEnv
  /** Resolves after `ms`, or sooner when aborted. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

interface Managed {
  controller: AbortController
  installing: boolean
  child?: ChildProcess
  /** Whether the child has been started and not yet exited. */
  alive: boolean
  progress?: string
  error?: string
  tail: string[]
}

/** Read through a function: `alive` flips from an exit listener, which narrowing cannot see. */
function isAlive(state: Managed): boolean {
  return state.alive
}

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/**
 * A setup command's failure in words a person can act on. The recognised
 * causes (no network, no disk space, a pinned commit that cannot be fetched)
 * name what to do; anything else keeps the command's own message.
 */
export function describeInstallFailure(error: unknown, entry: CatalogEntry): string {
  const message = errorMessage(error)
  if (/no space left on device|ENOSPC|disk quota exceeded/i.test(message)) {
    return `${entry.label} ran out of disk space during setup. Free some space or set COPSE_CLASSIFIER_CACHE to another disk, then try again. (${message})`
  }
  if (
    /could not resolve host|temporary failure in name resolution|network is unreachable|connection (timed out|refused|reset)|failed to connect|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|offline/i.test(
      message,
    )
  ) {
    return `Could not reach the network to download ${entry.label}. Check your connection, then try again. (${message})`
  }
  if (
    /couldn't find remote ref|not our ref|unable to read tree|reference is not a tree|bad object|invalid reference|did not match any/i.test(
      message,
    )
  ) {
    return `Could not fetch the pinned version of ${entry.label} (${entry.revision.slice(0, 12)}) from ${entry.repository}. The commit may have been removed upstream; nothing was installed. (${message})`
  }
  return message
}

function presetProfile(presetId: string): ClassifierProfile | undefined {
  const preset = CLASSIFIER_PRESETS.find((entry) => entry.id === presetId)
  return preset ? { ...preset, connection: { ...preset.connection } } : undefined
}

function endpointOf(profile: ClassifierProfile): string | null {
  return profile.connection.type === 'http'
    ? classifierEndpointKey(profile.connection.baseUrl)
    : null
}

/**
 * Detects self-hosted classifier servers on loopback and, on request, sets one
 * up and runs it. Opening settings only probes ports and reads a marker file:
 * nothing is downloaded, started or sent anywhere until a person asks.
 */
export class LocalClassifierManager {
  private readonly managed = new Map<string, Managed>()

  /** Servers whose files are being deleted: nothing may install or start them meanwhile. */
  private readonly uninstalling = new Set<string>()

  private readonly deps: LocalClassifierDeps

  constructor(deps: LocalClassifierDeps) {
    this.deps = deps
  }

  async overview(): Promise<LocalClassifierOverview> {
    const servers = await Promise.all(
      Object.entries(LOCAL_CLASSIFIER_SERVERS).map(([id, entry]) => this.statusOf(id, entry)),
    )
    return { servers, hosted: this.hostedHints() }
  }

  /** Download, set up, start and connect. Errors are recorded on the status, not thrown. */
  async install(id: string): Promise<LocalClassifierOverview> {
    const entry = this.entry(id)
    this.assertNotUninstalling(id, entry)
    const current = this.managed.get(id)
    if (current?.installing || current?.alive) return this.overview()
    const state = this.begin(id, true)
    void this.runInstall(id, entry, state)
    return this.overview()
  }

  async start(id: string): Promise<LocalClassifierOverview> {
    const entry = this.entry(id)
    this.assertNotUninstalling(id, entry)
    const current = this.managed.get(id)
    if (current?.installing || current?.alive) return this.overview()
    if (!(await this.deps.isInstalled(id, entry)))
      throw new Error(`${entry.label} is not installed.`)
    // Uninstall may have begun while the installed check was awaited.
    this.assertNotUninstalling(id, entry)
    const state = this.begin(id, false)
    void this.runStart(id, entry, state)
    return this.overview()
  }

  /** Stops a server this manager started, or cancels its install. A server started elsewhere is left alone. */
  async stop(id: string): Promise<LocalClassifierOverview> {
    this.entry(id)
    const state = this.managed.get(id)
    if (state) {
      state.controller.abort()
      await this.terminate(state)
    }
    return this.overview()
  }

  /**
   * Delete what this app installed for `id`. Refused while the server runs or
   * is being installed. The saved connection stays, so removing it is a
   * separate choice; the shared uv package cache stays too.
   */
  async uninstall(id: string): Promise<LocalClassifierOverview> {
    const entry = this.entry(id)
    const current = this.managed.get(id)
    if (current?.installing || current?.alive) {
      throw new Error(`Stop ${entry.label} before uninstalling it.`)
    }
    if (this.uninstalling.has(id)) return this.overview()
    // Reserve the server before the first await, so an install or start that
    // arrives while the port is probed or the files are removed is refused
    // instead of running on a cache that is being deleted.
    this.uninstalling.add(id)
    try {
      if (await this.deps.portListening(entry.port)) {
        throw new Error(
          `${entry.label} is running on port ${String(entry.port)}. Stop it before uninstalling.`,
        )
      }
      await this.deps.uninstall(id, entry)
      this.managed.delete(id)
    } finally {
      this.uninstalling.delete(id)
    }
    return this.overview()
  }

  private assertNotUninstalling(id: string, entry: CatalogEntry): void {
    if (this.uninstalling.has(id)) {
      throw new Error(`${entry.label} is being uninstalled. Try again when that finishes.`)
    }
  }

  /** Save the preset connection for a server that is already running. */
  async connect(id: string): Promise<LocalClassifierOverview> {
    const entry = this.entry(id)
    if (!(await this.deps.portListening(entry.port))) {
      throw new Error(`${entry.label} is not running on port ${String(entry.port)}.`)
    }
    await this.ensureProfile(entry)
    return this.overview()
  }

  /** Stop every server this manager started. Called on quit. */
  stopAll(): void {
    for (const state of this.managed.values()) {
      state.controller.abort()
      state.child?.kill('SIGTERM')
    }
  }

  private entry(id: string): CatalogEntry {
    const entry = localClassifierEntry(id)
    if (!entry) throw new Error('Unknown local classifier.')
    return entry
  }

  private begin(id: string, installing: boolean): Managed {
    const state: Managed = {
      controller: new AbortController(),
      installing,
      alive: false,
      tail: [],
    }
    this.managed.set(id, state)
    return state
  }

  private async runInstall(id: string, entry: CatalogEntry, state: Managed): Promise<void> {
    try {
      const missing = await this.missingPrograms(entry)
      if (missing.length > 0) {
        throw new Error(`Install ${missing.join(' and ')} first, then try again.`)
      }
      if (await this.deps.portListening(entry.port)) {
        throw new Error(
          `Port ${String(entry.port)} is already in use. Stop whatever is listening there first; nothing was downloaded.`,
        )
      }
      await this.assertDiskSpace(id, entry)
      state.progress = 'Starting setup…'
      await this.deps.prepare(id, entry, {
        signal: state.controller.signal,
        onLine: (line) => {
          state.progress = line.trim().slice(0, 200)
        },
      })
    } catch (error) {
      this.fail(state, describeInstallFailure(error, entry))
      state.installing = false
      return
    }
    state.installing = false
    await this.runStart(id, entry, state)
  }

  private async runStart(id: string, entry: CatalogEntry, state: Managed): Promise<void> {
    try {
      if (await this.deps.portListening(entry.port)) {
        throw new Error(
          `Port ${String(entry.port)} is already in use. Stop whatever is listening there first.`,
        )
      }
      const paths = cachePaths(id, entry)
      state.progress = 'Loading the model…'
      const child = this.deps.spawnServer(entry.serve(paths), paths)
      state.child = child
      state.alive = true
      state.tail = []
      const keep = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split(/\r\n|\r|\n/u)) {
          if (!line.trim()) continue
          state.tail = [...state.tail, line.trim()].slice(-OUTPUT_TAIL_LINES)
          state.progress = line.trim().slice(0, 200)
        }
      }
      child.stdout?.on('data', keep)
      child.stderr?.on('data', keep)
      const exited = new Promise<number | null>((resolve) => {
        child.once('error', (error) => {
          state.tail = [...state.tail, error.message].slice(-OUTPUT_TAIL_LINES)
          resolve(null)
        })
        child.once('close', (code) => {
          resolve(code)
        })
      })
      void exited.then((code) => {
        state.alive = false
        if (!state.controller.signal.aborted) {
          state.error =
            `${entry.label} stopped (exit ${String(code)}). ${state.tail.slice(-3).join(' ')}`.trim()
        }
      })
      await this.waitUntilListening(entry.port, state)
      if (!isAlive(state)) return
      delete state.progress
      await this.ensureProfile(entry)
    } catch (error) {
      this.fail(state, error)
      await this.terminate(state)
    }
  }

  private async waitUntilListening(port: number, state: Managed): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (state.alive && !state.controller.signal.aborted) {
      if (await this.deps.portListening(port)) return
      if (Date.now() > deadline) {
        throw new Error('The server did not start listening in time.')
      }
      await this.deps.sleep(POLL_MS, state.controller.signal)
    }
  }

  private async terminate(state: Managed): Promise<void> {
    const child = state.child
    if (!child || !isAlive(state)) return
    child.kill('SIGINT')
    const deadline = Date.now() + STOP_GRACE_MS
    while (isAlive(state) && Date.now() < deadline) {
      await this.deps.sleep(100, new AbortController().signal)
    }
    if (isAlive(state)) child.kill('SIGKILL')
  }

  private fail(state: Managed, error: unknown): void {
    delete state.progress
    if (state.controller.signal.aborted) return
    state.error = errorMessage(error)
  }

  private async assertDiskSpace(id: string, entry: CatalogEntry): Promise<void> {
    // A finished earlier setup downloads nothing more.
    if (await this.deps.isInstalled(id, entry)) return
    const root = cacheRoot()
    const free = await this.deps.freeBytes(root)
    const needed = entry.downloadGb * GB * DISK_HEADROOM
    if (free === null || free >= needed) return
    throw new Error(
      `Not enough free disk space for ${entry.label}: about ${(needed / GB).toFixed(1)} GB is needed and ${(free / GB).toFixed(1)} GB is free at ${root}. Free some space or set COPSE_CLASSIFIER_CACHE to another disk, then try again. Nothing was downloaded.`,
    )
  }

  private async missingPrograms(entry: CatalogEntry): Promise<string[]> {
    const present = await Promise.all(
      entry.prerequisites.map((program) => this.deps.programAvailable(program)),
    )
    return entry.prerequisites.filter((_, index) => !present[index])
  }

  private savedFor(entry: CatalogEntry): boolean {
    const preset = presetProfile(entry.presetId)
    const endpoint = preset ? endpointOf(preset) : null
    return (
      endpoint !== null &&
      this.deps.listProfiles().some((profile) => endpointOf(profile) === endpoint)
    )
  }

  private async ensureProfile(entry: CatalogEntry): Promise<void> {
    if (this.savedFor(entry)) return
    const profile = presetProfile(entry.presetId)
    if (!profile) throw new Error('No connection preset for this classifier.')
    await this.deps.saveProfile(profile)
  }

  private async statusOf(id: string, entry: CatalogEntry): Promise<LocalClassifierStatus> {
    const state = this.managed.get(id)
    const listening = await this.deps.portListening(entry.port)
    const installed = await this.deps.isInstalled(id, entry)
    let phase: LocalClassifierPhase
    if (state?.installing) phase = 'installing'
    else if (state?.alive) phase = listening ? 'running' : 'starting'
    else if (listening) phase = 'external'
    else phase = installed ? 'installed' : 'not-installed'
    const missing = phase === 'not-installed' && !listening ? await this.missingPrograms(entry) : []
    return {
      id,
      label: entry.label,
      presetId: entry.presetId,
      baseUrl: `http://127.0.0.1:${String(entry.port)}/v1`,
      phase,
      downloadGb: entry.downloadGb,
      source: entry.repository,
      needs: [...entry.prerequisites],
      missing,
      saved: this.savedFor(entry),
      ...(state?.progress && (phase === 'installing' || phase === 'starting')
        ? { progress: state.progress }
        : {}),
      ...(state?.error && phase !== 'installing' && phase !== 'starting' && phase !== 'running'
        ? { error: state.error }
        : {}),
    }
  }

  /**
   * A hosted preset's provider key sitting in the environment is a hint, not a
   * credential grab: it is named, never read into the result, and only the
   * preset's own endpoint may use it.
   */
  private hostedHints(): HostedClassifierHint[] {
    if (getExplicitSettingsProfile()) return []
    const saved = new Set(this.deps.listProfiles().map(endpointOf))
    return CLASSIFIER_PRESETS.flatMap((preset) => {
      const connection = preset.connection
      if (connection.type !== 'http' || connection.auth !== 'bearer' || !connection.apiKeyEnv)
        return []
      if (!this.deps.env[connection.apiKeyEnv]?.trim()) return []
      if (saved.has(classifierEndpointKey(connection.baseUrl))) return []
      return [{ presetId: preset.id, label: preset.label, envVar: connection.apiKeyEnv }]
    })
  }
}

export function spawnLocalServer(command: readonly string[], paths: CachePaths): ChildProcess {
  const [program, ...args] = command
  if (!program) throw new Error('Empty command.')
  return spawn(program, args, {
    cwd: paths.checkout,
    env: cacheEnvironment(paths.root),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
