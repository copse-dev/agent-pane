import { constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { workspaceSandboxOverlay } from './config.ts'

const MAX_PUBLIC_KEY_BYTES = 16 * 1024

/**
 * Return the one macOS unix socket that a native git commit may use for SSH
 * signing. Every rejected input fails closed to the unchanged sandbox profile.
 */
export function sshAgentSocketAllowList(input: {
  readonly enabled: boolean
  readonly authSock: string | undefined
  readonly platform: NodeJS.Platform
  readonly isSocket: boolean
}): string[] {
  if (!input.enabled || input.platform !== 'darwin') return []
  const socketPath = input.authSock?.trim()
  if (!socketPath || !isAbsolute(socketPath) || normalize(socketPath) !== socketPath) return []
  return input.isSocket ? [socketPath] : []
}

/** Resolve and validate the socket named by the environment given to git. */
export async function resolveSshAgentSocketAllowList(input: {
  readonly enabled: boolean
  readonly authSock: string | undefined
  readonly platform: NodeJS.Platform
}): Promise<string[]> {
  const socketPath = input.authSock?.trim()
  let isSocket = false
  if (socketPath) {
    try {
      isSocket = (await stat(socketPath)).isSocket()
    } catch {
      isSocket = false
    }
  }
  return sshAgentSocketAllowList({ ...input, isSocket })
}

/**
 * Add the socket to this one git subprocess without widening its existing
 * filesystem or internet policy.
 */
export function gitCommitSigningSandboxOverlay(
  workspaceRoot: string,
  socketPaths: readonly string[],
): Partial<SandboxRuntimeConfig> {
  const base = workspaceSandboxOverlay(workspaceRoot)
  if (socketPaths.length === 0) return base
  const network = base.network
  if (!network) throw new Error('workspaceSandboxOverlay must define a network config')
  return {
    ...base,
    network: {
      ...network,
      allowUnixSockets: [...new Set(socketPaths)],
    },
  }
}

/** Parse one OpenSSH public-key line and discard its optional comment. */
export function parseSshPublicKey(text: string): string | null {
  const line = text.trim()
  if (!line || /[\r\n]/.test(line)) return null
  const match = /^(ssh-|ecdsa-|sk-)([^\s]+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+.*)?$/.exec(line)
  if (!match) return null
  const prefix = match[1]
  const suffix = match[2]
  const blob = match[3]
  if (!prefix || !suffix || !blob) return null
  const algorithm = `${prefix}${suffix}`
  try {
    if (Buffer.from(blob, 'base64').length === 0) return null
  } catch {
    return null
  }
  return `${algorithm} ${blob}`
}

/**
 * Convert a configured SSH signing-key path into Git's inline public-key form.
 *
 * Git commonly stores the private-key path even when ssh-agent performs the
 * private operation. The project sandbox must not read that private key, so use
 * its sibling .pub file instead. Reading happens in Copse's trusted main process;
 * the sandboxed git process receives only the public identity.
 */
export async function resolveInlineSshPublicSigningKey(
  configuredPath: string,
): Promise<string | null> {
  const trimmed = configuredPath.trim()
  if (!trimmed || trimmed.startsWith('key::')) return null
  const publicPath = trimmed.endsWith('.pub') ? trimmed : `${trimmed}.pub`
  if (!isAbsolute(publicPath) || normalize(publicPath) !== publicPath) return null

  let handle
  try {
    handle = await open(publicPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size <= 0 || info.size > MAX_PUBLIC_KEY_BYTES) return null
    const publicKey = parseSshPublicKey(await handle.readFile({ encoding: 'utf8' }))
    return publicKey ? `key::${publicKey}` : null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}
