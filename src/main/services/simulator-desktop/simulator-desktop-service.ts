import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getElectronUserDataPath } from '../electron-app-runtime.ts'
import { isRecord, parseJsonUnknown } from '@shared/unknown-value.ts'
import type {
  SimulatorDesktopConnection,
  SimulatorDesktopDevice,
  SimulatorDesktopFrame,
  SimulatorDesktopInput,
  SimulatorDesktopStatus,
  SimulatorDesktopStatusEvent,
} from '@shared/types/simulator-desktop.ts'

export const SIMULATOR_DESKTOP_FRAME_CHANNEL = 'simulator-desktop:frame'
export const SIMULATOR_DESKTOP_STATUS_CHANNEL = 'simulator-desktop:status'

const MAX_FRAME_BYTES = 20 * 1024 * 1024
const MAX_DIAGNOSTIC_CHARS = 8_192

export interface SimulatorDesktopOwner {
  id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

interface NativeHelpers {
  capture: string
  input: string
}

interface ManagedSimulatorConnection {
  public: SimulatorDesktopConnection
  owner: SimulatorDesktopOwner
  capture: ChildProcessWithoutNullStreams | null
  input: ChildProcessWithoutNullStreams | null
  helpers: NativeHelpers | null
  closing: boolean
  connected: boolean
  pixelWidth: number
  pixelHeight: number
  stderr: string
}

interface SimctlDevice {
  udid?: unknown
  name?: unknown
  state?: unknown
  isAvailable?: unknown
}

let seededDevices: SimulatorDesktopDevice[] | null = null
let seededFrame: Omit<SimulatorDesktopFrame, 'id'> | null = null

function runtimeName(identifier: string): string {
  const suffix = identifier.split('.SimRuntime.').at(-1) ?? identifier
  const [candidatePlatform, ...version] = suffix.split('-')
  const platform = candidatePlatform ?? suffix
  return version.length > 0 ? `${platform} ${version.join('.')}` : suffix
}

function parsedBootedDevices(raw: string): SimulatorDesktopDevice[] {
  let parsed: unknown
  try {
    parsed = parseJsonUnknown(raw)
  } catch {
    throw new Error('Xcode returned invalid Simulator device data')
  }
  if (!isRecord(parsed)) return []
  const rawDevices = parsed['devices']
  if (!isRecord(rawDevices)) {
    return []
  }
  const devices: SimulatorDesktopDevice[] = []
  for (const [runtime, values] of Object.entries(rawDevices)) {
    if (!Array.isArray(values)) continue
    for (const value of values) {
      if (!isRecord(value)) continue
      const device: SimctlDevice = value
      if (
        device.state !== 'Booted' ||
        device.isAvailable === false ||
        typeof device.udid !== 'string' ||
        typeof device.name !== 'string'
      ) {
        continue
      }
      devices.push({ udid: device.udid, name: device.name, runtime: runtimeName(runtime) })
    }
  }
  return devices.sort((left, right) => left.name.localeCompare(right.name))
}

function runToString(
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_CHARS)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${file} exited with code ${String(code)}`))
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function helperSourceDirectory(): string {
  return join(__dirname, '..', 'resources', 'apple-simulator')
}

async function compileHelpers(): Promise<NativeHelpers> {
  const sourceDirectory = helperSourceDirectory()
  const [captureSource, inputSource] = await Promise.all([
    readFile(join(sourceDirectory, 'sim-capture.swift')),
    readFile(join(sourceDirectory, 'sim-input.m')),
  ])
  const digest = createHash('sha256')
    .update(captureSource)
    .update(inputSource)
    .digest('hex')
    .slice(0, 16)
  const directory = join(getElectronUserDataPath(), 'native-helpers', `apple-simulator-${digest}`)
  const sourceCache = join(directory, 'source')
  const moduleCache = join(directory, 'module-cache')
  const capture = join(directory, 'sim-capture')
  const input = join(directory, 'sim-input')
  await mkdir(sourceCache, { recursive: true })
  await mkdir(moduleCache, { recursive: true })
  if ((await exists(capture)) && (await exists(input))) return { capture, input }

  const capturePath = join(sourceCache, 'sim-capture.swift')
  const inputPath = join(sourceCache, 'sim-input.m')
  await Promise.all([writeFile(capturePath, captureSource), writeFile(inputPath, inputSource)])
  const environment = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: moduleCache,
    SWIFT_MODULE_CACHE_PATH: moduleCache,
  }
  await runToString(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-F',
      '/Library/Developer/PrivateFrameworks',
      '-framework',
      'CoreImage',
      '-framework',
      'Foundation',
      '-framework',
      'IOSurface',
      capturePath,
      '-o',
      capture,
    ],
    environment,
  ).catch((error: unknown) => {
    throw new Error(`Could not compile the Simulator framebuffer helper: ${String(error)}`)
  })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/xcrun',
      [
        'clang',
        '-fobjc-arc',
        '-O2',
        '-framework',
        'Foundation',
        '-framework',
        'CoreGraphics',
        inputPath,
        '-o',
        input,
      ],
      { env: environment, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_DIAGNOSTIC_CHARS)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim() || `clang exited with code ${String(code)}`))
    })
  }).catch((error: unknown) => {
    throw new Error(`Could not compile the Simulator input helper: ${String(error)}`)
  })
  return { capture, input }
}

export class SimulatorDesktopService {
  private readonly connections = new Map<string, ManagedSimulatorConnection>()
  private helpers: Promise<NativeHelpers> | null = null

  async listDevices(): Promise<SimulatorDesktopDevice[]> {
    if (seededDevices) return seededDevices.map((device) => ({ ...device }))
    if (process.platform !== 'darwin') return []
    const output = await runToString('/usr/bin/xcrun', [
      'simctl',
      'list',
      'devices',
      'booted',
      '--json',
    ])
    return parsedBootedDevices(output)
  }

  async open(udid: string, owner: SimulatorDesktopOwner): Promise<SimulatorDesktopConnection> {
    const device = (await this.listDevices()).find((candidate) => candidate.udid === udid)
    if (!device) throw new Error('That Simulator is no longer booted')
    const id = randomUUID()
    const publicConnection: SimulatorDesktopConnection = {
      id,
      device,
      status: 'connecting',
    }
    const managed: ManagedSimulatorConnection = {
      public: publicConnection,
      owner,
      capture: null,
      input: null,
      helpers: null,
      closing: false,
      connected: false,
      pixelWidth: 0,
      pixelHeight: 0,
      stderr: '',
    }
    this.connections.set(id, managed)

    if (seededFrame) return { ...publicConnection, device: { ...device } }

    const helperAttempt = this.helpers ?? compileHelpers()
    this.helpers = helperAttempt
    try {
      managed.helpers = await helperAttempt
      if (!this.connections.has(id)) return { ...publicConnection, status: 'closed' }
      return { ...publicConnection, device: { ...device } }
    } catch (error) {
      if (this.helpers === helperAttempt) this.helpers = null
      this.connections.delete(id)
      throw error
    }
  }

  start(id: string, ownerId: number): void {
    const connection = this.requireOwned(id, ownerId)
    if (seededFrame) {
      this.emitStatus(connection, 'connected')
      this.emitFrame(connection, seededFrame)
      return
    }
    if (!connection.helpers) throw new Error('Simulator helpers are not ready')
    if (connection.capture || connection.input) return
    this.startNativeHelpers(connection, connection.helpers)
  }

  sendInput(id: string, ownerId: number, input: SimulatorDesktopInput): void {
    const connection = this.requireOwned(id, ownerId)
    if (seededFrame) return
    if (!connection.input?.stdin.writable) throw new Error('Simulator control is not ready')
    connection.input.stdin.write(`${JSON.stringify(input)}\n`)
  }

  close(id: string, ownerId: number): Promise<void> {
    this.closeManaged(this.requireOwned(id, ownerId), 'closed')
    return Promise.resolve()
  }

  closeOwner(ownerId: number): Promise<void> {
    for (const connection of this.connections.values()) {
      if (connection.owner.id === ownerId) this.closeManaged(connection, 'closed')
    }
    return Promise.resolve()
  }

  closeAll(): Promise<void> {
    for (const connection of this.connections.values()) this.closeManaged(connection, 'closed')
    return Promise.resolve()
  }

  private startNativeHelpers(connection: ManagedSimulatorConnection, helpers: NativeHelpers): void {
    const capture = spawn(helpers.capture, [connection.public.device.udid])
    const input = spawn(helpers.input, [connection.public.device.udid])
    connection.capture = capture
    connection.input = input

    let frameBuffer = Buffer.alloc(0)
    capture.stdout.on('data', (chunk: Buffer) => {
      frameBuffer = Buffer.concat([frameBuffer, chunk])
      while (frameBuffer.length >= 4) {
        const length = frameBuffer.readUInt32BE(0)
        if (length === 0 || length > MAX_FRAME_BYTES) {
          this.closeManaged(connection, 'error', 'Simulator sent an invalid framebuffer')
          return
        }
        if (frameBuffer.length < length + 4) return
        const bytes = Uint8Array.from(frameBuffer.subarray(4, length + 4))
        frameBuffer = frameBuffer.subarray(length + 4)
        if (!connection.connected) this.emitStatus(connection, 'connected')
        this.emitFrame(connection, {
          bytes,
          mimeType: 'image/jpeg',
          pixelWidth: connection.pixelWidth,
          pixelHeight: connection.pixelHeight,
        })
      }
    })
    capture.stderr.setEncoding('utf8')
    capture.stderr.on('data', (chunk: string) => {
      connection.stderr = (connection.stderr + chunk).slice(-MAX_DIAGNOSTIC_CHARS)
      for (const line of chunk.split('\n')) {
        const marker = line.indexOf('{')
        if (marker < 0) continue
        try {
          const message = parseJsonUnknown(line.slice(marker))
          if (!isRecord(message)) continue
          if (message['type'] === 'stream-started') {
            if (typeof message['pixelWidth'] === 'number') {
              connection.pixelWidth = message['pixelWidth']
            }
            if (typeof message['pixelHeight'] === 'number') {
              connection.pixelHeight = message['pixelHeight']
            }
          }
        } catch {
          // Human-readable diagnostics share stderr with status JSON.
        }
      }
    })
    capture.once('error', (error) => {
      this.closeManaged(connection, 'error', error.message)
    })
    capture.once('close', (code, signal) => {
      if (connection.closing) return
      const reason = connection.stderr.trim().split('\n').at(-1)
      this.closeManaged(
        connection,
        'error',
        reason?.length ? reason : `Simulator framebuffer helper exited (${signal ?? String(code)})`,
      )
    })
    input.stderr.on('data', (chunk: Buffer) => {
      connection.stderr = (connection.stderr + chunk.toString('utf8')).slice(-MAX_DIAGNOSTIC_CHARS)
    })
    input.once('error', (error) => {
      this.closeManaged(connection, 'error', error.message)
    })
    input.once('close', (code, signal) => {
      if (connection.closing) return
      this.closeManaged(
        connection,
        'error',
        `Simulator input helper exited (${signal ?? String(code)})`,
      )
    })
  }

  private requireOwned(id: string, ownerId: number): ManagedSimulatorConnection {
    const connection = this.connections.get(id)
    if (!connection || connection.owner.id !== ownerId) {
      throw new Error('Unknown Simulator desktop connection')
    }
    return connection
  }

  private emitStatus(
    connection: ManagedSimulatorConnection,
    status: SimulatorDesktopStatus,
    detail?: string,
  ): void {
    connection.public.status = status
    connection.connected = status === 'connected'
    if (connection.owner.isDestroyed()) return
    const event: SimulatorDesktopStatusEvent = { id: connection.public.id, status }
    if (detail) event.detail = detail
    connection.owner.send(SIMULATOR_DESKTOP_STATUS_CHANNEL, event)
  }

  private emitFrame(
    connection: ManagedSimulatorConnection,
    frame: Omit<SimulatorDesktopFrame, 'id'>,
  ): void {
    if (connection.owner.isDestroyed()) return
    connection.owner.send(SIMULATOR_DESKTOP_FRAME_CHANNEL, {
      ...frame,
      id: connection.public.id,
      bytes: Uint8Array.from(frame.bytes),
    } satisfies SimulatorDesktopFrame)
  }

  private closeManaged(
    connection: ManagedSimulatorConnection,
    status: 'closed' | 'error',
    detail?: string,
  ): void {
    if (connection.closing) return
    connection.closing = true
    connection.capture?.kill('SIGTERM')
    connection.input?.stdin.end()
    connection.input?.kill('SIGTERM')
    this.connections.delete(connection.public.id)
    this.emitStatus(connection, status, detail)
  }
}

let service: SimulatorDesktopService | null = null

export function getSimulatorDesktopService(): SimulatorDesktopService {
  service ??= new SimulatorDesktopService()
  return service
}

export function setSeededSimulatorDesktopForTests(
  devices: SimulatorDesktopDevice[],
  frame: Omit<SimulatorDesktopFrame, 'id'> | null,
): void {
  seededDevices = devices.map((device) => ({ ...device }))
  seededFrame = frame ? { ...frame, bytes: Uint8Array.from(frame.bytes) } : null
}

export const simulatorDesktopInternals = { parsedBootedDevices, runtimeName }
