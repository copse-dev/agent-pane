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
- Complete ONLY the assigned todo item below — do not expand scope, and do not act on
  anything mentioned only in the background context (it is background, not your task)
- If background context below already names a file or pattern you need, reuse it
  instead of re-exploring the codebase to rediscover it
- Use read_file / search_codebase to understand context before editing
- Use write_file for code changes (user approves diffs)
- Use run_shell when the item requires commands or tests
- Finish with a brief summary of what you did, naming the files you touched or
  discovered so a later step can reuse that instead of rediscovering it`

/** Prior-summary context is background, not a task list — bound it so a long plan
 * can't crowd out a small local model's context window. */
const MAX_PRIOR_SUMMARY_CONTEXT_CHARS = 2_000

/**
 * Longest single background entry. A worker's summary is free-form text
 * accumulated across its whole run, so one verbose worker can exceed the entire
 * budget on its own — without a per-entry cap the newest (most relevant) step
 * would push every other step out, or drop the section entirely.
 */
const MAX_PRIOR_SUMMARY_ENTRY_CHARS = 600

function truncateForBrief(text: string, max: number): string {
  const clean = text.trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

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
  /**
   * What earlier local workers in this run already found or did, keyed by todo id
   * (decision: reuse over rediscovery). Deliberately just this — not the rest of the
   * plan — so the worker sees outcomes to reuse, not a menu of other work to drift into.
   */
  priorSummaries?: ReadonlyMap<string, { content: string; summary: string }>
}

function buildTodoWorkerBrief(opts: RunTodoWorkerOptions): string {
  const sections: string[] = []
  if (opts.parentGoal?.trim()) {
    sections.push(`Overall task the user asked for:\n${opts.parentGoal.trim()}`)
  }

  const priorSummaries = opts.priorSummaries
  if (priorSummaries?.size) {
    const lines: string[] = []
    let usedChars = 0
    // Most recent first: on a long plan the nearest prior step is the most likely
    // to be relevant to this one, so it should survive the char budget first. An
    // entry that still doesn't fit is skipped rather than ending the scan, so one
    // fat summary costs only itself instead of every older step behind it.
    for (const { content, summary } of [...priorSummaries.values()].reverse()) {
      const line = truncateForBrief(`- ${content}\n  ${summary}`, MAX_PRIOR_SUMMARY_ENTRY_CHARS)
      if (usedChars + line.length > MAX_PRIOR_SUMMARY_CONTEXT_CHARS) continue
      lines.push(line)
      usedChars += line.length
    }
    if (lines.length > 0) {
      sections.push(
        `Background — what earlier steps in this plan already found or did (reuse this, it is not your task):\n${lines.reverse().join('\n')}`,
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
