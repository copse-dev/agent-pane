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
  // SSH target must be the config alias so OpenSSH applies the full Host stanza
  // (ProxyCommand, ProxyJump, IdentityFile, Port, User, …). Do NOT copy
  // user/port/identity onto the persisted host — those become CLI `-p`/`-i`/
  // `user@host` overrides in OpenSshTransport and break ProxyCommand hosts
  // (wrong %p, wrong identity, "Connection closed by UNKNOWN port 65535").
  return {
    id: slug || alias.alias,
    label: alias.alias,
    host: alias.alias,
  }
}
