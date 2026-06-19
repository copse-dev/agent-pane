import type {
  LLMProvider,
  LLMMessage,
  LLMTool,
  StreamChunk,
  ToolCallChunk,
  ToolResult,
} from '@shared/types'

export interface AgentLoopOptions {
  provider: LLMProvider
  messages: LLMMessage[] // mutated in-place as turns are added
  tools: LLMTool[]
  onChunk: (chunk: StreamChunk) => void
  executeTool: (name: string, args: unknown, signal: AbortSignal) => Promise<string>
  signal?: AbortSignal
  maxSteps?: number
}

const FINALIZE_NUDGE =
  'Based on your exploration so far, write a clear final answer for the user. Do not call any tools.'

const INCOMPLETE_RUN_MESSAGE =
  'The agent stopped before producing a final answer. Try a shorter question, reduce tool use, or switch models.'

async function streamTextOnlyTurn(
  provider: LLMProvider,
  messages: LLMMessage[],
  onChunk: (chunk: StreamChunk) => void,
  signal?: AbortSignal,
): Promise<string> {
  const turnMessages: LLMMessage[] = [...messages, { role: 'user', content: FINALIZE_NUDGE }]
  let assistantText = ''

  for await (const chunk of provider.stream(turnMessages, [], signal)) {
    if (signal?.aborted) break
    if (chunk.type === 'text') {
      assistantText += chunk.text
      onChunk(chunk)
    }
    if (chunk.type === 'done') break
  }

  const trimmed = assistantText.trim()
  if (trimmed) {
    messages.push({ role: 'assistant', content: assistantText })
  }
  return trimmed
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { provider, messages, tools, onChunk, signal, maxSteps = 20 } = opts
  let steps = 0
  let finishedWithAnswer = false

  while (steps < maxSteps) {
    if (signal?.aborted) break
    steps++

    // Collect one full LLM response
    let assistantText = ''
    const pendingToolCalls: ToolCallChunk[] = []

    for await (const chunk of provider.stream(messages, tools, signal)) {
      if (signal?.aborted) break
      if (chunk.type === 'text') {
        assistantText += chunk.text
        onChunk(chunk)
      }
      if (chunk.type === 'tool_call') {
        pendingToolCalls.push(chunk.toolCall)
        onChunk(chunk)
      }
      if (chunk.type === 'done') break
    }

    if (signal?.aborted) break

    // Push assistant message to history
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: pendingToolCalls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
      })
    } else {
      messages.push({ role: 'assistant', content: assistantText })
    }

    // No tool calls — we're done
    if (pendingToolCalls.length === 0) {
      if (assistantText.trim()) finishedWithAnswer = true
      break
    }

    // Execute tools and collect results
    const toolResults: ToolResult[] = []
    for (const tc of pendingToolCalls) {
      if (signal?.aborted) break
      try {
        const result = await opts.executeTool(
          tc.name,
          tc.args,
          signal ?? new AbortController().signal,
        )
        toolResults.push({ toolCallId: tc.id, result })
        onChunk({ type: 'tool_result', toolCallId: tc.id, result, isError: false })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toolResults.push({ toolCallId: tc.id, result: `Error: ${msg}` })
        onChunk({ type: 'tool_result', toolCallId: tc.id, result: `Error: ${msg}`, isError: true })
      }
    }

    if (signal?.aborted) break

    // Push tool results to history
    messages.push({ role: 'tool', toolResults })
  }

  if (!signal?.aborted && !finishedWithAnswer) {
    const finalText = await streamTextOnlyTurn(provider, messages, onChunk, signal)
    if (!finalText.trim()) {
      onChunk({ type: 'text', text: INCOMPLETE_RUN_MESSAGE })
      messages.push({ role: 'assistant', content: INCOMPLETE_RUN_MESSAGE })
    } else {
      finishedWithAnswer = true
    }
  }

  onChunk({ type: 'done' })
}
