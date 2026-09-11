import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SimulatorDesktopDevice } from '@shared/types/simulator-desktop.ts'

export interface AndroidEndpoint {
  device: SimulatorDesktopDevice
  port: number
  token: string
}

// EmulatorAdvertisement writes these records, independently of the SDK/AVD location.
// Keep credentials in main; renderer IDs identify records, never arbitrary addresses.
export function androidDiscoveryDirectory(): string | null {
  return process.platform === 'darwin'
    ? join(homedir(), 'Library/Caches/TemporaryItems/avd/running')
    : null
}

function parseAdvertisement(text: string, pid: number): AndroidEndpoint | null {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  }
  const port = Number(fields.get('grpc.port'))
  const name = fields.get('avd.name') ?? fields.get('avd.id') ?? `Android emulator (${String(pid)})`
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  const token = fields.get('grpc.token') ?? ''
  const supported = token.length > 0 && token.length <= 8192 && /^[\x20-\x7e]+$/.test(token)
  return {
    device: {
      udid: `android:${String(pid)}`,
      platform: 'android',
      name: name.slice(0, 256),
      runtime: 'Android Emulator',
      ...(!supported
        ? {
            unavailableReason:
              'This emulator needs token authentication. Start it with -grpc-use-token to connect.',
          }
        : {}),
    },
    port,
    token: supported ? token : '',
  }
}

export async function discoverAndroidEndpoints(
  directory: string | null = androidDiscoveryDirectory(),
  isAlive: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
): Promise<AndroidEndpoint[]> {
  if (!directory) return []
  const files = await readdir(directory).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw new Error('Could not read Android emulator discovery records', { cause: error })
  })
  const endpoints: AndroidEndpoint[] = []
  for (const file of files.sort().slice(0, 128)) {
    const match = /^pid_(\d+)(?:_info)?\.ini$/.exec(file)
    const pid = Number(match?.[1])
    if (!match || !Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) continue
    // Ignore files that disappear during shutdown. Refuse symlinks and large records.
    const handle = await open(
      join(directory, file),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => null)
    if (!handle) continue
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 32768 || (process.getuid && info.uid !== process.getuid()))
        continue
      const bytes = Buffer.alloc(32769)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 32768) continue
      const endpoint = parseAdvertisement(bytes.subarray(0, bytesRead).toString('utf8'), pid)
      if (endpoint && !endpoints.some((entry) => entry.device.udid === endpoint.device.udid))
        endpoints.push(endpoint)
    } finally {
      await handle.close()
    }
  }
  return endpoints
}

export const androidDiscoveryInternals = { parseAdvertisement }
