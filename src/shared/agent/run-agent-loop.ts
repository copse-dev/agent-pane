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

export async function runAgentLoop(opts: AgentLoopOptions): Promise<void> {
  const { provider, messages, tools, onChunk, signal, maxSteps = 20 } = opts
  let steps = 0

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
    if (pendingToolCalls.length === 0) break

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

  onChunk({ type: 'done' })
}
