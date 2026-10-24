import type { Message, StreamChunk, Thread } from '@shared/types'

/**
 * One agent turn as the loop streams it: reasoning, an answer interrupted by a
 * tool, a second step after the tool result, usage, todos and the terminal
 * outcome. Shaped after real native-loop output so both reducers meet every
 * bubble boundary the renderer draws.
 */
export function recordedTurn(): StreamChunk[] {
  return [
    {
      type: 'turn_parameters',
      parameters: { reasoning: 'medium' },
      model: 'openai:gpt-5.5',
      requestedModel: 'auto:fast',
    },
    { type: 'reasoning', text: 'Read the plan first.' },
    { type: 'text', text: 'Checking the plan' },
    { type: 'text', text: ' before answering.' },
    {
      type: 'tool_call',
      toolCall: { id: 'call-read', name: 'read_file', args: { path: 'PLAN.md' } },
    },
    { type: 'tool_result', toolCallId: 'call-read', result: '1. Ship it', isError: false },
    { type: 'usage', model: 'openai:gpt-5.5', inputTokens: 120, outputTokens: 40 },
    {
      type: 'todo_update',
      todos: [{ id: 'todo-1', content: 'Ship it', status: 'in_progress' }],
    },
    { type: 'reasoning', text: 'One step.' },
    { type: 'text', text: 'The plan has one step: ship it.' },
    {
      type: 'acp_content',
      channel: 'message',
      content: { type: 'text', text: ' Done.' },
    },
    { type: 'usage', model: 'openai:gpt-5.5', inputTokens: 160, outputTokens: 30 },
    {
      type: 'turn_outcome',
      outcome: {
        status: 'completed',
        stopReason: 'end_turn',
        source: 'provider',
        executor: 'local',
        provider: 'openai',
        model: 'openai:gpt-5.5',
        endedAt: 50,
      },
    },
    { type: 'done' },
  ]
}

export function threadWith(id: string, messages: Message[] = []): Thread {
  return {
    id,
    title: id,
    status: 'running',
    messages,
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

export function humanPrompt(id: string, content: string): Message {
  return { id, role: 'user', content, toolCalls: [], createdAt: 10 }
}

/** Messages with wall-clock fields zeroed, for comparing two reductions. */
export function comparable(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ ...structuredClone(message), createdAt: 0 }))
}
