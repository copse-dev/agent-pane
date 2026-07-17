import type { ChildProcess } from 'node:child_process'
import { getRemoteProcessMeta } from '../ssh-workspace/remote-process-meta.ts'
import { getSshConnectionManager } from '../ssh-workspace/connection-manager.ts'

/** Send TERM then KILL to a remote process group over the SSH connection. */
export async function killRemoteProcessGroup(hostId: string, pgid: number): Promise<void> {
  const conn = getSshConnectionManager().getConnection(hostId)
  if (!conn) return
  const id = String(pgid)
  await conn.execShell(
    `kill -TERM -- -${id} 2>/dev/null; sleep 1; kill -KILL -- -${id} 2>/dev/null || true`,
  )
}

export async function terminateRemoteProcessTree(proc: ChildProcess): Promise<void> {
  const meta = getRemoteProcessMeta(proc)
  if (!meta) return
  await killRemoteProcessGroup(meta.hostId, meta.pgid)
}
