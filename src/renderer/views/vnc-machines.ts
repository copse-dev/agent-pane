import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import type { VncNearbyServer } from '@shared/types/vnc.ts'

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
