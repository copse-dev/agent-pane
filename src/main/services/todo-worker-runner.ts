import { runAgentLoop } from '@shared/agent/run-agent-loop.ts'
import type { LLMMessage, LLMProvider, LLMTool, StreamChunk } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import type { ToolRegistry } from './tool-registry.ts'

const TODO_WORKER_TOOLS = [
  'read_file',
  'list_dir',
  'search_codebase',
  'write_file',
  'run_shell',
] as const

const TODO_WORKER_PROMPT = `You are a local worker executing a single todo item for a coding assistant.

Rules:
- Complete ONLY the assigned todo item — do not expand scope
- Use read_file / search_codebase to understand context before editing
- Use write_file for code changes (user approves diffs)
- Use run_shell when the item requires commands or tests
- Finish with a brief summary of what you did`

export interface RunTodoWorkerOptions {
  item: TodoItem
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  onChunk?: (chunk: StreamChunk) => void
}

export interface TodoWorkerResult {
  summary: string
  usage: { inputTokens: number; outputTokens: number }
}

function filterWorkerTools(registry: ToolRegistry): LLMTool[] {
  const allowed = new Set<string>(TODO_WORKER_TOOLS)
  return registry.toLLMTools().filter((t) => allowed.has(t.name))
}

interface ProviderWithUsage {
  lastUsage: { inputTokens: number; outputTokens: number } | null
}

function hasLastUsage(p: unknown): p is ProviderWithUsage {
  return typeof p === 'object' && p !== null && 'lastUsage' in p
}

export async function runTodoWorker(opts: RunTodoWorkerOptions): Promise<TodoWorkerResult> {
  const { item, provider, registry, contextWindow, toolSchemaReserve, signal, onChunk } = opts

  const messages: LLMMessage[] = [
    { role: 'system', content: TODO_WORKER_PROMPT },
    {
      role: 'user',
      content: `Todo item:\n${item.content}\n\nComplete this item and summarize what you did.`,
    },
  ]

  let summary = ''
  await runAgentLoop({
    provider,
    messages,
    tools: filterWorkerTools(registry),
    maxSteps: 12,
    maxContextTokens: contextWindow,
    toolSchemaReserveTokens: toolSchemaReserve,
    signal,
    executeTool: (name, args, sig) => registry.execute(name, args, sig),
    onChunk: (chunk) => {
      onChunk?.(chunk)
      if (chunk.type === 'text') summary += chunk.text
    },
  })

  const trimmed = summary.trim() || 'Worker finished with no summary.'
  let inputTokens = 0
  let outputTokens = 0
  if (hasLastUsage(provider) && provider.lastUsage) {
    inputTokens = provider.lastUsage.inputTokens
    outputTokens = provider.lastUsage.outputTokens
  }
  return { summary: trimmed, usage: { inputTokens, outputTokens } }
}
