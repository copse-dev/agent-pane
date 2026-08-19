/**
 * Copy for a sandboxed ACP agent that hits the network allowlist, in both
 * directions: the prompt note that tells the agent where to go instead, and the
 * post-turn `sandbox_network_audit` body that reports what was blocked.
 *
 * Both lead with Copse's bridged tools rather than with the allowlist. The
 * agent's own process cannot be unsandboxed by approval, and widening
 * `sandbox.allowedDomains` grants that process egress for the whole session, so
 * it belongs last — reserved for hosts no bridged tool can stand in for, such as
 * the agent's own OAuth refresh endpoint.
 */

import type { NetworkDenial } from '../../project-sandbox/network-scope.ts'

/** A recorded denial, minus the ring-buffer sequence this copy has no use for. */
export type DeniedDestination = Pick<NetworkDenial, 'host' | 'port'>

/**
 * Name of the post-turn card reporting a turn's blocked destinations, and the
 * argument carrying its `host:port` labels. Shared because the card is read back
 * as well as written: the eval harness scores a scenario against a recorded
 * thread, so it has to find this call and its hosts by the same names.
 */
export const SANDBOX_NETWORK_AUDIT_TOOL = 'sandbox_network_audit'
export const SANDBOX_NETWORK_AUDIT_BLOCKED_ARG = 'blocked'

/**
 * `host:port` labels for one turn's denials, deduplicated in first-seen order.
 * The audit's structured `blocked` argument and its human-readable body share
 * this so a card cannot list one set of hosts and explain another.
 */
export function denialHostLabels(denied: readonly DeniedDestination[]): string[] {
  return [
    ...new Set(
      denied.map((denial) =>
        denial.port !== undefined ? `${denial.host}:${String(denial.port)}` : denial.host,
      ),
    ),
  ]
}

const GITHUB_DENIAL_HOSTS = new Set(['github.com', 'api.github.com', 'githubusercontent.com'])

/**
 * True for GitHub destinations, where the bridged `gh_*` and CI tools are a real
 * substitute for widening this agent's egress and so earn a named callout.
 *
 * Accepts either a bare host or one of the `host:port` labels
 * {@link denialHostLabels} writes into the audit card, so a caller holding only
 * a recorded card — the eval harness scores against `args.blocked` — can ask the
 * same question the card itself asked. Everything else an agent's process
 * reaches, telemetry and package registries included, is deliberately not
 * GitHub: those denials get the generic bridged-tools guidance.
 */
export function isGithubDenialHost(hostOrLabel: string): boolean {
  const hostname = hostOrLabel.trim().toLowerCase().replace(/:\d+$/, '')
  return (
    GITHUB_DENIAL_HOSTS.has(hostname) ||
    hostname.endsWith('.github.com') ||
    hostname.endsWith('.githubusercontent.com')
  )
}

/** Build the `sandbox_network_audit` tool_result body. */
export function formatSandboxNetworkDenialAudit(denied: readonly DeniedDestination[]): string {
  if (denied.length === 0) return ''

  const lines = [
    'The sandbox blocked these network destinations during this turn:',
    ...denialHostLabels(denied).map((label) => `- ${label}`),
    '',
    "Copse's bridged tools reach the network from the host, so prefer them over " +
      "opening this agent's own egress:",
  ]

  // Only name GitHub when GitHub was actually blocked. Most of what an agent's
  // own process reaches is its telemetry or a package registry, and leading
  // those denials with pull-request tooling reads as a non sequitur.
  if (denied.some((denial) => isGithubDenialHost(denial.host))) {
    lines.push(
      '- GitHub pull requests, Actions and CI: the "copse" MCP server\'s gh_pr_*, gh_run_* and CI tools use Copse\'s gh auth, so prefer them to running `gh` or curl against github.com in here.',
    )
  }

  lines.push(
    '- Commands that need the network or files outside the workspace: its run_shell and run_background, which can ask the user to run approved work outside this sandbox.',
    "Retrying the same destination from the agent's own shell will fail the same way — approval cannot unsandbox it.",
    '',
    'If no bridged tool covers the need — an agent signing itself in, say — add the ' +
      "domain to this agent's sandbox.allowedDomains override under Settings → ACP " +
      'agents. That grants the agent process egress to it for the whole session.',
  )

  return lines.join('\n')
}

/**
 * Appended to {@link ACP_SANDBOX_PROMPT_NOTE}. That note steers filesystem work
 * to the bridge but says only that network destinations are blocked, and GitHub
 * is the one an agent reaches for unprompted — cheaper to name the bridged path
 * up front than to let a turn end on a blocked `gh` call and an audit card.
 */
export const ACP_SANDBOX_GITHUB_STEER =
  'For GitHub work (pull requests, issues, Actions, `gh`), use the "copse" MCP ' +
  "server's GitHub and CI tools when available: they run on Copse's host gh/API " +
  "path and need no github.com entry in this agent's sandbox.allowedDomains. Do " +
  'not call github.com or api.github.com from this process unless the user has ' +
  'widened that allowlist.'
