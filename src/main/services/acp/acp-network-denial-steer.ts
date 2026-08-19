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
 */
function isGithubDenialHost(host: string): boolean {
  const hostname = host.trim().toLowerCase()
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
    '- GitHub pull requests, Actions and CI: the "copse" MCP server\'s gh_pr_*, gh_run_* and CI tools, which use Copse\'s gh auth.',
    '- Commands that need the network or files outside the workspace: its run_shell and run_background, which can ask the user to run approved work outside this sandbox.',
    "Retrying the same destination from the agent's own shell will fail the same way — approval cannot unsandbox it.",
  ]

  if (denied.some((denial) => isGithubDenialHost(denial.host))) {
    lines.push(
      '',
      'GitHub was among the blocked hosts. Use the bridged GitHub and CI tools rather than running `gh` or curl against github.com inside the sandbox.',
    )
  }

  lines.push(
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
