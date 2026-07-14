import { getSetting } from '../storage/settings.ts'
import type { SshConfigAlias, SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

export function listConfiguredSshHosts(): SshWorkspaceHost[] {
  return getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
}

export function findConfiguredSshHost(hostId: string): SshWorkspaceHost | undefined {
  return listConfiguredSshHosts().find((host) => host.id === hostId)
}

export function displayTarget(host: SshWorkspaceHost): string {
  const hostname = host.host.trim()
  if (hostname.includes('@')) return hostname
  if (host.user) return `${host.user}@${hostname}`
  return hostname
}

export function hostFromSshConfigAlias(alias: SshConfigAlias): SshWorkspaceHost {
  const slug = alias.alias
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const host: SshWorkspaceHost = {
    id: slug || alias.alias,
    label: alias.alias,
    host: alias.hostname ?? alias.alias,
  }
  if (alias.port !== undefined) host.port = alias.port
  if (alias.user) host.user = alias.user
  if (alias.identityFile) host.identityFile = alias.identityFile
  return host
}
