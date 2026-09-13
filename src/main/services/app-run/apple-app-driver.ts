import { z } from 'zod'
import type {
  AppRunAction,
  AppRunApp,
  AppRunDevice,
  AppRunSelection,
  AppRunSetupInput,
  AppRunSetupOptions,
} from '@shared/types/app-run.ts'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import {
  detectAppleProject,
  InstalledXcodeDriver,
  type AppleDriverDiscovery,
} from '../apple-development/apple-driver.ts'
import type { AppleDestination } from '@shared/types/apple-development.ts'
import type {
  AppRunDriver,
  AppRunDriverDiscovery,
  AppRunDriverResult,
  AppRunProgress,
} from './app-run-driver.ts'
import { runAppProcess } from './app-run-process.ts'

const simSetupSchema = z.object({
  runtimes: z
    .array(
      z.object({ identifier: z.string(), name: z.string(), isAvailable: z.boolean().optional() }),
    )
    .optional(),
  devicetypes: z
    .array(
      z.object({ identifier: z.string(), name: z.string(), productFamily: z.string().optional() }),
    )
    .optional(),
})
function toDevice(device: AppleDestination): AppRunDevice {
  return {
    id: device.id,
    platform: 'apple',
    name: device.name,
    runtime: device.platform,
    state: !device.supported
      ? 'unavailable'
      : device.booted || device.platform === 'macOS'
        ? 'running'
        : 'stopped',
  }
}

export class AppleAppDriver implements AppRunDriver {
  private readonly discoveries = new Map<string, AppleDriverDiscovery>()
  private readonly driver: InstalledXcodeDriver
  private readonly platform: NodeJS.Platform
  constructor(driver = new InstalledXcodeDriver(), platform: NodeJS.Platform = process.platform) {
    this.driver = driver
    this.platform = platform
  }
  detect(root: string): Promise<boolean> {
    return detectAppleProject(root)
  }
  async discover(root: string, signal: AbortSignal): Promise<AppRunDriverDiscovery> {
    if (this.platform !== 'darwin')
      return {
        apps: [],
        devices: [],
        issues: [
          {
            platform: 'apple',
            message: 'Apple apps require a local Mac with Xcode.',
            action: 'open-xcode',
            label: 'Get Xcode',
          },
        ],
      }
    const discovery = await this.driver.discover(root, true, signal)
    this.discoveries.set(root, discovery)
    const apps = discovery.candidates.map((candidate): AppRunApp => ({
      id: `apple:${candidate.id}`,
      platform: 'apple',
      name: candidate.name,
      location: candidate.id,
      variants: candidate.schemes,
    }))
    const message =
      discovery.setupMessage ?? discovery.candidates.find((c) => c.metadataError)?.metadataError
    return {
      apps,
      devices: discovery.destinations.map(toDevice),
      issues: message
        ? [{ platform: 'apple', message, action: 'open-xcode', label: 'Open Xcode' }]
        : [],
    }
  }
  async devices(
    root: string,
    app: AppRunApp,
    signal: AbortSignal,
    variant = app.variants[0],
  ): Promise<AppRunDevice[]> {
    const discovery = this.discoveries.get(root)
    const candidate = discovery?.candidates.find((c) => c.id === app.location)
    if (!candidate || !discovery?.toolchain || !variant) return []
    return (
      await this.driver.destinations(
        root,
        candidate,
        variant,
        discovery.destinations,
        discovery.toolchain.developerDir,
        signal,
      )
    ).map(toDevice)
  }
  async execute(
    root: string,
    app: AppRunApp,
    selection: AppRunSelection,
    action: AppRunAction,
    operationId: string,
    progress: AppRunProgress,
    signal: AbortSignal,
  ): Promise<AppRunDriverResult> {
    const discovery = this.discoveries.get(root)
    if (!discovery?.toolchain) throw new Error('Load the installed Xcode before running.')
    const devices = await this.devices(root, app, signal, selection.variant)
    if (!devices.some((d) => d.id === selection.deviceId && d.state !== 'unavailable'))
      throw new Error('Choose a compatible Apple device.')
    const result = await this.driver.execute(
      {
        root,
        operationId,
        action,
        target: {
          candidateId: app.location,
          schemeId: selection.variant,
          configuration: selection.configuration,
          destinationId: selection.deviceId,
          revision: 1,
        },
        progress,
        provisioningUpdates: selection.provisioningUpdates,
      },
      discovery.toolchain.developerDir,
      signal,
    )
    if (result.exitCode !== 0)
      throw new Error(
        result.failureReason ??
          (result.logs.slice(-8000) || 'Xcode could not complete the operation.'),
      )
    const simulator = selection.deviceId.startsWith('platform=iOS Simulator')
      ? /(?:^|,)id=([^,]+)/.exec(selection.deviceId)?.[1]
      : undefined
    return {
      ...(action === 'run' && simulator ? { desktopId: simulator } : {}),
      ...(result.appSession ? { appSessionId: result.appSession.id } : {}),
    }
  }
  async stop(root: string, sessionId: string, signal: AbortSignal): Promise<void> {
    if (!(await this.driver.stopAppSession(sessionId, root, signal)))
      throw new Error('That Apple app is no longer tracked by Copse.')
  }
  async setupOptions(root: string, signal: AbortSignal): Promise<AppRunSetupOptions> {
    const output = await runAppProcess('/usr/bin/xcrun', ['simctl', 'list', '--json'], root, signal)
    const parsed = safeJsonParse(output, decodeWithSchema(simSetupSchema))
    if (!parsed) throw new Error('Xcode returned invalid Simulator metadata.')
    return {
      runtimes: (parsed.runtimes ?? [])
        .filter((r) => r.identifier.includes('.iOS-') && r.isAvailable !== false)
        .map((r) => ({ id: r.identifier, name: r.name, installed: true })),
      deviceTypes: (parsed.devicetypes ?? [])
        .filter(
          (d) =>
            d.productFamily === 'iPhone' ||
            d.productFamily === 'iPad' ||
            /iPhone|iPad/.test(d.name),
        )
        .map((d) => ({ id: d.identifier, name: d.name })),
    }
  }
  async setup(
    root: string,
    input: AppRunSetupInput,
    progress: AppRunProgress,
    signal: AbortSignal,
  ): Promise<void> {
    if (input.action === 'install-ios-runtime') {
      await runAppProcess('/usr/bin/xcodebuild', ['-downloadPlatform', 'iOS'], root, signal, {
        log: progress.log,
        timeoutMs: 2 * 60 * 60 * 1000,
      })
      return
    }
    if (input.action !== 'create-device') throw new Error('Unsupported Apple setup action.')
    const options = await this.setupOptions(root, signal)
    if (
      !input.name ||
      !options.runtimes.some((r) => r.id === input.runtimeId) ||
      !options.deviceTypes.some((d) => d.id === input.deviceTypeId)
    )
      throw new Error('Choose an installed runtime, device type, and name.')
    await runAppProcess(
      '/usr/bin/xcrun',
      ['simctl', 'create', input.name, input.deviceTypeId ?? '', input.runtimeId ?? ''],
      root,
      signal,
      { log: progress.log },
    )
  }
}
