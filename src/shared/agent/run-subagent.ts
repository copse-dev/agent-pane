import { runAgentLoop } from './run-agent-loop.ts'
import type {
  LLMProvider,
  LLMMessage,
  LLMTool,
  StreamChunk,
  SubagentSession,
  SubagentMessage,
} from '@shared/types'

const randomUUID = () => globalThis.crypto.randomUUID()

export const EXPLORE_TOOL_NAMES = [
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
- Prefer search_codebase (auto mode) over search_code alone — it combines regex and semantic MCP search
- Do not write files or run shell commands
- Cite file paths and line ranges when relevant
- Be thorough in exploration but concise in your final summary
- Your final message must be a structured summary the parent can use without re-reading files`

export interface RunSubagentOptions {
  provider: LLMProvider
  prompt: string
  parentGoal: string
  tools: LLMTool[]
  executeTool: (name: string, args: unknown, signal: AbortSignal) => Promise<string>
  signal?: AbortSignal
  maxSteps?: number
  maxContextTokens?: number
  toolSchemaReserveTokens?: number
  onSubagentChunk: (chunk: StreamChunk) => void
  parentToolCallId: string
  systemPromptSuffix?: string
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
  } = opts

  const sessionId = randomUUID()
  const session: SubagentSession = {
    id: sessionId,
    kind: 'explore',
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
      }
      session.messages.push(msg)
      toolSinceText = false
    }
    return currentMsgId
  }

  const messages: LLMMessage[] = [
    {
      role: 'system',
      content: systemPromptSuffix
        ? `${SUBAGENT_SYSTEM_PROMPT}\n\n${systemPromptSuffix}`
        : SUBAGENT_SYSTEM_PROMPT,
    },
    { role: 'user', content: buildUserTask(prompt, parentGoal) },
  ]

  let summary = ''

  try {
    const loopOpts = {
      provider,
      messages,
      tools,
      maxSteps,
      toolSchemaReserveTokens,
      executeTool: (name: string, args: unknown, signal: AbortSignal, _toolCallId: string) =>
        executeTool(name, args, signal),
      onChunk: (chunk: StreamChunk) => {
        if (chunk.type === 'text') {
          const msgId = ensureAssistantMessage()
          const msg = session.messages.find((m) => m.id === msgId)!
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
          const msg = session.messages.find((m) => m.id === msgId)!
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
              break
            }
          }
          onSubagentChunk({
            type: 'subagent_tool_result',
            parentToolCallId,
            toolCallId: chunk.toolCallId,
            result: chunk.result,
            isError: chunk.isError,
          })
        }
      },
    }
    if (maxContextTokens !== undefined) {
      Object.assign(loopOpts, { maxContextTokens })
    }
    if (signal !== undefined) {
      Object.assign(loopOpts, { signal })
    }
    await runAgentLoop(loopOpts)

    // Collect final assistant text as summary
    const assistantTexts = session.messages
      .filter((m) => m.role === 'assistant' && m.content.trim())
      .map((m) => m.content.trim())
    summary = assistantTexts.at(-1) ?? 'Exploration completed with no summary.'

    session.status = 'done'
    session.summary = summary
    onSubagentChunk({ type: 'subagent_done', parentToolCallId, summary })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    session.status = 'error'
    session.summary = `Subagent error: ${error}`
    summary = session.summary
    onSubagentChunk({ type: 'subagent_error', parentToolCallId, error })
    onSubagentChunk({ type: 'subagent_done', parentToolCallId, summary })
  }

  return { session, summary }
}
