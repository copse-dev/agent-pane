/**
 * Approval seam for uploading and running the bundled file watcher
 * (native/remote-watcher) on an SSH workspace host.
 *
 * Same dependency-free hook shape as acp-remote-install-approval.ts, and for
 * the same reason: ssh-workspace modules are imported by code that also lands
 * in Electron-free worker bundles, so this module cannot import `approval.ts`
 * directly. The main process injects the real prompt at startup (index.ts).
 *
 * Fails closed: with no approver registered, nothing is uploaded or executed
 * and the caller stays on the polling floor.
 */

export interface RemoteWatcherInstallRequest {
  title: string
  body: string
}

type RemoteWatcherInstallApprover = (req: RemoteWatcherInstallRequest) => Promise<boolean>

let approver: RemoteWatcherInstallApprover | null = null

export function setRemoteWatcherInstallApprover(fn: RemoteWatcherInstallApprover | null): void {
  approver = fn
}

/** Ask the user. False (deny) whenever no approver is wired up. */
export async function approveRemoteWatcherInstall(
  req: RemoteWatcherInstallRequest,
): Promise<boolean> {
  if (!approver) return false
  return await approver(req)
}
