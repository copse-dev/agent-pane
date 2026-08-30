import { requestApproval } from '../approval.ts'
import { acpSshTarget } from './acp-ssh-transport.ts'
import type { AcpAgentSpawnConfig } from './acp-client.ts'

/**
 * Consent gate for forwarding an ACP agent's Copse-configured env (provider
 * keys) to a *remote* SSH host, so the agent can authenticate there without a
 * separate login on the box (docs/plans/acp-over-ssh.md, "Auth the agent to
 * its model provider").
 *
 * Main-process only — this module talks to the approval dialog. It must run
 * before a spawn config leaves the main process: the SSH transport forwards
 * whatever `config.env` it receives (as a stdin preamble, never argv), so
 * stripping-unless-approved here is what upholds the plan's "no local secrets
 * cross the wire without explicit opt-in" line. Worker-side callers never see
 * an unapproved env because it is deleted from the config before dispatch.
 *
 * The decision is remembered per agent + host + key-name set until the app
 * restarts (values are never part of the key, or the dialog). A denial is
 * remembered too — re-asking every turn would train users to click through —
 * and the auth-required turn error tells the user how to change their mind.
 */

const decisions = new Map<string, Promise<boolean>>()

/** Test hook. */
export function resetRemoteAcpEnvDecisionsForTests(): void {
  decisions.clear()
}

function decisionKey(agentId: string, hostId: string, envNames: string[]): string {
  return [agentId, hostId, ...[...envNames].sort()].join('\u0000')
}

/**
 * When `config.cwd` targets an SSH host and the config carries env, ask the
 * user (once per agent + host + name set) whether to forward it; on denial —
 * or with no dialog available — delete it from the config. Mutates and returns
 * the config so call sites read as a pipeline stage.
 */
export async function gateRemoteAcpEnvForward(
  agentId: string,
  config: AcpAgentSpawnConfig,
): Promise<AcpAgentSpawnConfig> {
  const envNames = Object.keys(config.env ?? {})
  if (envNames.length === 0) return config
  const target = acpSshTarget(config.cwd)
  if (!target) return config

  const key = decisionKey(agentId, target.hostId, envNames)
  let decision = decisions.get(key)
  if (!decision) {
    decision = requestApproval({
      title: `Forward ${agentId} environment to ${target.hostId}?`,
      body:
        `The ACP agent "${agentId}" runs on the SSH host ${target.hostId} and has ` +
        `environment configured in Settings → ACP agents: ${envNames.join(', ')}. ` +
        `Forward these values to the remote agent so it can authenticate there? ` +
        `They travel over the encrypted SSH channel into the agent's process ` +
        `environment only — never on a command line (\`ps\`) or the remote disk. ` +
        `Decline to run the agent with credentials already on the host instead.`,
      type: 'shell',
      cause: 'acp-remote-env',
      allowRemember: false,
    })
      .then(({ approved }) => approved)
      .catch(() => false)
    decisions.set(key, decision)
  }
  if (!(await decision)) delete config.env
  return config
}

/**
 * A JSON-RPC "Authentication required" from an agent running on an SSH host.
 * The default message is a dead end there — the fix is on the *remote* box —
 * so name the two working paths. Returns null when the failure is anything
 * else or the agent ran locally.
 */
export function remoteAcpAuthRequiredHint(
  err: unknown,
  cwd: string,
  agentId: string,
): Error | null {
  const errorMessage = err instanceof Error ? err.message : String(err)
  if (!/authentication required|authentication_failed/i.test(errorMessage)) return null
  const target = acpSshTarget(cwd)
  if (!target) return null
  return new Error(
    `The "${agentId}" agent on ${target.hostId} has no model-provider credentials. ` +
      `Either log the agent's CLI in once on that host (e.g. \`claude /login\` over SSH), ` +
      `or add its API key (e.g. ANTHROPIC_API_KEY) to the agent's environment in ` +
      `Settings → ACP agents — Copse will offer to forward it securely to the host. ` +
      `If you previously declined forwarding, restart Copse to be asked again.`,
    { cause: err },
  )
}
