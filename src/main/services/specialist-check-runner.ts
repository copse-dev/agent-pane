import { runSubagent, EXPLORE_TOOL_NAMES } from '@copse/agent/run-subagent.ts'
import {
  GATHER_SPECIALIST_EVIDENCE_TOOL_NAME,
  RUN_SPECIALIST_CHECK_TOOL_NAME,
  buildSpecialistTask,
  parseSpecialistCheckResult,
  specialistCheckRequestSchema,
  type SpecialistCheckDefinition,
  type SpecialistCheckRequest,
  type SpecialistCheckResult,
} from '@copse/agent/specialist-checks.ts'
import type {
  LLMProvider,
  LLMTool,
  ModelUsage,
  StreamChunk,
  ToolExecuteResult,
} from '@shared/types'
import { z } from 'zod'
import type { ToolRegistry } from './tool-registry.ts'
import { subagentHookCallbacks } from './hooks/subagent.ts'

export const SPECIALIST_DIRECT_TOOL_NAMES = [
  ...EXPLORE_TOOL_NAMES,
  'git_diff',
  'git_status',
  'git_log',
  'staged_diffs',
  'read_staged_diff',
] as const

const gatherEvidenceArgsSchema = z.object({
  query: z.string().min(1).max(1_000),
  paths: z.array(z.string().min(1)).max(12).default([]),
})

export const specialistCheckTool: LLMTool = {
  name: RUN_SPECIALIST_CHECK_TOOL_NAME,
  description:
    'Run one independent, focused investigation of a coherent high-risk security, privacy, performance, or correctness question. The specialist returns evidence only; you remain responsible for the final review verdict. Zero or one call is normal. Do not include your predicted conclusion in the question.',
  parameters: z.toJSONSchema(specialistCheckRequestSchema, { target: 'openapi-3.0' }),
}

const gatherEvidenceTool: LLMTool = {
  name: GATHER_SPECIALIST_EVIDENCE_TOOL_NAME,
  description:
    'Ask a bounded, read-only exploration agent to locate relevant repository evidence. Returns a cited summary; verify decisive claims with direct reads.',
  parameters: z.toJSONSchema(gatherEvidenceArgsSchema, { target: 'openapi-3.0' }),
}

export interface RunSpecialistCheckOptions {
  definition: SpecialistCheckDefinition
  request: SpecialistCheckRequest
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  usageModel: string
  onUsage: (model: string, usage: ModelUsage) => void
  gatherEvidence: (query: string, paths: string[], signal: AbortSignal) => Promise<string>
}

export interface RunApprovedEvidenceExplorationOptions {
  usageModel: string
  billable: boolean
  ensureApproved: () => Promise<boolean>
  run: () => Promise<string>
}

/** Lazily gate a separately routed paid explorer before it can make an LLM call. */
export async function runApprovedEvidenceExploration(
  opts: RunApprovedEvidenceExplorationOptions,
): Promise<string> {
  if (opts.billable && !(await opts.ensureApproved())) {
    return `Evidence exploration skipped — spending on ${opts.usageModel} was not approved.`
  }
  return opts.run()
}

function specialistTools(registry: ToolRegistry): LLMTool[] {
  const allowed = new Set<string>(SPECIALIST_DIRECT_TOOL_NAMES)
  return [...registry.toLLMTools().filter((tool) => allowed.has(tool.name)), gatherEvidenceTool]
}

export async function runSpecialistCheck(
  opts: RunSpecialistCheckOptions,
): Promise<SpecialistCheckResult> {
  let explorerCalls = 0
  const executeTool = async (
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ToolExecuteResult> => {
    if (name === GATHER_SPECIALIST_EVIDENCE_TOOL_NAME) {
      if (explorerCalls >= opts.definition.maxExplorerCalls) {
        return `Evidence-exploration limit reached (${String(opts.definition.maxExplorerCalls)}). Use the evidence already gathered or return inconclusive.`
      }
      explorerCalls += 1
      const parsed = gatherEvidenceArgsSchema.parse(args)
      return opts.gatherEvidence(parsed.query, parsed.paths, signal)
    }
    if (!SPECIALIST_DIRECT_TOOL_NAMES.some((allowed) => allowed === name)) {
      throw new Error(`Tool not allowed in specialist check: ${name}`)
    }
    return opts.registry.execute(name, args, signal)
  }

  const task = buildSpecialistTask(opts.request)
  const { summary } = await runSubagent({
    provider: opts.provider,
    prompt: task,
    parentGoal: task,
    tools: specialistTools(opts.registry),
    executeTool,
    signal: opts.signal,
    maxSteps: opts.definition.maxSteps,
    maxContextTokens: Math.min(opts.contextWindow, opts.definition.maxContextTokens),
    toolSchemaReserveTokens: opts.toolSchemaReserve,
    onSubagentChunk: (chunk: StreamChunk) => {
      if (chunk.type === 'usage') {
        opts.onUsage(opts.usageModel, {
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
          ...(chunk.cacheReadTokens !== undefined
            ? { cacheReadTokens: chunk.cacheReadTokens }
            : {}),
          ...(chunk.cacheCreationTokens !== undefined
            ? { cacheCreationTokens: chunk.cacheCreationTokens }
            : {}),
        })
      }
    },
    parentToolCallId: 'review-specialist-check',
    systemPrompt: opts.definition.systemPrompt,
    userTask: task,
    usageModel: opts.usageModel,
    ...subagentHookCallbacks({ usageModel: opts.usageModel }),
  })
  return parseSpecialistCheckResult(summary)
}
