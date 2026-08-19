/**
 * Scoring of an eval scenario's tool expectations, shared by the in-run
 * agent-eval drive spec (`scenario.toolUse`) and the post-hoc thread analyzer
 * (`scenario.expect`) so the two cannot disagree about whether a run met them.
 */
import { matchesBridgedToolName } from '../../src/main/services/acp/acp-bridge-name.ts'
import {
  SANDBOX_NETWORK_AUDIT_BLOCKED_ARG,
  SANDBOX_NETWORK_AUDIT_TOOL,
  isGithubDenialHost,
} from '../../src/main/services/acp/acp-network-denial-steer.ts'

export interface ToolExpectations {
  requireTools?: readonly string[] | undefined
  requireAnyTools?: readonly string[] | undefined
  forbidTools?: readonly string[] | undefined
  /**
   * Fail when a `sandbox_network_audit` card names a GitHub host — the agent's
   * own process tried to reach GitHub instead of using a bridged tool.
   *
   * Distinct from `forbidTools: ['sandbox_network_audit']`, which fails on *any*
   * blocked destination and so cannot be used with an agent that phones home:
   * Claude's adapter is denied its Datadog telemetry on most turns and Cursor's
   * is denied the npm registry, neither of which says anything about GitHub.
   */
  forbidGithubNetworkDenial?: boolean | undefined
}

/** One observed call: the name a scenario matches, and the args it may inspect. */
export interface ObservedToolCall {
  name: string
  args?: Record<string, unknown> | undefined
}

/**
 * Whether an observed tool-call name is the tool a scenario named.
 *
 * An ACP agent namespaces its bridged calls — Codex emits
 * `mcp.copse.gh_pr_view` where the native loop records `gh_pr_view` — so exact
 * comparison silently never fires under ACP. That is a false *pass* for
 * `forbidTools` and a false failure for `requireTools`, which is how a
 * `forbidTools: ['run_shell']` scenario could look green under an ACP model
 * while the agent ran a shell on every turn. `matchesBridgedToolName` is the
 * same anchored matcher the permission gate uses, so the harness and the gate
 * agree on what counts as a bridged call.
 *
 * An agent's *own* tools are out of scope here: Codex titles its private shell
 * calls with the command itself (`git status --short`), which no stable name can
 * match. Signals that Copse emits — `sandbox_network_audit`, for one — are the
 * way to observe those.
 */
function toolCallIsNamed(observedName: string, expectedName: string): boolean {
  return observedName === expectedName || matchesBridgedToolName(observedName, expectedName)
}

export function usedTool(observedNames: readonly string[], expectedName: string): boolean {
  return observedNames.some((name) => toolCallIsNamed(name, expectedName))
}

/**
 * Human-readable reasons a run failed its tool expectations; empty means it
 * passed.
 *
 * `requireTools` is a conjunction, so it cannot express "reached GitHub somehow"
 * when several tools would do. Without `requireAnyTools`, a scenario that only
 * forbids the wrong path also passes when the agent never attempted the task at
 * all — the forbidden tool is absent either way.
 */
export function toolExpectationViolations(
  observed: readonly ObservedToolCall[],
  expectations: ToolExpectations,
): string[] {
  const observedNames = observed.map((call) => call.name)
  const violations: string[] = []
  for (const name of expectations.requireTools ?? []) {
    if (!usedTool(observedNames, name)) violations.push(`missing required tool: ${name}`)
  }
  const anyOf = expectations.requireAnyTools ?? []
  if (anyOf.length > 0 && !anyOf.some((name) => usedTool(observedNames, name))) {
    violations.push(`expected at least one of these tools: ${anyOf.join(', ')}`)
  }
  for (const name of expectations.forbidTools ?? []) {
    if (usedTool(observedNames, name)) violations.push(`forbidden tool used: ${name}`)
  }
  if (expectations.forbidGithubNetworkDenial === true) {
    const github = deniedGithubHosts(observed)
    if (github.length > 0) {
      violations.push(`the agent's own process was denied GitHub: ${github.join(', ')}`)
    }
  }
  return violations
}

/**
 * GitHub hosts named by any `sandbox_network_audit` card in the run.
 *
 * The card records its hosts as `host:port` labels, which
 * {@link isGithubDenialHost} accepts, so the harness and the card agree on what
 * counts as GitHub. A card carrying only non-GitHub hosts yields nothing.
 */
function deniedGithubHosts(observed: readonly ObservedToolCall[]): string[] {
  const hosts = observed
    .filter((call) => usedTool([call.name], SANDBOX_NETWORK_AUDIT_TOOL))
    .flatMap((call) => blockedLabels(call.args))
    .filter((label) => isGithubDenialHost(label))
  return [...new Set(hosts)]
}

function blockedLabels(args: Record<string, unknown> | undefined): string[] {
  const blocked = args?.[SANDBOX_NETWORK_AUDIT_BLOCKED_ARG]
  if (!Array.isArray(blocked)) return []
  return blocked.filter((label): label is string => typeof label === 'string')
}
