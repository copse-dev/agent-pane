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
      '- Any other GitHub read (`gh api`, `gh api graphql`): its gh_api_read tool. Fetching a branch or PR head from origin (`git fetch origin <branch>`): its git_fetch tool. Neither needs approval.',
    )
  }

  lines.push(
    '- Commands that need the network or files outside the workspace: its run_shell and run_background, which can ask the user to run approved work outside this sandbox.',
    "Retrying the same destination from the agent's own shell will fail the same way — approval cannot unsandbox it.",
    '',
    'If no bridged tool covers the need — an agent signing itself in, say — add the ' +
      "domain to this agent's sandbox.allowedDomains override under Settings → General → " +
      'Coding agents. That grants the agent process egress to it for the whole session.',
  )

  return lines.join('\n')
}

/** Bridged tools that reach GitHub from the host, besides every `gh_*` tool. */
const GITHUB_BRIDGE_TOOLS: ReadonlySet<string> = new Set([
  'git_fetch',
  'get_ci_status',
  'get_ci_failure_logs',
  'wait_for_ci_checks',
])

function isGithubBridgeTool(name: string): boolean {
  return name.startsWith('gh_') || GITHUB_BRIDGE_TOOLS.has(name)
}

/**
 * What a sandboxed agent's own `gh` prints. Since #4109 the agent's sandbox
 * keeps `~/.config/gh` unreadable, and it must stay that way because the
 * directory holds the user's token. `gh` reads that config before anything else,
 * so every subcommand fails here, before authentication or the network. The
 * error reads like a broken login, and an agent that takes it for one loops on
 * `gh auth login` or asks the user to open the directory. Quoting it lets the
 * agent recognise the failure when it happens. The copy matches the
 * `gh-config-read` signature in `sandbox-denial-signatures.ts`, and a test
 * holds the two together.
 */
export const ACP_SANDBOX_GH_CONFIG_ERROR =
  'failed to read configuration: open ~/.config/gh/config.yml: operation not permitted'

const GH_OWN_SHELL_DENIAL =
  `If \`gh\` fails in your own shell with "${ACP_SANDBOX_GH_CONFIG_ERROR}", this ` +
  "sandbox is keeping gh's config, which holds the user's GitHub token, unreadable. " +
  'It is not a missing login. Do not retry it, do not run `gh auth login`, and do not ask ' +
  "for access to ~/.config/gh. Adding GitHub to this agent's sandbox.allowedDomains " +
  'does not fix it either.'

const GITHUB_NO_DIRECT_EGRESS =
  'Do not call github.com or api.github.com from this process, for example with curl, ' +
  "unless the user has added it to this agent's sandbox.allowedDomains."

/**
 * Appended to `ACP_SANDBOX_PROMPT_NOTE` (issue #4145). That note steers
 * filesystem work to the bridge but says only that network destinations are
 * blocked. GitHub is the destination agents reach for unprompted, and `gh` in
 * the agent's own shell cannot work at all, so the note names the bridged route
 * up front. Waiting for the turn to end on a failed `gh` call is too late: Copse
 * only sees the agent's own shell output after the fact and cannot add to it.
 *
 * The route depends on what the "copse" MCP server actually offered this
 * session (`bridgeToolNames`). Pointing at tools that are not mounted (#4142)
 * leaves the agent no way forward, so the copy names the offered GitHub tools,
 * falls back to `run_shell` (which can ask to run `gh` outside the sandbox),
 * and with no bridge at all says plainly that GitHub is out of reach.
 * `undefined` means the caller does not know what was offered, which gives the
 * generic wording.
 */
export function acpSandboxGithubSteer(bridgeToolNames?: readonly string[]): string {
  const route = githubRoute(bridgeToolNames)
  return `${route} ${GH_OWN_SHELL_DENIAL} ${GITHUB_NO_DIRECT_EGRESS}`
}

function githubRoute(bridgeToolNames: readonly string[] | undefined): string {
  if (bridgeToolNames === undefined) {
    return (
      'For GitHub work (pull requests, issues, Actions, `gh`), use the "copse" MCP ' +
      "server's GitHub and CI tools when available: they run on Copse's host gh/API " +
      "path and need no github.com entry in this agent's sandbox.allowedDomains. " +
      'Use gh_api_read for other GitHub reads (instead of `gh api`/`gh api graphql`) ' +
      'and git_fetch to fetch branches or PR heads from origin.'
    )
  }
  const githubTools = bridgeToolNames.filter(isGithubBridgeTool)
  const hasRunShell = bridgeToolNames.includes('run_shell')
  const shellFallback = hasRunShell
    ? 'run `gh` through its run_shell tool, which can ask the user to run it outside this sandbox.'
    : null
  if (githubTools.length > 0) {
    const sentences = [
      'For GitHub work (pull requests, issues, Actions, CI), use the "copse" MCP ' +
        "server's GitHub tools: they run on Copse's host gh login and need no github.com " +
        `entry in this agent's sandbox.allowedDomains. Offered here: ${githubTools.join(', ')}.`,
    ]
    if (githubTools.includes('gh_api_read')) {
      sentences.push(
        'Use gh_api_read for any other GitHub read (instead of `gh api`/`gh api graphql`).',
      )
    }
    if (githubTools.includes('git_fetch')) {
      sentences.push('Use git_fetch to fetch branches or PR heads from origin.')
    }
    if (shellFallback) sentences.push(`For anything they do not cover, ${shellFallback}`)
    return sentences.join(' ')
  }
  if (shellFallback) {
    return (
      'For GitHub work (pull requests, issues, Actions, `gh`): the "copse" MCP server ' +
      `offers no GitHub tools in this session, so ${shellFallback}`
    )
  }
  const unavailable =
    bridgeToolNames.length === 0
      ? 'the "copse" MCP server is not available in this session'
      : 'the "copse" MCP server offers no GitHub or shell tools in this session'
  return (
    `For GitHub work (pull requests, issues, Actions, \`gh\`): ${unavailable}, so ` +
    'nothing here can reach GitHub. Tell the user that GitHub could not be reached from ' +
    'this sandboxed session instead of retrying.'
  )
}
