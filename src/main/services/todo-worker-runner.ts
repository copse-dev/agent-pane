import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import {
  PRODUCT_REASONING_CHECKPOINT_POLICY,
  PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS,
} from '@copse/agent/reasoning-checkpoint-policy.ts'
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
- You may be given the overall goal, the full plan, and summaries of already-completed
  steps below — read them first and reuse what they already found (file locations,
  patterns to mirror, decisions made) instead of re-exploring the codebase from scratch
- Use read_file / search_codebase to understand context before editing
- Use write_file for code changes (user approves diffs)
- Use run_shell when the item requires commands or tests
- Finish with a brief summary of what you did, naming the files you touched or
  discovered so a later step can reuse that instead of rediscovering it`

export interface RunTodoWorkerOptions {
  item: TodoItem
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  onChunk?: (chunk: StreamChunk) => void
  /** The user's original request for this run, so the worker has real intent, not just its one line. */
  parentGoal?: string
  /** The full plan this item belongs to, so the worker sees what else is (or isn't) in scope. */
  allTodos?: readonly TodoItem[]
  /** Summaries returned by earlier local workers in this run, keyed by todo id (decision: reuse over rediscovery). */
  priorSummaries?: ReadonlyMap<string, string>
}

function buildTodoWorkerBrief(opts: RunTodoWorkerOptions): string {
  const sections: string[] = []
  if (opts.parentGoal?.trim()) {
    sections.push(`Overall task the user asked for:\n${opts.parentGoal.trim()}`)
  }

  const siblings = (opts.allTodos ?? []).filter((t) => t.id !== opts.item.id)
  if (siblings.length > 0) {
    const planLines = siblings.map((t) => `- [${t.status}] ${t.content}`)
    sections.push(
      `Full plan for this task (context only — do not do these, only your item below):\n${planLines.join('\n')}`,
    )
  }

  const priorSummaries = opts.priorSummaries
  if (priorSummaries?.size) {
    const summaryLines = siblings
      .map((t) => ({ t, summary: priorSummaries.get(t.id) }))
      .filter((entry): entry is { t: TodoItem; summary: string } => entry.summary !== undefined)
      .map(({ t, summary }) => `- ${t.content}\n  ${summary}`)
    if (summaryLines.length > 0) {
      sections.push(
        `What earlier steps already found or did (reuse this — do not re-derive it):\n${summaryLines.join('\n')}`,
      )
    }
  }

  sections.push(
    `Your assigned todo item:\n${opts.item.content}\n\nComplete this item and summarize what you did.`,
  )
  return sections.join('\n\n')
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
  const { provider, registry, contextWindow, toolSchemaReserve, signal, onChunk } = opts

  const messages: LLMMessage[] = [
    { role: 'system', content: TODO_WORKER_PROMPT },
    { role: 'user', content: buildTodoWorkerBrief(opts) },
  ]

  let summary = ''
  await runAgentLoop({
    provider,
    messages,
    tools: filterWorkerTools(registry),
    maxSteps: 12,
    reasoningCheckpointPolicy: PRODUCT_REASONING_CHECKPOINT_POLICY,
    reasoningRunawayTextToleranceChars: PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS,
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
