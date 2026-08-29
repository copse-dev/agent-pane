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
