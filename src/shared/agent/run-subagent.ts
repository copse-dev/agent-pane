import { runAgentLoop } from './run-agent-loop.ts'
import { defaultMaxLlmCallsForSteps } from './agent-loop-limits.ts'
import type {
  LLMProvider,
  LLMMessage,
  LLMTool,
  StreamChunk,
  SubagentSession,
  SubagentMessage,
  ToolExecuteResult,
} from '@shared/types'

const randomUUID = (): string => globalThis.crypto.randomUUID()

interface ProviderWithUsage {
  lastUsage: { inputTokens: number; outputTokens: number } | null
}

function hasLastUsage(p: unknown): p is ProviderWithUsage {
  return typeof p === 'object' && p !== null && 'lastUsage' in p
}

export const EXPLORE_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'semantic_search',
  'find_files',
] as const

/**
 * Read-only tools the CI investigator subagent may use: GitHub CLI run/PR
 * inspection for logs and check status, plus codebase reads to map a failure
 * back to the offending source.
 */
export const CI_INVESTIGATOR_TOOL_NAMES = [
  'gh_pr_view',
  'gh_pr_list',
  'gh_run_list',
  'gh_run_view',
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'find_files',
] as const

export const SUBAGENT_SYSTEM_PROMPT = `You are an exploration subagent for a coding assistant.

Your job is to read and search the workspace, then return a concise summary for the parent agent.

Rules:
- Use read_file, list_dir, search_codebase, search_code, and find_files as needed
- Prefer search_codebase (auto mode) or semantic_search over search_code alone — they combine regex and native semantic search
- Do not write files or run shell commands
- Cite file paths and line ranges when relevant
- Be thorough in exploration but concise in your final summary
- Your final message must be a structured summary the parent can use without re-reading files`

export const CI_INVESTIGATOR_SYSTEM_PROMPT = `You are a CI investigation subagent for a coding assistant.

Your job is to deeply analyze failing continuous-integration (CI) checks for a pull request, then return precise findings for the parent agent to act on. You do NOT fix anything yourself.

Rules:
- Start with gh_pr_view to see which checks are failing, then gh_run_list to find the failing run id(s), then gh_run_view to read the failed step logs
- Read the logs carefully: locate the first real error (not downstream noise), the failing command/step, and the exact file/line or test it points at
- Use read_file, search_codebase, search_code, list_dir, and find_files to tie the error back to the responsible source code
- Do not write files, push, or run shell commands — you are read-only
- Be thorough while investigating but concise in the final summary
- Your final message MUST be a structured findings report the parent can act on without re-reading the logs. Include: failing check(s), the root-cause error, the file(s)/line(s) involved, and a concrete suggested fix.`

export interface RunSubagentOptions {
  provider: LLMProvider
  prompt: string
  parentGoal: string
  tools: LLMTool[]
  executeTool: (name: string, args: unknown, signal: AbortSignal) => Promise<ToolExecuteResult>
  signal?: AbortSignal
  maxSteps?: number
  maxContextTokens?: number
  toolSchemaReserveTokens?: number
  onSubagentChunk: (chunk: StreamChunk) => void
  parentToolCallId: string
  systemPromptSuffix?: string
  /** Replace the default explore system prompt entirely (e.g. for a review subagent). */
  systemPrompt?: string
  /** Replace the default "exploration query" user-task framing with a ready-made task. */
  userTask?: string
  usageModel?: string
  /** Session kind reported to the renderer (drives the tool card label). */
  kind?: SubagentSession['kind']
}

export interface RunSubagentResult {
  session: SubagentSession
  summary: string
}

function buildUserTask(prompt: string, parentGoal: string, paths?: string[]): string {
  const parts = [`Parent task context: ${parentGoal}`, '', `Exploration query: ${prompt}`]
  if (paths?.length) {
    parts.push('', `Focus paths: ${paths.join(', ')}`)
  }
  parts.push('', 'Explore the workspace and return a concise summary for the parent agent.')
  return parts.join('\n')
}

export async function runSubagent(opts: RunSubagentOptions): Promise<RunSubagentResult> {
  const {
    provider,
    prompt,
    parentGoal,
    tools,
    executeTool,
    signal,
    maxSteps = 10,
    maxContextTokens,
    toolSchemaReserveTokens = 0,
    onSubagentChunk,
    parentToolCallId,
    systemPromptSuffix,
    systemPrompt,
    userTask,
    usageModel,
    kind = 'explore',
  } = opts

  const sessionId = randomUUID()
  const session: SubagentSession = {
    id: sessionId,
    kind,
    status: 'running',
    prompt,
    summary: null,
    messages: [],
  }

  onSubagentChunk({ type: 'subagent_start', parentToolCallId, session: { ...session } })

  let currentMsgId: string | null = null
  let toolSinceText = false

  const ensureAssistantMessage = (): string => {
    if (!currentMsgId || toolSinceText) {
      currentMsgId = randomUUID()
      const msg: SubagentMessage = {
        id: currentMsgId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        createdAt: Date.now(),
      }
      session.messages.push(msg)
      toolSinceText = false
    }
    return currentMsgId
  }

  const basePrompt = systemPrompt ?? SUBAGENT_SYSTEM_PROMPT
  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: systemPromptSuffix ? `${basePrompt}\n\n${systemPromptSuffix}` : basePrompt,
    },
    { role: 'user', content: userTask ?? buildUserTask(prompt, parentGoal) },
  ]

  let summary: string

  // Accumulate usage across all subagent steps from the per-step `usage` chunks
  // the loop emits (#58). Each chunk reflects exactly one stream, so subagent
  // usage is attributed once and never read from the shared mutable
  // provider.lastUsage that the parent also writes to (#112).
  const recordUsage = (chunk: Extract<StreamChunk, { type: 'usage' }>): void => {
    const prev = session.usage ?? { inputTokens: 0, outputTokens: 0 }
    const next: NonNullable<SubagentSession['usage']> = {
      inputTokens: prev.inputTokens + chunk.inputTokens,
      outputTokens: prev.outputTokens + chunk.outputTokens,
    }
    if (chunk.cacheReadTokens !== undefined || prev.cacheReadTokens !== undefined) {
      next.cacheReadTokens = (prev.cacheReadTokens ?? 0) + (chunk.cacheReadTokens ?? 0)
    }
    if (chunk.cacheCreationTokens !== undefined || prev.cacheCreationTokens !== undefined) {
      next.cacheCreationTokens = (prev.cacheCreationTokens ?? 0) + (chunk.cacheCreationTokens ?? 0)
    }
    session.usage = next
  }

  try {
    const loopOpts: Parameters<typeof runAgentLoop>[0] = {
      provider,
      messages,
      tools,
      maxSteps,
      maxLlmCalls: defaultMaxLlmCallsForSteps(maxSteps),
      toolSchemaReserveTokens,
      // Fallback only: used when a provider does not emit per-stream usage
      // chunks. The loop prefers in-stream usage to avoid the shared-field race.
      getLastUsage: () => (hasLastUsage(provider) ? provider.lastUsage : null),
      executeTool: (name: string, args: unknown, signal: AbortSignal, _toolCallId: string) =>
        executeTool(name, args, signal),
      onChunk: (chunk: StreamChunk) => {
        if (chunk.type === 'usage') {
          recordUsage(chunk)
        }
        if (chunk.type === 'text') {
          const msgId = ensureAssistantMessage()
          const msg = session.messages.find((m) => m.id === msgId)
          if (!msg) throw new Error(`subagent message ${msgId} not found`)
          msg.content += chunk.text
          onSubagentChunk({
            type: 'subagent_text',
            parentToolCallId,
            messageId: msgId,
            text: chunk.text,
          })
        }
        if (chunk.type === 'tool_call') {
          const msgId = ensureAssistantMessage()
          const msg = session.messages.find((m) => m.id === msgId)
          if (!msg) throw new Error(`subagent message ${msgId} not found`)
          msg.toolCalls.push({
            id: chunk.toolCall.id,
            name: chunk.toolCall.name,
            args: chunk.toolCall.args,
            status: 'running',
            result: null,
          })
          toolSinceText = true
          onSubagentChunk({
            type: 'subagent_tool_call',
            parentToolCallId,
            messageId: msgId,
            toolCall: chunk.toolCall,
          })
        }
        if (chunk.type === 'tool_result') {
          for (const msg of session.messages) {
            const tc = msg.toolCalls.find((t) => t.id === chunk.toolCallId)
            if (tc) {
              tc.status = chunk.isError ? 'error' : 'done'
              tc.result = chunk.result
              if (chunk.editStats) tc.editStats = chunk.editStats
              break
            }
          }
          onSubagentChunk({
            type: 'subagent_tool_result',
            parentToolCallId,
            toolCallId: chunk.toolCallId,
            result: chunk.result,
            isError: chunk.isError,
            ...(chunk.editStats ? { editStats: chunk.editStats } : {}),
          })
        }
      },
    }
    if (maxContextTokens !== undefined) loopOpts.maxContextTokens = maxContextTokens
    if (signal !== undefined) loopOpts.signal = signal
    if (usageModel !== undefined) loopOpts.usageModel = usageModel
    await runAgentLoop(loopOpts)

    // Collect final assistant text as summary
    const assistantTexts = session.messages
      .filter((m) => m.role === 'assistant' && m.content.trim())
      .map((m) => m.content.trim())
    summary = assistantTexts.at(-1) ?? 'Exploration completed with no summary.'

    session.status = 'done'
    session.summary = summary
    onSubagentChunk({
      type: 'subagent_done',
      parentToolCallId,
      summary,
      ...(session.usage ? { usage: session.usage } : {}),
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    session.status = 'error'
    session.summary = `Subagent error: ${error}`
    summary = session.summary
    onSubagentChunk({ type: 'subagent_error', parentToolCallId, error })
    onSubagentChunk({
      type: 'subagent_done',
      parentToolCallId,
      summary,
      ...(session.usage ? { usage: session.usage } : {}),
    })
  }

  return { session, summary }
}
