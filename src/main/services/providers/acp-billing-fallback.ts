import { acpModelValue, enabledClaudeAcpAgent } from '@shared/acp.ts'
import { REMOTE_AGENT_PROVIDER_ANTHROPIC, type RemoteAgentProvider } from '@shared/remote-agent.ts'
import { listEnabledAcpAgents } from '../acp/acp-agent-registry.ts'
import { requestUserAnswers } from '../ask-user.ts'
import { discoverPlanUsageCredentials } from '../plan-usage-bridge.ts'
import { getSetting } from '../storage/settings.ts'

/**
 * Why the Claude Cloud Agent could not run this turn. `no-key` is caught before
 * the turn starts (the stored key is missing or failed validation); `auth` and
 * `credit` come from the managed Agents API rejecting a request mid-turn.
 */
export type CloudAgentBlockReason = 'no-key' | 'auth' | 'credit'

/** An accepted offer: the ACP model value to re-run the turn on. */
export interface AcpFallbackChoice {
  agentId: string
  /** Full `acp:<id>[#model]` value, ready for `parseAcpModelSelection`. */
  modelValue: string
  agentTitle: string
}

const REASON_TEXT: Readonly<Record<CloudAgentBlockReason, string>> = {
  'no-key': 'no valid Anthropic API key is configured',
  auth: 'Anthropic rejected the API key',
  credit: 'the Anthropic API account is out of credit',
}

/**
 * Answers that mean "yes, switch". The user can type anything, so anything we
 * do not recognise counts as a decline: silently moving a turn onto a different
 * billing path is the outcome worth being conservative about, and a blank
 * answer (window closed, ask timed out, headless host) lands here too.
 */
const ACCEPT = /^\s*(?:y|yes|ok|okay|sure|switch\b.*|use\b.*acp.*|acp)\s*$/i

/**
 * Whether the local `claude` CLI looks logged in. ACP agents run as separate
 * processes with their own credentials — Copse's provider keys are deliberately
 * stripped from their environment — so an offer to switch is only honest if we
 * say whether that login exists. A configured `ANTHROPIC_API_KEY` in the agent's
 * own env counts too: that is the documented alternative to `claude setup-token`.
 */
async function hasClaudeAcpAuth(agentEnv: Record<string, string> | undefined): Promise<boolean> {
  if (agentEnv?.['ANTHROPIC_API_KEY']?.trim()) return true
  try {
    return ((await discoverPlanUsageCredentials()).claudeCredentials?.length ?? 0) > 0
  } catch {
    // Credential discovery shells out to the macOS Keychain; a failure there
    // tells us nothing about whether the agent can authenticate, so don't let
    // it claim the login is missing.
    return true
  }
}

/**
 * Offer to re-run a blocked Claude Cloud Agent turn on the user's ACP Claude
 * agent, which authenticates against their own `claude` login and bills against
 * the subscription rather than API credit.
 *
 * Returns `null` — meaning "carry on without switching" — when the offer does
 * not apply: a non-Anthropic remote agent, the setting turned off, no enabled
 * Claude ACP agent to switch to, or the user declining. The two paths are not
 * interchangeable (the Cloud Agent runs in a remote sandbox and opens a PR; ACP
 * runs locally against the working tree), so this always asks and never assumes.
 */
export async function offerAcpClaudeFallback(input: {
  provider: RemoteAgentProvider
  reason: CloudAgentBlockReason
  /** Upstream model the picker pinned, carried over to the ACP session. */
  model?: string
}): Promise<AcpFallbackChoice | null> {
  if (input.provider !== REMOTE_AGENT_PROVIDER_ANTHROPIC) return null
  if (!getSetting<boolean>('preferAcpOverCloudAgent', true)) return null

  const agent = enabledClaudeAcpAgent(listEnabledAcpAgents())
  if (!agent) return null

  const authHint = (await hasClaudeAcpAuth(agent.env))
    ? ''
    : ` No local \`claude\` login was found, so ${agent.title} may ask you to sign in with \`claude setup-token\` first.`

  const switchOption = `Switch to ${agent.title}`
  const { answers } = await requestUserAnswers({
    questions: [
      {
        question:
          `Claude Cloud Agent could not run this turn — ${REASON_TEXT[input.reason]}. ` +
          `Re-run it on ${agent.title} instead? That runs locally against this worktree ` +
          `and bills against your Claude subscription rather than API credit, so it will ` +
          `not produce a pull request the way the Cloud Agent does.${authHint}`,
        options: [switchOption, 'Stay on Claude Cloud Agent'],
      },
    ],
  })

  const answer = answers[0] ?? ''
  const accepted = answer.trim() === switchOption || ACCEPT.test(answer)
  if (!accepted) return null

  // Only carry the model over when the agent actually advertises it. The Cloud
  // Agent picker pins upstream Anthropic ids (`claude-opus-5`), while an ACP
  // model is a `SessionConfigValueId` from that agent's own option list — the
  // two vocabularies overlap only by coincidence, and sending an unrecognised
  // id would have the agent reject the config option instead of just defaulting.
  const offered = agent.availableModels?.some((m) => m.value === input.model) ?? false
  return {
    agentId: agent.id,
    modelValue: offered ? acpModelValue(agent.id, input.model) : acpModelValue(agent.id),
    agentTitle: agent.title,
  }
}
