import type { SshConnectionState, SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import type { PairedMachine } from '@shared/machines.ts'
import { el } from '../../dom/helpers.ts'

/**
 * What one machine in Settings → Machines can do, and how it is connected.
 *
 * Settings shows each machine once (docs/plans/multi-machine-access.md
 * decision 2). The rows are joined from the stores that already exist (saved
 * SSH hosts, paired Copse machines, the hosts trusted for auto-approval) and
 * these helpers only describe them; nothing here is stored.
 */
export interface MachineSummary {
  /** One line on the connection, e.g. "Connected" or "Connection lost". */
  status: string
  /** `ok` while connected, `warn` while it was lost or failed, `idle` otherwise. */
  tone: 'ok' | 'warn' | 'idle'
  /** What the machine can be used for here, in display order. */
  capabilities: string[]
}

export interface SshMachineContext {
  /** Live connection states from `sshWorkspace.getStates()`. */
  states: readonly SshConnectionState[]
  /** `acpOverSshEnabled`: vendor agents run next to the code. */
  agentsOnRemote: boolean
  /** `vncEnabled`: the Desktop pane can show this machine's screen. */
  desktop: boolean
  /** `trustedSshHosts`: host names Guarded YOLO treats as trusted destinations. */
  trustedHosts: readonly string[]
}

export function describeSshMachine(
  host: SshWorkspaceHost,
  context: SshMachineContext,
): MachineSummary {
  const state = context.states.find((entry) => entry.hostId === host.id)
  const capabilities = ['Files and shell']
  if (context.agentsOnRemote) capabilities.push('Agents')
  if (context.desktop) capabilities.push('Desktop')
  const target = host.host.toLowerCase()
  if (context.trustedHosts.some((trusted) => trusted.toLowerCase() === target)) {
    capabilities.push('Trusted for auto-approval')
  }
  switch (state?.status) {
    case 'connected':
      return { status: 'Connected', tone: 'ok', capabilities }
    case 'connecting':
      return { status: 'Connecting…', tone: 'idle', capabilities }
    case 'disconnected':
      // A state that exists but is not connected was connected and then lost.
      return { status: 'Connection lost', tone: 'warn', capabilities }
    case 'error':
      return {
        status: state.lastError ? `Could not connect: ${state.lastError}` : 'Could not connect',
        tone: 'warn',
        capabilities,
      }
    default:
      return { status: 'Not connected', tone: 'idle', capabilities }
  }
}

export function describePairedMachine(machine: PairedMachine): MachineSummary {
  const count = machine.models.length
  const capabilities = [count === 1 ? '1 shared model' : `${String(count)} shared models`]
  if (machine.viaSsh) capabilities.push(`Over SSH through ${machine.viaSsh.label}`)
  switch (machine.status) {
    case 'connected':
      return { status: 'Connected', tone: 'ok', capabilities }
    case 'reconnecting':
      return { status: 'Reconnecting', tone: 'warn', capabilities }
    default:
      return { status: 'Unavailable', tone: 'warn', capabilities }
  }
}

/** The status line and capability chips shared by every row in the Machines list. */
export function machineSummaryElement(summary: MachineSummary): HTMLElement {
  return el(
    'div',
    { class: 'machine-summary' },
    el('span', { class: `machine-summary-status machine-summary-${summary.tone}` }, summary.status),
    el(
      'ul',
      { class: 'machine-uses', 'aria-label': 'Can be used for' },
      ...summary.capabilities.map((label) => el('li', { class: 'machine-use' }, label)),
    ),
  )
}
