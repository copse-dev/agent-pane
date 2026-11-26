import type { ApiClient } from '../../preload/api.d.ts'
import { showConfirmDialog } from './confirm-dialog.ts'

/**
 * What trusting a project turns on, stated once for every place that offers it
 * (Sources, adding a project, a shell prompt). Trust is the gate for repo-shipped
 * instructions, MCP servers, hooks and environment setup, and for the shell
 * auto-approval tiers and trusted-command routing — so the consent names both.
 * `sandbox: false` hooks are listed because trusting is what lets those
 * repo-supplied scripts run outside the project sandbox (hooks plan, decision 7).
 */
export function workspaceTrustDetail(
  unsandboxedHooks: readonly { event: string; command: string }[],
): string {
  return [
    'Its instruction files join the system prompt, and the MCP servers and hooks it defines are allowed to run.',
    'Sandboxed commands that match your Settings → Permissions auto-approval level run without asking.',
    unsandboxedHooks.length > 0
      ? `${String(unsandboxedHooks.length)} of those hooks declare "sandbox": false and run OUTSIDE the project sandbox: ${unsandboxedHooks
          .map((h) => `${h.event}: ${h.command}`)
          .join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Ask before trusting the open project. Resolves true only on an explicit yes;
 * the caller performs the trust itself so each surface keeps its own status copy.
 */
export async function confirmProjectTrust(
  api: ApiClient,
  copy: { message: string; confirmLabel: string; cancelLabel?: string; lead?: string },
): Promise<boolean> {
  const unsandboxed = await api.workspace.unsandboxedProjectHooks().catch(() => [])
  const detail = [copy.lead ?? '', workspaceTrustDetail(unsandboxed)].filter(Boolean).join(' ')
  return showConfirmDialog({
    message: copy.message,
    detail,
    confirmLabel: copy.confirmLabel,
    ...(copy.cancelLabel ? { cancelLabel: copy.cancelLabel } : {}),
  })
}
