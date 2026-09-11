import { execFile, spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  VaultError,
  type VaultIdentity,
  type VaultManifest,
  type VaultFailure,
} from './profile-vault-crypto.ts'

const execFileAsync = promisify(execFile)
const replySchema = z.strictObject({
  ok: z.boolean(),
  reason: z
    .enum(['unavailable', 'cancelled', 'corrupt', 'unsupported', 'untrusted', 'recovery-required'])
    .optional(),
  dataKey: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .optional(),
  deviceKeyId: z.uuid().optional(),
  deviceEnvelope: z.string().min(1).max(8192).optional(),
  recoveryVerified: z.boolean().optional(),
  requireAuth: z.boolean().optional(),
  automatic: z.boolean().optional(),
})
export type NativeVaultReply = z.infer<typeof replySchema>
export type NativeVaultOperation =
  | 'status'
  | 'create'
  | 'unlock'
  | 'backup'
  | 'recover'
  | 'set-auth'
export interface NativeVaultRequest extends VaultIdentity {
  operation: NativeVaultOperation
  profilePath: string
  deviceKeyId?: string
  deviceEnvelope?: string
  requireAuth?: boolean
  manifestMac?: string
  challenge?: string
  recovery?: VaultManifest['recovery']
}
export interface NativeVaultOptions {
  /** A pinned trusted helper, outside app.asar. No environment override at runtime. */
  executable: string
  teamId: string
}

/** Apple's requirement language uses ! (not the English word "not") for negation. */
export function vaultHelperRequirement(teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new VaultError('unavailable')
  return `=identifier "dev.copse.vault" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and ! entitlement["com.apple.security.cs.disable-library-validation"] exists and ! entitlement["com.apple.security.cs.allow-dyld-environment-variables"] exists and ! entitlement["com.apple.security.get-task-allow"] exists`
}

/** Signature and private channel checks happen on every invocation, including status. */
export async function callNativeVault(
  options: NativeVaultOptions,
  request: NativeVaultRequest,
  signal?: AbortSignal,
): Promise<NativeVaultReply> {
  if (process.platform !== 'darwin' || !/^[A-Z0-9]{10}$/.test(options.teamId))
    throw new VaultError('unavailable')
  try {
    await execFileAsync(
      '/usr/bin/codesign',
      ['--verify', '--strict', '-R', vaultHelperRequirement(options.teamId), options.executable],
      { timeout: 10_000, maxBuffer: 4096, ...(signal ? { signal } : {}) },
    )
  } catch {
    throw new VaultError(signal?.aborted ? 'cancelled' : 'unavailable')
  }
  if (signal?.aborted) throw new VaultError('cancelled')
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    })
    const socket = child.stdio[3]
    if (!(socket instanceof Duplex)) {
      child.kill()
      reject(new VaultError('unavailable'))
      return
    }
    const chunks: Buffer[] = []
    let bytes = 0
    let finished = false
    let authenticated = false
    const finish = (reply: NativeVaultReply | null, reason: VaultFailure): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.destroy()
      if (child.exitCode === null) child.kill()
      for (const chunk of chunks) chunk.fill(0)
      if (reply) resolve(reply)
      else reject(new VaultError(reason))
    }
    const abort = (): void => {
      finish(null, 'cancelled')
    }
    const timer = setTimeout(abort, 120_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    child.once('error', () => {
      finish(null, 'unavailable')
    })
    socket.on('error', () => {
      finish(null, 'unavailable')
    })
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 16384) {
        chunk.fill(0)
        finish(null, 'corrupt')
        return
      }
      chunks.push(chunk)
    })
    child.once('close', () => {
      if (!authenticated) {
        finish(null, 'unavailable')
        return
      }
      const data = Buffer.concat(chunks)
      const reply = safeJsonParse(data.toString('utf8'), decodeWithSchema(replySchema))
      data.fill(0)
      if (!reply) {
        finish(null, 'corrupt')
        return
      }
      if (!reply.ok) {
        const reason = reply.reason === 'untrusted' ? 'unavailable' : (reply.reason ?? 'corrupt')
        // Preserve typed cancellation/recovery errors without forwarding native output.
        if (!finished) {
          finish(null, reason)
        }
        return
      }
      finish(reply, 'corrupt')
    })
    child.once('spawn', () => {
      const pid = child.pid
      if (!pid) {
        finish(null, 'unavailable')
        return
      }
      // Verify the live process before releasing even an encrypted envelope.
      // Checking only a pathname would race replacement between verify/spawn.
      void execFileAsync(
        '/usr/bin/codesign',
        ['--verify', '--strict', '-R', vaultHelperRequirement(options.teamId), String(pid)],
        { timeout: 10_000, maxBuffer: 4096 },
      ).then(
        () => {
          if (finished) return
          authenticated = true
          const data = Buffer.from(JSON.stringify(request))
          const size = Buffer.alloc(4)
          size.writeUInt32BE(data.length)
          socket.end(Buffer.concat([size, data]))
        },
        () => {
          finish(null, 'unavailable')
        },
      )
    })
  })
}
export function nativeRequest(
  operation: NativeVaultOperation,
  profilePath: string,
  manifest: VaultIdentity &
    Partial<
      Pick<
        VaultManifest,
        'deviceKeyId' | 'deviceEnvelope' | 'requireAuth' | 'mac' | 'challenge' | 'recovery'
      >
    >,
): NativeVaultRequest {
  return {
    operation,
    profilePath,
    profileId: manifest.profileId,
    keyId: manifest.keyId,
    ...(manifest.deviceKeyId ? { deviceKeyId: manifest.deviceKeyId } : {}),
    ...(manifest.deviceEnvelope ? { deviceEnvelope: manifest.deviceEnvelope } : {}),
    ...(manifest.requireAuth === undefined ? {} : { requireAuth: manifest.requireAuth }),
    ...(manifest.mac ? { manifestMac: manifest.mac } : {}),
    ...(manifest.challenge ? { challenge: manifest.challenge } : {}),
    ...(manifest.recovery ? { recovery: manifest.recovery } : {}),
  }
}
