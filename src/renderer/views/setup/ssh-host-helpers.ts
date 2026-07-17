import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

export const SSH_HOST_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

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
  const port = Number.parseInt(draft.port.trim(), 10)
  if (draft.port.trim() && Number.isFinite(port)) host.port = port
  if (draft.identityFile.trim()) host.identityFile = draft.identityFile.trim()
  if (draft.forwardAgent) host.forwardAgent = true
  return { ok: true, host }
}
