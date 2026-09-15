import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import {
  appRunOperationSchema,
  appRunSelectionSchema,
  type AppRunAction,
  type AppRunApp,
  type AppRunDiscovery,
  type AppRunOperation,
  type AppRunOwner,
  type AppRunPlatform,
  type AppRunSelection,
  type AppRunSetupInput,
  type AppRunSetupOptions,
} from '@shared/types/app-run.ts'
import { storageGet, storageUpdate } from '../storage/storage.ts'
import { getProjectRoot } from '../workspace.ts'
import { resolveThreadExecutionContext } from '../thread-execution-context.ts'
import { isAppleDevelopmentProjectSupported } from '../apple-development/apple-development-service.ts'
import { showSimulatorDesktop } from '../simulator-desktop/simulator-desktop-panel.ts'
import { setSetting } from '../storage/settings.ts'
import { AppleAppDriver } from './apple-app-driver.ts'
import { AndroidAppDriver } from './android-app-driver.ts'
import type { AppRunDriver, AppRunProgress } from './app-run-driver.ts'

const STORE = 'app-run.state'
const schema = z.object({
  preferences: z.record(z.string(), appRunSelectionSchema),
  operations: z.array(appRunOperationSchema).max(20),
})
const empty = (): z.infer<typeof schema> => ({ preferences: {}, operations: [] })
const ownerKey = (owner: AppRunOwner): string =>
  JSON.stringify([owner.projectId, owner.threadId ?? null])
const active = (op: AppRunOperation): boolean =>
  !['running', 'succeeded', 'failed', 'cancelled', 'stopped'].includes(op.stage)
const read = (): z.infer<typeof schema> => {
  const parsed = schema.safeParse(storageGet(STORE))
  return parsed.success ? parsed.data : empty()
}
interface ResolvedApp {
  root: string
  app: AppRunApp
  driver: AppRunDriver
}
interface LiveOperation {
  operation: AppRunOperation
  root: string
  driver: AppRunDriver
  controller: AbortController
  appId: string | null
  deviceKey: string | null
}
export interface AppRunServiceDependencies {
  drivers?: Record<AppRunPlatform, AppRunDriver>
  resolveRoot?: (owner: AppRunOwner) => Promise<string>
  present?: (id: string, owner: AppRunOwner) => Promise<void>
}
async function resolveRoot(owner: AppRunOwner): Promise<string> {
  if (!isAppleDevelopmentProjectSupported(owner.projectId))
    throw new Error('App running currently requires a local macOS project.')
  if (owner.threadId)
    return realpath((await resolveThreadExecutionContext(owner.projectId, owner.threadId)).root)
  const root = getProjectRoot(owner.projectId)
  if (!root) throw new Error('The project is no longer available.')
  return realpath(root)
}
export class AppRunService {
  private readonly drivers: Record<AppRunPlatform, AppRunDriver>
  private readonly resolveRoot: (owner: AppRunOwner) => Promise<string>
  private readonly present: (id: string, owner: AppRunOwner) => Promise<void>
  private readonly discoveries = new Map<string, { root: string; result: AppRunDiscovery }>()
  private readonly discoveryControllers = new Map<string, AbortController>()
  private readonly live = new Map<string, LiveOperation>()
  constructor(dependencies: AppRunServiceDependencies = {}) {
    this.drivers = dependencies.drivers ?? {
      apple: new AppleAppDriver(),
      android: new AndroidAppDriver(),
    }
    this.resolveRoot = dependencies.resolveRoot ?? resolveRoot
    this.present =
      dependencies.present ??
      (async (id, owner): Promise<void> => {
        await setSetting('vncEnabled', true)
        showSimulatorDesktop(id, { control: true, owner })
      })
  }
  async detect(owner: AppRunOwner): Promise<boolean> {
    try {
      const root = await this.resolveRoot(owner)
      return (await Promise.all(Object.values(this.drivers).map((d) => d.detect(root)))).some(
        Boolean,
      )
    } catch {
      return false
    }
  }
  async discover(owner: AppRunOwner): Promise<AppRunDiscovery> {
    const key = ownerKey(owner)
    this.discoveryControllers.get(key)?.abort()
    const controller = new AbortController()
    this.discoveryControllers.set(key, controller)
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60 * 1000)])
    try {
      const root = await this.resolveRoot(owner)
      const saved = read().preferences[owner.projectId]
      const result: AppRunDiscovery = {
        apps: [],
        devices: [],
        issues: [],
        preferred: saved ? { ...saved, provisioningUpdates: false } : null,
      }
      for (const driver of Object.values(this.drivers)) {
        if (!(await driver.detect(root))) continue
        const discovered = await driver.discover(root, signal)
        result.apps.push(...discovered.apps)
        result.devices.push(...discovered.devices)
        result.issues.push(...discovered.issues)
      }
      signal.throwIfAborted()
      if (
        result.preferred &&
        !result.apps.some(
          (app) =>
            app.id === result.preferred?.appId && app.variants.includes(result.preferred.variant),
        )
      )
        result.preferred = null
      this.discoveries.set(key, { root, result })
      return result
    } finally {
      if (this.discoveryControllers.get(key) === controller) this.discoveryControllers.delete(key)
    }
  }
  cancelDiscovery(owner: AppRunOwner): void {
    this.discoveryControllers.get(ownerKey(owner))?.abort()
  }
  private async resolveApp(owner: AppRunOwner, appId: string): Promise<ResolvedApp> {
    const root = await this.resolveRoot(owner)
    const discovery = this.discoveries.get(ownerKey(owner))
    const app = discovery?.result.apps.find((a) => a.id === appId)
    if (!app || discovery?.root !== root)
      throw new Error('This checkout or app changed. Refresh the app targets before running.')
    return { root, app, driver: this.drivers[app.platform] }
  }
  async devices(
    owner: AppRunOwner,
    appId: string,
    variant: string,
  ): Promise<AppRunDiscovery['devices']> {
    const { root, app, driver } = await this.resolveApp(owner, appId)
    if (!app.variants.includes(variant)) throw new Error('Choose an available app variant.')
    return driver.devices(root, app, AbortSignal.timeout(120_000), variant)
  }
  private async save(operation: AppRunOperation, selection?: AppRunSelection): Promise<void> {
    await storageUpdate(STORE, (raw) => {
      const parsed = schema.safeParse(raw)
      const state = parsed.success ? parsed.data : read()
      return {
        preferences: selection
          ? { ...state.preferences, [operation.owner.projectId]: selection }
          : state.preferences,
        operations: [operation, ...state.operations.filter((op) => op.id !== operation.id)].slice(
          0,
          20,
        ),
      }
    })
  }
  async operations(owner: AppRunOwner): Promise<AppRunOperation[]> {
    await this.resolveRoot(owner)
    const stored = read().operations.filter((op) => ownerKey(op.owner) === ownerKey(owner))
    const result = new Map(
      stored.map((op) => [
        op.id,
        this.live.get(op.id)?.operation ??
          (active(op) || op.stage === 'running'
            ? {
                ...op,
                stage: 'failed' as const,
                error: 'Copse restarted. Run again to start a new operation.',
                appSessionId: null,
              }
            : op),
      ]),
    )
    for (const { operation } of this.live.values())
      if (ownerKey(operation.owner) === ownerKey(owner)) result.set(operation.id, operation)
    return [...result.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 10)
  }
  private start(
    owner: AppRunOwner,
    root: string,
    driver: AppRunDriver,
    action: AppRunOperation['action'],
    appName: string,
    deviceName: string,
    selection?: AppRunSelection,
  ): LiveOperation {
    const deviceKey = action === 'run' ? (selection?.deviceId ?? null) : null
    if (
      [...this.live.values()].some(
        (entry) =>
          (entry.root === root || (deviceKey && entry.deviceKey === deviceKey)) &&
          active(entry.operation),
      )
    )
      throw new Error('An app operation is already running in this checkout.')
    const operation: AppRunOperation = {
      id: randomUUID(),
      owner,
      action,
      stage: 'queued',
      appName,
      deviceName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      logs: '',
      error: null,
      desktopId: null,
      appSessionId: null,
    }
    const entry = {
      operation,
      root,
      driver,
      controller: new AbortController(),
      appId: selection?.appId ?? null,
      deviceKey,
    }
    this.live.set(operation.id, entry)
    return entry
  }
  private progress(entry: LiveOperation): AppRunProgress {
    return {
      stage: (stage): void => {
        if (entry.controller.signal.aborted) return
        entry.operation.stage = stage
        entry.operation.updatedAt = Date.now()
      },
      log: (text): void => {
        entry.operation.logs = (entry.operation.logs + text).slice(-256_000)
        entry.operation.updatedAt = Date.now()
      },
    }
  }
  async execute(
    owner: AppRunOwner,
    selection: AppRunSelection,
    action: AppRunAction,
  ): Promise<AppRunOperation> {
    const { root, app, driver } = await this.resolveApp(owner, selection.appId)
    if (!app.variants.includes(selection.variant))
      throw new Error('Choose an available app variant.')
    const devices = await driver.devices(root, app, AbortSignal.timeout(120_000), selection.variant)
    const device = devices.find((d) => d.id === selection.deviceId && d.state !== 'unavailable')
    if ((action === 'run' || app.platform === 'apple') && !device)
      throw new Error('Choose a compatible device.')
    const entry = this.start(owner, root, driver, action, app.name, device?.name ?? '', selection)
    try {
      await this.save(entry.operation, selection)
    } catch (error) {
      this.live.delete(entry.operation.id)
      throw error
    }
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(30 * 60 * 1000)])
    void this.perform(entry, async () => {
      if (action === 'run') {
        for (const previous of this.live.values()) {
          if (
            previous !== entry &&
            previous.root === root &&
            previous.appId === app.id &&
            previous.deviceKey === entry.deviceKey &&
            previous.operation.stage === 'running' &&
            ownerKey(previous.operation.owner) === ownerKey(owner)
          ) {
            await this.stop(owner, previous.operation.id)
          }
        }
      }
      const result = await driver.execute(
        root,
        app,
        selection,
        action,
        entry.operation.id,
        this.progress(entry),
        signal,
      )
      if (signal.aborted && result.appSessionId)
        await driver.stop(root, result.appSessionId, AbortSignal.timeout(10_000)).catch(() => {})
      signal.throwIfAborted()
      entry.operation.stage = action === 'run' ? 'running' : 'succeeded'
      entry.operation.appSessionId = result.appSessionId ?? null
      entry.operation.desktopId = result.desktopId ?? null
      if (result.desktopId) {
        try {
          await this.present(result.desktopId, owner)
        } catch (error) {
          entry.operation.logs += `\nApp launched, but Desktop could not open: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    })
    return entry.operation
  }
  private async perform(entry: LiveOperation, run: () => Promise<void>): Promise<void> {
    try {
      await run()
    } catch (error) {
      entry.operation.stage = entry.controller.signal.aborted ? 'cancelled' : 'failed'
      entry.operation.error = error instanceof Error ? error.message : String(error)
    } finally {
      entry.operation.updatedAt = Date.now()
      await this.save(entry.operation).catch(() => {})
      if (entry.operation.stage !== 'running') this.live.delete(entry.operation.id)
    }
  }
  async cancel(owner: AppRunOwner, id: string): Promise<void> {
    await this.resolveRoot(owner)
    const entry = this.live.get(id)
    if (!entry || ownerKey(entry.operation.owner) !== ownerKey(owner))
      throw new Error('No active operation with that ID belongs to this context.')
    if (!active(entry.operation))
      throw new Error('This operation has finished. Use Stop app to stop the app.')
    entry.controller.abort()
  }
  async stop(owner: AppRunOwner, id: string): Promise<void> {
    const root = await this.resolveRoot(owner)
    const entry = this.live.get(id)
    if (
      !entry ||
      entry.root !== root ||
      ownerKey(entry.operation.owner) !== ownerKey(owner) ||
      !entry.operation.appSessionId
    )
      throw new Error('No running app with that ID belongs to this context.')
    await entry.driver.stop(root, entry.operation.appSessionId, AbortSignal.timeout(20_000))
    entry.operation.stage = 'stopped'
    entry.operation.appSessionId = null
    entry.operation.updatedAt = Date.now()
    await this.save(entry.operation)
    this.live.delete(id)
  }
  async setupOptions(owner: AppRunOwner, platform: AppRunPlatform): Promise<AppRunSetupOptions> {
    return this.drivers[platform].setupOptions(
      await this.resolveRoot(owner),
      AbortSignal.timeout(120_000),
    )
  }
  async setup(owner: AppRunOwner, input: AppRunSetupInput): Promise<AppRunOperation> {
    const root = await this.resolveRoot(owner)
    const driver = this.drivers[input.platform]
    const entry = this.start(
      owner,
      root,
      driver,
      'setup',
      input.platform === 'apple' ? 'Apple setup' : 'Android setup',
      '',
    )
    entry.operation.stage = 'setting-up'
    try {
      await this.save(entry.operation)
    } catch (error) {
      this.live.delete(entry.operation.id)
      throw error
    }
    void this.perform(entry, async () => {
      await driver.setup(
        root,
        input,
        this.progress(entry),
        AbortSignal.any([entry.controller.signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]),
      )
      entry.operation.stage = 'succeeded'
    })
    return entry.operation
  }
  dispose(): void {
    for (const controller of this.discoveryControllers.values()) controller.abort()
    for (const entry of this.live.values()) if (active(entry.operation)) entry.controller.abort()
  }
}
let service: AppRunService | undefined
export function getAppRunService(): AppRunService {
  return (service ??= new AppRunService())
}
