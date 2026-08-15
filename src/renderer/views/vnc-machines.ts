import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import type { VncNearbyServer, VncTarget } from '@shared/types/vnc.ts'

interface VncEndpoint {
  host: string
  port: number
}

function validPort(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const port = Number.parseInt(value, 10)
  return port >= 1 && port <= 65_535 ? port : null
}

/** Resolve an optional `:port` suffix while leaving bare IPv6 addresses intact. */
export function parseVncEndpoint(value: string, defaultPort: number): VncEndpoint | null {
  const input = value.trim()
  if (!input) return { host: '', port: defaultPort }

  if (input.startsWith('[')) {
    const match = /^\[([^\]]+)\](?::([^:]+))?$/.exec(input)
    if (!match?.[1]) return null
    if (match[2] === undefined) return { host: match[1], port: defaultPort }
    const port = validPort(match[2])
    return port === null ? null : { host: match[1], port }
  }

  const firstColon = input.indexOf(':')
  if (firstColon < 0 || firstColon !== input.lastIndexOf(':')) {
    return { host: input, port: defaultPort }
  }

  const host = input.slice(0, firstColon).trim()
  const port = validPort(input.slice(firstColon + 1).trim())
  return host && port !== null ? { host, port } : null
}

function endpointIdentity(value: string): string {
  const withoutUser = value.trim().toLowerCase().split('@').at(-1) ?? ''
  return withoutUser
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .replace(/\.local$/, '')
}

function nameIdentity(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function sshHostIdentities(host: SshWorkspaceHost): Set<string> {
  return new Set([`endpoint:${endpointIdentity(host.host)}`, `name:${nameIdentity(host.label)}`])
}

function nearbyIdentities(server: VncNearbyServer): Set<string> {
  return new Set([
    `endpoint:${endpointIdentity(server.host)}`,
    ...server.addresses.map((address) => `endpoint:${endpointIdentity(address)}`),
    `name:${nameIdentity(server.name)}`,
  ])
}

function setsOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) {
    if (value !== 'endpoint:' && value !== 'name:' && right.has(value)) return true
  }
  return false
}

/** Prefer the encrypted saved-SSH route when Bonjour advertises the same machine. */
export function dedupeNearbyVncServers(
  servers: readonly VncNearbyServer[],
  sshHosts: readonly SshWorkspaceHost[],
): VncNearbyServer[] {
  const sshIdentities = sshHosts.map(sshHostIdentities)
  const seenEndpoints = new Set<string>()
  const result: VncNearbyServer[] = []

  for (const server of servers) {
    const identities = nearbyIdentities(server)
    if (sshIdentities.some((identity) => setsOverlap(identities, identity))) continue

    const endpoints = [...identities]
      .filter((identity) => identity.startsWith('endpoint:') && identity !== 'endpoint:')
      .map((identity) => `${identity}:${String(server.port)}`)
    const fallback = `name:${nameIdentity(server.name)}:${String(server.port)}`
    const duplicateKeys = endpoints.length > 0 ? endpoints : [fallback]
    if (duplicateKeys.some((key) => seenEndpoints.has(key))) continue

    for (const key of duplicateKeys) seenEndpoints.add(key)
    result.push(server)
  }

  return result
}

/** Prefer a previously successful desktop login, then the SSH account name. */
export function preferredVncUsername(
  target: VncTarget,
  sshHosts: readonly SshWorkspaceHost[],
  remembered: string | null,
): string {
  const saved = remembered?.trim()
  if (saved) return saved
  if (target.kind !== 'ssh') return ''
  return sshHosts.find((host) => host.id === target.hostId)?.user?.trim() ?? ''
}
