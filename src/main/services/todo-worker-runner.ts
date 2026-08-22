import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import {
  PRODUCT_REASONING_CHECKPOINT_POLICY,
  PRODUCT_REASONING_CHECKPOINT_TEXT_TOLERANCE_CHARS,
} from '@copse/agent/reasoning-checkpoint-policy.ts'
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { LLMMessage, LLMProvider, LLMTool, StreamChunk } from '@shared/types'
import type { TodoItem } from '@shared/types/todo.ts'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import type { ToolRegistry } from './tool-registry.ts'
import { errorMessage } from '@shared/errors.ts'
import type { ThreadExecutionContext } from './thread-execution-context.ts'
import { runWithThreadExecutionContext } from './thread-execution-context.ts'
import {
  commitTodoWorkerOutput,
  resolveTodoWorkerBranch,
  type TodoWorkerCommit,
} from './todo-worker-worktree.ts'
import {
  expectedThreadWorktreePath,
  releaseWorktreeRoot,
  repositoryLocation,
  runWorktreeGit,
} from './worktree-manager.ts'
import { registerInternalWorkspaceRoot } from './workspace.ts'

/**
 * Worker checkouts live beside thread worktrees but under a `todo-` owner
 * prefix, so the orphan sweep can tell them apart by name without new state.
 */
function expectedTodoWorkerWorktreePath(projectId: string, todoId: string): string {
  const compact = todoId.toLowerCase().replace(/[^a-z0-9]/g, '') || 'item'
  return expectedThreadWorktreePath(projectId, `todo-${compact}`)
}

async function requireGitValue(cwd: string, args: string[], action: string): Promise<string> {
  const result = await runWorktreeGit(cwd, args)
  const value = result.stdout.trim()
  if (result.code !== 0 || !value) throw new Error(action)
  return value
}

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
  /**
   * Set only when the worker ran in its own linked worktree
   * (`parallelTodoWorkersEnabled`): the branch its one commit landed on, the
   * commit sha (null when the worker produced no file changes), and whether the
   * worktree was retired after absorption. The serial in-checkout path leaves
   * this undefined — its output is the thread checkout's own dirty state.
   */
  worktree?: { branch: string; sha: string | null; retired: boolean }
}

function filterWorkerTools(registry: ToolRegistry): LLMTool[] {
  const allowed = new Set<string>(TODO_WORKER_TOOLS)
  return registry.toLLMTools().filter((t) => allowed.has(t.name))
}

export async function runTodoWorker(opts: RunTodoWorkerOptions): Promise<TodoWorkerResult> {
  const { provider, registry, contextWindow, toolSchemaReserve, signal, onChunk } = opts

  const messages: LLMMessage[] = [
    { role: 'system', content: TODO_WORKER_PROMPT },
    { role: 'user', content: buildTodoWorkerBrief(opts) },
  ]

  let summary = ''
  // Accumulated from the loop's per-stream `usage` chunks rather than read back
  // from the shared mutable `provider.lastUsage`: parallel workers (see
  // docs/plans/parallel-todo-workers.md) would otherwise attribute a sibling's
  // final stream to themselves (#112 made the same fix for subagents).
  let inputTokens = 0
  let outputTokens = 0
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
      if (chunk.type === 'usage') {
        inputTokens += chunk.inputTokens
        outputTokens += chunk.outputTokens
      }
      if (chunk.type === 'text') summary += chunk.text
    },
  })

  const trimmed = summary.trim() || 'Worker finished with no summary.'
  return { summary: trimmed, usage: { inputTokens, outputTokens } }
}

export interface RunTodoWorkerInWorktreeOptions extends RunTodoWorkerOptions {
  projectId: string
  threadId: string
  /** The thread execution context the parent turn is running under. */
  parentContext: ThreadExecutionContext
  /** Base the worker worktree cuts from; defaults to the thread root's HEAD. */
  baseBranch?: string
  authorName: string
  authorEmail: string
}

export interface TodoWorktreeOutcome {
  result: TodoWorkerResult
  worktree: ThreadWorktree
  commit: TodoWorkerCommit
  retired: boolean
}

/**
 * Run one local todo worker in its own linked worktree, then commit its output
 * on the worker branch host-side (phase 2, docs/plans/parallel-todo-workers.md).
 *
 * The worker loop runs under a nested ThreadExecutionContext pointing at the
 * worker checkout, so every tool the worker calls resolves there by
 * construction. On any outcome the worktree is retired when its commit is
 * absorbed (here: committed and its branch kept — absorption into the thread
 * branch is the consolidator's job in phase 3, so phase 2 keeps the branch and
 * reports it); a failed run retains the worktree for inspection. The parent's
 * checkout is never touched.
 */
export async function runTodoWorkerInWorktree(
  opts: RunTodoWorkerInWorktreeOptions,
): Promise<TodoWorktreeOutcome> {
  const { projectId, threadId, parentContext, baseBranch, item } = opts
  const projectRoot = parentContext.projectRoot
  const location = await repositoryLocation(projectRoot)
  const repoRoot = location.repositoryRoot
  const baseRef =
    baseBranch ??
    (await requireGitValue(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], 'Cannot read HEAD'))

  const branch = await resolveTodoWorkerBranch(repoRoot, item.id)
  const baseCommit = await requireGitValue(
    repoRoot,
    ['rev-parse', '--verify', `${baseRef}^{commit}`],
    `Cannot resolve base ${baseRef}`,
  )
  const target = expectedTodoWorkerWorktreePath(projectId, item.id)
  await mkdir(dirname(target), { recursive: true })
  const add = await runWorktreeGit(repoRoot, ['worktree', 'add', '-b', branch, target, baseCommit])
  if (add.code !== 0)
    throw new Error(`Cannot create todo worker worktree: ${(add.stderr || add.stdout).trim()}`)

  const canonicalPath = await realpath(target)
  const executionRoot = resolve(canonicalPath, location.projectRelativePath)
  await mkdir(executionRoot, { recursive: true })
  const worktree: ThreadWorktree = {
    path: canonicalPath,
    branch,
    baseBranch: baseRef,
    baseCommit,
    createdAt: Date.now(),
    seededFromDirtyProject: false,
  }
  await registerInternalWorkspaceRoot(canonicalPath, executionRoot)

  const workerContext: ThreadExecutionContext = Object.freeze({
    projectId,
    threadId,
    projectRoot,
    root: executionRoot,
    checkoutMode: 'worktree' as const,
    branch,
  })

  let retired = false
  // No try/catch here by design: on any failure the worktree and branch are
  // deliberately retained — the worker's partial output stays on disk for
  // inspection and the orphan sweep surfaces it in the inventory. Callers see
  // the original error untouched.
  const result = await runWithThreadExecutionContext(workerContext, () => runTodoWorker(opts))
  const commit = await commitTodoWorkerOutput({
    worktreePath: canonicalPath,
    branch,
    item,
    authorName: opts.authorName,
    authorEmail: opts.authorEmail,
  })
  // Phase 2 keeps the branch (the consolidator absorbs it in phase 3); the
  // checkout itself is dropped as soon as the commit exists, because the
  // commit fully captures the tree.
  const remove = await runWorktreeGit(repoRoot, ['worktree', 'remove', canonicalPath])
  if (remove.code === 0) {
    releaseWorktreeRoot(executionRoot)
    retired = true
  }
  return {
    result: {
      ...result,
      ...(retired ? { worktree: { branch, sha: commit.sha, retired } } : {}),
    },
    worktree,
    commit,
    retired,
  }
}

export interface RunTodoWorkerBatchOptions {
  items: TodoItem[]
  projectId: string
  threadId: string
  parentContext: ThreadExecutionContext
  provider: LLMProvider
  registry: ToolRegistry
  contextWindow: number
  toolSchemaReserve: number
  signal: AbortSignal
  onChunk?: (chunk: StreamChunk) => void
  parentGoal?: string
  priorSummaries?: ReadonlyMap<string, { content: string; summary: string }>
  /** Concurrent worker cap (todoWorkerParallelism). */
  parallelism: number
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
  /**
   * Per-item completion. `passed` is true whenever the run finished; a thrown
   * worker reports through {@link onItemFailed} instead, never here.
   */
  onItemDone?: (item: TodoItem, passed: boolean) => void
  onItemFailed?: (item: TodoItem, message: string) => void
}

export interface TodoWorkerBatchEntry {
  item: TodoItem
  ok: boolean
  summary: string
  branch: string | null
  sha: string | null
  error?: string
}

/**
 * Fan out independent local workers concurrently (phase 3,
 * docs/plans/parallel-todo-workers.md). All worktrees cut from the parent
 * checkout's current HEAD so later cherry-picks are clean three-way merges.
 * Bounded by a semaphore at `parallelism`; one worker's crash never strands its
 * siblings (`Promise.all` over per-entry catches). Every settled entry carries
 * its worker branch and commit for the consolidator; failures retain their
 * worktrees for inspection.
 */
export async function runTodoWorkerBatch(
  opts: RunTodoWorkerBatchOptions,
): Promise<TodoWorkerBatchEntry[]> {
  const { items, parallelism, signal } = opts

  let active = 0
  const waiters: (() => void)[] = []
  const acquire = async (): Promise<void> => {
    // Waiter handoff, not a re-check: a slot release wakes exactly one queued
    // worker and that worker owns it unconditionally. Re-checking `active`
    // after waking would let a fresh arrival race past queued waiters and
    // exceed `parallelism` (observed peak 5 at cap 2 in the batch test).
    if (active < Math.max(1, parallelism) && waiters.length === 0) {
      active += 1
      return
    }
    await new Promise<void>((resolve) => waiters.push(resolve))
    active += 1
  }
  const release = (): void => {
    active -= 1
    waiters.shift()?.()
  }

  return Promise.all(
    items.map(async (item): Promise<TodoWorkerBatchEntry> => {
      await acquire()
      try {
        sendWorkerStart(opts.onChunk, item)
        const outcome = await runTodoWorkerInWorktree({
          item,
          provider: opts.provider,
          registry: opts.registry,
          contextWindow: opts.contextWindow,
          toolSchemaReserve: opts.toolSchemaReserve,
          signal,
          ...(opts.onChunk ? { onChunk: opts.onChunk } : {}),
          ...(opts.parentGoal !== undefined ? { parentGoal: opts.parentGoal } : {}),
          ...(opts.priorSummaries ? { priorSummaries: opts.priorSummaries } : {}),
          projectId: opts.projectId,
          threadId: opts.threadId,
          parentContext: opts.parentContext,
          authorName: 'Copse Todo Worker',
          authorEmail: 'todo-worker@copse.local',
        })
        opts.onUsage?.(outcome.result.usage)
        opts.onItemDone?.(item, true)
        sendWorkerDone(opts.onChunk, item.id, outcome.result.summary, true)
        return {
          item,
          ok: true,
          summary: outcome.result.summary,
          branch: outcome.commit.branch,
          sha: outcome.commit.sha,
        }
      } catch (error) {
        const message = errorMessage(error)
        opts.onItemFailed?.(item, message)
        sendWorkerDone(opts.onChunk, item.id, message, false)
        return { item, ok: false, summary: '', branch: null, sha: null, error: message }
      } finally {
        release()
      }
    }),
  )
}

function sendWorkerStart(
  onChunk: ((chunk: StreamChunk) => void) | undefined,
  item: TodoItem,
): void {
  onChunk?.({ type: 'todo_worker_start', todoId: item.id, content: item.content })
}

function sendWorkerDone(
  onChunk: ((chunk: StreamChunk) => void) | undefined,
  todoId: string,
  summary: string,
  passed: boolean,
): void {
  onChunk?.({ type: 'todo_worker_done', todoId, summary, passed })
}
