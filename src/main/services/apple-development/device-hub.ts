import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'

const exec = promisify(execFile)
const MAX_BYTES = 20 * 1024 * 1024
const identifierSchema = z.string().regex(/^[A-Za-z0-9-]{1,128}$/)
const propertiesSchema = z.object({
  connection: z.object({ state: z.string().optional() }).optional(),
  hardware: z
    .object({
      udid: identifierSchema.optional(),
      platform: z.string().optional(),
      reality: z.string().optional(),
    })
    .optional(),
  software: z
    .object({
      osVersionNumber: z.object({ stringValue: z.string() }).optional(),
    })
    .optional(),
  state: z.object({ name: z.string().optional(), bootState: z.string().optional() }).optional(),
})
const deviceListSchema = z.object({
  result: z.object({
    devices: z
      .array(
        z.object({
          identifier: identifierSchema,
          properties: propertiesSchema.optional(),
          visibilityClass: z.string().optional(),
          deviceProperties: z
            .object({
              name: z.string().optional(),
              osVersionNumber: z.string().optional(),
              bootState: z.string().optional(),
            })
            .optional(),
          hardwareProperties: z
            .object({
              udid: identifierSchema.optional(),
              platform: z.string().optional(),
            })
            .optional(),
          connectionProperties: z.object({ tunnelState: z.string().optional() }).optional(),
          capabilities: z.array(z.object({ featureIdentifier: z.string() })).optional(),
        }),
      )
      .max(1000),
  }),
})
const resultSchema = z.object({ result: z.record(z.string(), z.unknown()) })

export interface DeviceHubDevice {
  id: string
  udid: string
  name: string
  platform: string
  osVersion: string
  kind: 'simulator' | 'physical'
  connection: string
  bootState: string
  screenshot: boolean
  /** Native input is currently supported only through the Simulator helper. */
  input: boolean
}

export function parseDeviceHubDevices(json: string): DeviceHubDevice[] {
  const parsed = safeJsonParse(json, decodeWithSchema(deviceListSchema))
  if (!parsed) throw new Error('Xcode returned invalid Device Hub device data.')
  return parsed.result.devices.map((device) => {
    const properties = device.properties
    const simulator =
      properties?.hardware?.reality === 'simulated' || device.visibilityClass === 'simulators'
    return {
      id: device.identifier,
      udid: properties?.hardware?.udid ?? device.hardwareProperties?.udid ?? device.identifier,
      name: properties?.state?.name ?? device.deviceProperties?.name ?? device.identifier,
      platform: properties?.hardware?.platform ?? device.hardwareProperties?.platform ?? 'Apple',
      osVersion:
        properties?.software?.osVersionNumber?.stringValue ??
        device.deviceProperties?.osVersionNumber ??
        '',
      kind: simulator ? 'simulator' : 'physical',
      connection:
        properties?.connection?.state ?? device.connectionProperties?.tunnelState ?? 'unknown',
      bootState: properties?.state?.bootState ?? device.deviceProperties?.bootState ?? 'unknown',
      screenshot:
        device.capabilities?.some(
          (capability) =>
            capability.featureIdentifier === 'com.apple.coredevice.feature.capturescreenshot',
        ) ?? false,
      input: simulator,
    }
  })
}

async function run(file: string, args: string[], signal: AbortSignal): Promise<string> {
  const { stdout } = await exec(file, args, {
    signal,
    timeout: 30_000,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BYTES,
    encoding: 'utf8',
  })
  return stdout
}

/** Fixed argv, versioned JSON files, bounded processes, and per-call private scratch. */
export class DeviceHubService {
  private readonly execute: typeof run

  constructor(execute = run) {
    this.execute = execute
  }

  private async scratch<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(join(tmpdir(), 'copse-device-hub-'))
    try {
      return await operation(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async json(args: string[], signal: AbortSignal): Promise<string> {
    return this.scratch(async (directory) => {
      const output = join(directory, 'result.json')
      await this.execute(
        '/usr/bin/xcrun',
        ['devicectl', ...args, '--timeout', '25', '--json-output', output],
        signal,
      )
      if ((await stat(output)).size > MAX_BYTES)
        throw new Error('Device Hub returned too much data.')
      return readFile(output, 'utf8')
    })
  }

  async list(signal: AbortSignal): Promise<DeviceHubDevice[]> {
    return parseDeviceHubDevices(await this.json(['list', 'devices'], signal))
  }

  async device(id: string, signal: AbortSignal): Promise<DeviceHubDevice> {
    identifierSchema.parse(id)
    const device = (await this.list(signal)).find(
      (candidate) => candidate.id === id || candidate.udid === id,
    )
    if (!device)
      throw new Error('Device not found. Refresh Device Hub devices and select an explicit ID.')
    return device
  }

  async open(signal: AbortSignal): Promise<void> {
    const developerDir =
      process.env['DEVELOPER_DIR'] ??
      (await this.execute('/usr/bin/xcode-select', ['-p'], signal)).trim()
    const app = resolve(developerDir, '..', 'Applications', 'DeviceHub.app')
    if (!(await stat(app).catch(() => null))?.isDirectory()) {
      throw new Error(
        'Device Hub requires Xcode 27 or later. Select that Xcode with xcode-select or DEVELOPER_DIR.',
      )
    }
    await this.execute('/usr/bin/open', ['-a', app], signal)
  }

  async apps(id: string, signal: AbortSignal): Promise<string> {
    const device = await this.device(id, signal)
    return this.json(['device', 'info', 'apps', '--device', device.id], signal)
  }

  async launch(id: string, bundleId: string, signal: AbortSignal): Promise<string> {
    z.string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/)
      .parse(bundleId)
    const device = await this.device(id, signal)
    if (device.kind === 'simulator') {
      return this.execute('/usr/bin/xcrun', ['simctl', 'launch', device.udid, bundleId], signal)
    }
    const json = await this.json(
      ['device', 'process', 'launch', '--device', device.id, bundleId],
      signal,
    )
    const result = safeJsonParse(json, decodeWithSchema(resultSchema))
    if (!result) throw new Error('Xcode returned invalid launch results.')
    return JSON.stringify(result.result)
  }

  async screenshot(id: string, signal: AbortSignal): Promise<Buffer> {
    const device = await this.device(id, signal)
    return this.scratch(async (directory) => {
      const destination = join(directory, 'screen.png')
      if (device.kind === 'simulator') {
        await this.execute(
          '/usr/bin/xcrun',
          ['simctl', 'io', device.udid, 'screenshot', destination],
          signal,
        )
      } else {
        await this.execute(
          '/usr/bin/xcrun',
          [
            'devicectl',
            'device',
            'capture',
            'screenshot',
            '--device',
            device.id,
            '--destination',
            destination,
            '--timeout',
            '25',
          ],
          signal,
        )
      }
      if ((await stat(destination)).size > MAX_BYTES)
        throw new Error('Device screenshot exceeds 20 MiB.')
      const bytes = await readFile(destination)
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('Device Hub returned an invalid PNG screenshot.')
      }
      return bytes
    })
  }
}

export const deviceHubService = new DeviceHubService()
