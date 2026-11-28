/**
 * Approval seam for uploading and starting the Copse worker on an SSH host
 * (`docs/plans/harness-worker-roadmap.md`, R3). The same dependency-free hook
 * as `remote-watcher-install-approval.ts`: the main process injects the real
 * prompt at startup (index.ts).
 *
 * Fails closed: with no approver registered, nothing is uploaded or started.
 */

export interface SshWorkerInstallRequest {
  title: string
  body: string
}

type SshWorkerInstallApprover = (req: SshWorkerInstallRequest) => Promise<boolean>

let approver: SshWorkerInstallApprover | null = null

export function setSshWorkerInstallApprover(fn: SshWorkerInstallApprover | null): void {
  approver = fn
}

/** Ask the user. False (deny) whenever no approver is wired up. */
export async function approveSshWorkerInstall(req: SshWorkerInstallRequest): Promise<boolean> {
  if (!approver) return false
  return await approver(req)
}

export function formatSshWorkerInstallApproval(hostLabel: string): SshWorkerInstallRequest {
  return {
    title: `Run Copse's worker on ${hostLabel}?`,
    body:
      `Copse uploads its worker to ~/.copse/worker on ${hostLabel} and starts it there with the ` +
      `host's Node, so this project's turns run on the host. Your model keys stay on this ` +
      `computer, so a turn waits while it sleeps. The worker stops by itself after ten minutes ` +
      `with nothing to do. Declining keeps every turn on this computer.`,
  }
}
