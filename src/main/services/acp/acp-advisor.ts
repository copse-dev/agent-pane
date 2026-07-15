import type { ModelUsage } from '@shared/types'
import {
  openAcpSession,
  runAcpSessionPrompt,
  type AcpAgentSpawnConfig,
  type AcpTransportFactory,
  type MutableAcpHandlers,
} from './acp-client.ts'
import { getAcpAgent, resolveAcpSandbox } from './acp-agent-registry.ts'
import { acpTurnUsage, permissionResponseFor } from './acp-agent-service.ts'
import { getActiveProjectRoot, getWorkspaceRoot } from '../workspace.ts'

/**
 * Advisor consultations routed through an external ACP agent (`acp:<id>` picked
 * as the advisor model). The advisor contract is a *bare* one-shot inference —
 * the transcript goes in, advice text comes out — so unlike a chat turn
 * (`runAcpAgentFromSettings`) this deliberately mounts nothing: no MCP servers,
 * no native-tool bridge, no fs handlers, and every permission request the agent
 * makes is auto-rejected. An external agent still owns its own model loop, so
 * "bare" here means Copse offers it no capabilities — a compliant agent answers
 * from the prompt alone.
 *
 * Sessions are one-shot, not pooled: the advisor is a different role from the
 * thread's executor, so it must not touch (or be confused with) the thread's
 * persistent ACP session.
 */

export interface AcpAdvisorResult {
  text: string
  usage: ModelUsage
}

/**
 * Run one bare advisor prompt on a throwaway ACP session. Split from
 * {@link runAcpAdvisorPrompt} so tests can inject an in-process transport
 * instead of spawning a real agent binary.
 */
export async function runAcpAdvisorSession(
  config: AcpAgentSpawnConfig,
  model: string | undefined,
  prompt: string,
  signal: AbortSignal,
  createTransport?: AcpTransportFactory,
): Promise<AcpAdvisorResult> {
  let text = ''
  const handlers: MutableAcpHandlers = {
    current: {
      // The advice is the final text; nothing streams to the UI mid-consult.
      onChunk: (chunk) => {
        if (chunk.type === 'text') text += chunk.text
      },
      // Bare advisor: reject every tool the agent asks to run.
      requestPermission: (req) => Promise.resolve(permissionResponseFor(req.options, false)),
      // No readTextFile / writeTextFile: fs capability requests fail as unsupported.
    },
  }
  const open = createTransport
    ? await openAcpSession(config, handlers, createTransport)
    : await openAcpSession(config, handlers)
  try {
    const stop = await runAcpSessionPrompt(open, prompt, model, signal)
    if (stop.stopReason === 'cancelled') {
      throw new Error('Advisor consultation was cancelled.')
    }
    const turn = acpTurnUsage(stop.usage, prompt, text)
    return { text, usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens } }
  } finally {
    open.dispose()
  }
}

/**
 * Resolve an `acp:<agentId>` advisor selection against settings and run the
 * bare consultation (see module doc). Throws when the agent is unknown/disabled
 * or no workspace is open — surfaced to the executor as the tool error.
 */
export async function runAcpAdvisorPrompt(options: {
  agentId: string
  model?: string | undefined
  prompt: string
  signal: AbortSignal
}): Promise<AcpAdvisorResult> {
  const agent = getAcpAgent(options.agentId)
  if (!agent) {
    throw new Error(
      `ACP advisor agent "${options.agentId}" is not configured or is disabled. Add it in Settings → ACP agents.`,
    )
  }
  const cwd = getActiveProjectRoot() ?? getWorkspaceRoot()
  if (!cwd) {
    throw new Error('Open a folder before consulting an ACP advisor.')
  }
  const sandbox = resolveAcpSandbox(agent)
  const config: AcpAgentSpawnConfig = {
    command: agent.command,
    cwd,
    ...(agent.args ? { args: agent.args } : {}),
    ...(agent.env ? { env: agent.env } : {}),
    ...(sandbox ? { sandbox } : {}),
  }
  return runAcpAdvisorSession(config, options.model ?? agent.model, options.prompt, options.signal)
}
