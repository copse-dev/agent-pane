import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'

export const SSH_HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function parseSshWorkspaceHosts(value: unknown): SshWorkspaceHost[] {
  return recordArrayOrEmpty(value).flatMap((entry) => {
    const id = entry['id']
    const label = entry['label']
    const hostName = entry['host']
    if (typeof id !== 'string' || typeof label !== 'string' || typeof hostName !== 'string') {
      return []
    }
    const host: SshWorkspaceHost = { id, label, host: hostName }
    if (typeof entry['port'] === 'number') host.port = entry['port']
    if (typeof entry['user'] === 'string') host.user = entry['user']
    if (typeof entry['identityFile'] === 'string') host.identityFile = entry['identityFile']
    if (typeof entry['forwardAgent'] === 'boolean') host.forwardAgent = entry['forwardAgent']
    return [host]
  })
}

/** Fields collected by the SSH host editor (settings + open-remote dialog). */
export interface SshHostDraft {
  id: string
  label: string
  host: string
  user: string
  port: string
  identityFile: string
  forwardAgent: boolean
}

export function emptySshHostDraft(): SshHostDraft {
  return {
    id: '',
    label: '',
    host: '',
    user: '',
    port: '',
    identityFile: '',
    forwardAgent: false,
  }
}

export function slugifyHostId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'host'
  )
}

export function upsertHost(list: SshWorkspaceHost[], host: SshWorkspaceHost): SshWorkspaceHost[] {
  const idx = list.findIndex((h) => h.id === host.id)
  if (idx === -1) return [...list, host]
  const next = [...list]
  next[idx] = host
  return next
}

export interface ImportSshHostsResult {
  hosts: SshWorkspaceHost[]
  importedHostIds: string[]
  firstAliasHostId: string | undefined
}

function nextAvailableHostId(baseId: string, usedIds: ReadonlySet<string>): string {
  if (!usedIds.has(baseId)) return baseId
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${String(suffixNumber)}`
    const candidate = `${baseId.slice(0, 64 - suffix.length)}${suffix}`
    if (!usedIds.has(candidate)) return candidate
  }
}

/** Merge discovered config aliases without losing aliases whose generated ids collide. */
export function importSshConfigHosts(
  existing: readonly SshWorkspaceHost[],
  aliases: readonly SshWorkspaceHost[],
): ImportSshHostsResult {
  const hosts = [...existing]
  const importedHostIds: string[] = []
  const usedIds = new Set(hosts.map((host) => host.id))
  let firstAliasHostId: string | undefined

  for (const alias of aliases) {
    const alreadyImported = hosts.find(
      (host) => host.host.toLowerCase() === alias.host.toLowerCase(),
    )
    if (alreadyImported) {
      firstAliasHostId ??= alreadyImported.id
      continue
    }

    const id = nextAvailableHostId(alias.id, usedIds)
    const imported = id === alias.id ? alias : { ...alias, id }
    hosts.push(imported)
    usedIds.add(id)
    importedHostIds.push(id)
    firstAliasHostId ??= id
  }

  return { hosts, importedHostIds, firstAliasHostId }
}

export function removeHost(list: SshWorkspaceHost[], id: string): SshWorkspaceHost[] {
  return list.filter((h) => h.id !== id)
}

export type ParseSshHostDraftResult =
  | { ok: true; host: SshWorkspaceHost }
  | { ok: false; error: string }

/** Validate draft fields and build a persisted host entry. */
export function parseSshHostDraft(draft: SshHostDraft): ParseSshHostDraftResult {
  const id = draft.id.trim() || slugifyHostId(draft.label || draft.host)
  if (!SSH_HOST_ID_RE.test(id)) {
    return { ok: false, error: 'Host id must be a lowercase slug (a-z, 0-9, -).' }
  }
  if (!draft.label.trim() || !draft.host.trim()) {
    return { ok: false, error: 'Label and host are required.' }
  }
  const host: SshWorkspaceHost = {
    id,
    label: draft.label.trim(),
    host: draft.host.trim(),
  }
  if (draft.user.trim()) host.user = draft.user.trim()
  const portText = draft.port.trim()
  if (portText) {
    const port = Number(portText)
    if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ok: false, error: 'Port must be a whole number from 1 to 65535.' }
    }
    host.port = port
  }
  if (draft.identityFile.trim()) host.identityFile = draft.identityFile.trim()
  if (draft.forwardAgent) host.forwardAgent = true
  return { ok: true, host }
}
