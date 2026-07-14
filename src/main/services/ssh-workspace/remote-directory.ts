import type { SshRemoteDirEntry } from '@shared/types/ssh-workspace.ts'
import { getSshWorkspaceFs } from '../workspace-fs/ssh-workspace-fs.ts'
import { normalizeRemoteWorkspacePath, registerAllowedWorkspaceRoot } from '../workspace.ts'
import { getSshConnectionManager } from './connection-manager.ts'

export async function listRemoteDirectory(
  hostId: string,
  dirPath: string,
): Promise<SshRemoteDirEntry[]> {
  const browsePath = normalizeRemoteWorkspacePath(dirPath || '/')
  const mgr = getSshConnectionManager()
  if (!mgr.getConnection(hostId)) await mgr.connect(hostId)
  const fs = getSshWorkspaceFs(hostId, browsePath)
  const entries = await fs.readdirWithTypes(browsePath)
  return entries
    .filter((entry) => entry.isDir && entry.name !== '.' && entry.name !== '..')
    .map((entry) => ({
      name: entry.name,
      path: browsePath === '/' ? `/${entry.name}` : `${browsePath}/${entry.name}`,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function registerRemoteWorkspaceRoot(
  hostId: string,
  dirPath: string,
): Promise<string> {
  const normalized = normalizeRemoteWorkspacePath(dirPath)
  const mgr = getSshConnectionManager()
  if (!mgr.getConnection(hostId)) await mgr.connect(hostId)
  const fs = getSshWorkspaceFs(hostId, normalized)
  const canonical = normalizeRemoteWorkspacePath(await fs.realpath(normalized))
  const stat = await fs.stat(canonical)
  if (!stat.isDirectory()) {
    throw new Error(`Remote path is not a directory: ${dirPath}`)
  }
  return registerAllowedWorkspaceRoot(canonical, hostId)
}
