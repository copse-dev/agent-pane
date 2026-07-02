import {
  runSubagent,
  CI_INVESTIGATOR_TOOL_NAMES,
  CI_INVESTIGATOR_SYSTEM_PROMPT,
} from '@shared/agent/run-subagent.ts'
import { conversationTokenBudget } from '@shared/agent/trim-history.ts'
import { readFileLimitsForSubagent } from '@shared/agent/read-file-limits.ts'
import type {
  LLMProvider,
  LLMMessage,
  LLMTool,
  ModelUsage,
  StreamChunk,
  ToolExecuteResult,
} from '@shared/types'
import type { ToolRegistry } from './tool-registry.ts'
import { runWithAgentRunReadFileLimits } from './agent-run-read-limits.ts'
import { getWorkspaceRoot } from './workspace.ts'

// Experimental, opt-in feature flag for the CI investigator subagent (off by
// default). Read in registry-bootstrap (tool registration) and follow-up-service
// (the "Investigate CI failure" suggestion) so both surfaces stay gated together.
export const CI_INVESTIGATOR_ENABLED_SETTING = 'ciInvestigatorEnabled'

export interface RunCiInvestigatorSubagentOptions {
  parentToolCallId: string
  focus?: string
  prNumber?: number
  parentGoal: string
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
  usageModel: string
  /** Local subagent routing was requested but unavailable; run uses the cloud model. */
  localFallback?: boolean
}

export interface CiInvestigatorSubagentResult {
  summary: string
  usage: ModelUsage
}

function filterCiTools(registry: ToolRegistry): LLMTool[] {
  const names = new Set<string>(CI_INVESTIGATOR_TOOL_NAMES)
  return registry.toLLMTools().filter((t) => names.has(t.name))
}

async function executeCiTool(
  registry: ToolRegistry,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolExecuteResult> {
  if (!CI_INVESTIGATOR_TOOL_NAMES.includes(name as (typeof CI_INVESTIGATOR_TOOL_NAMES)[number])) {
    throw new Error(`Tool not allowed in CI investigator subagent: ${name}`)
  }
  return registry.execute(name, args, signal)
}

function buildCiTask(focus: string | undefined, prNumber: number | undefined): string {
  const parts = [
    prNumber !== undefined
      ? `Investigate the failing CI checks for pull request #${String(prNumber)}.`
      : 'Investigate the failing CI checks for the pull request on the current branch.',
  ]
  if (focus?.trim()) parts.push('', `Focus: ${focus.trim()}`)
  parts.push(
    '',
    'Read the failing run logs in depth and return a structured findings report: which check(s) failed, the root-cause error, the file(s)/line(s) involved, and a concrete suggested fix.',
  )
  return parts.join('\n')
}

export async function runCiInvestigatorSubagent(
  opts: RunCiInvestigatorSubagentOptions,
): Promise<CiInvestigatorSubagentResult> {
  const {
    parentToolCallId,
    focus,
    prNumber,
    parentGoal,
    provider,
    registry,
    contextWindow,
    toolSchemaReserve,
    signal,
    onChunk,
    usageModel,
    localFallback,
  } = opts

  const workspace = getWorkspaceRoot() ?? '(none)'
  const userTask = buildCiTask(focus, prNumber)
  const prompt =
    prNumber !== undefined
      ? `Investigate CI failures for PR #${String(prNumber)}`
      : 'Investigate CI failures for the current branch'

  const subagentMessages: LLMMessage[] = [
    { role: 'system', content: CI_INVESTIGATOR_SYSTEM_PROMPT },
    { role: 'user', content: userTask },
  ]
  const subagentBudget = conversationTokenBudget(subagentMessages, contextWindow, {
    reserveTokens: toolSchemaReserve,
  })
  const subagentReadLimits = readFileLimitsForSubagent(subagentBudget)

  return runWithAgentRunReadFileLimits(subagentReadLimits, async () => {
    const { summary, session } = await runSubagent({
      provider,
      prompt,
      parentGoal: `${parentGoal}\nWorkspace: ${workspace}`,
      tools: filterCiTools(registry),
      parentToolCallId,
      signal,
      maxContextTokens: contextWindow,
      toolSchemaReserveTokens: toolSchemaReserve,
      executeTool: (name, args, sig) => executeCiTool(registry, name, args, sig),
      onSubagentChunk: onChunk,
      systemPrompt: CI_INVESTIGATOR_SYSTEM_PROMPT,
      kind: 'investigate_ci',
      userTask,
      usageModel,
      ...(localFallback !== undefined ? { localFallback } : {}),
    })

    const usage = session.usage ?? { inputTokens: 0, outputTokens: 0 }
    return { summary, usage }
  })
}
