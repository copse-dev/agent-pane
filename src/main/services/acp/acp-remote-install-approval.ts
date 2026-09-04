/**
 * The approval seam for installing an ACP adapter on a *remote* host.
 *
 * `acp-ssh-transport.ts` reaches this point from inside `acp-client.ts`, which
 * is bundled into the ACP probe and session-host workers (see the "bundles free
 * of electron and node-pty" guards). Importing `approval.ts` there would drag
 * Electron — and through it node-pty — into those worker bundles and break them
 * at require time. So the transport depends on this dependency-free hook and the
 * main process injects the real, IPC-backed prompt.
 *
 * It fails closed: with no approver registered (exactly the case inside a
 * worker, which has no channel to show a dialog on) nothing is installed and the
 * caller falls back to the "install it yourself" error.
 */

export interface RemoteAcpInstallRequest {
  title: string
  body: string
}

type RemoteAcpInstallApprover = (
  req: RemoteAcpInstallRequest,
  signal?: AbortSignal,
) => Promise<boolean>

let approver: RemoteAcpInstallApprover | null = null

/** Main-process wiring: route remote-install prompts through `requestApproval`. */
export function setRemoteAcpInstallApprover(fn: RemoteAcpInstallApprover | null): void {
  approver = fn
}

/** Ask the user. False (deny) whenever no approver is wired up. */
export async function approveRemoteAcpInstall(
  req: RemoteAcpInstallRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!approver) return false
  return await approver(req, signal)
}
