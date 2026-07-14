import type { SshExecResult } from '@shared/types/ssh-workspace.ts'
import { getSshConnectionManager } from './connection-manager.ts'

export async function execOnSshHost(
  hostId: string,
  remoteRoot: string,
  shellCommand: string,
  stdin?: string,
): Promise<SshExecResult> {
  const mgr = getSshConnectionManager()
  let conn = mgr.getConnection(hostId)
  if (!conn) conn = await mgr.connect(hostId)
  const options: { cwd: string; stdin?: string } = { cwd: remoteRoot }
  if (stdin !== undefined) options.stdin = stdin
  return conn.execShell(shellCommand, options)
}
