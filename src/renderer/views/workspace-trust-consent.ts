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
 * Ask before trusting a project, naming it. Resolves true only on an explicit
 * yes; the caller performs the trust itself so each surface keeps its own status
 * copy. The caller supplies the hooks read from the same root it will trust, so
 * the consent never describes a different project than the one trusted.
 */
export function confirmProjectTrust(request: {
  projectName: string
  unsandboxedHooks: readonly { event: string; command: string }[]
  lead: string
  cancelLabel?: string
  /** Enter declines: for an offer the user did not ask for. */
  focusCancel?: boolean
}): Promise<boolean> {
  return showConfirmDialog({
    message: `Trust “${request.projectName}”?`,
    detail: `${request.lead} ${workspaceTrustDetail(request.unsandboxedHooks)}`,
    confirmLabel: 'Trust project',
    ...(request.cancelLabel ? { cancelLabel: request.cancelLabel } : {}),
    ...(request.focusCancel ? { focusCancel: true } : {}),
  })
}
