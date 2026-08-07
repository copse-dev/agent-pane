import { buildSearchRoutingPromptBlock } from '@copse/agent/search-routing.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { getWorkspaceIndexStatus } from './index-status.ts'
import {
  overlayWorktreeSemanticResults,
  type WorktreeSemanticOverlayOptions,
  type WorktreeSemanticOverlayResult,
} from './worktree-semantic-overlay.ts'
import {
  ensureSemanticIndex,
  formatSemanticSearchResults,
  isSemanticIndexReady,
  isSemanticSearchAvailable,
  searchSemanticContent,
} from './semantic-index.ts'
import { semanticIndexPending } from './workspace-index-gate.ts'

export function buildSemanticSearchPromptBlock(): string {
  return buildSearchRoutingPromptBlock(isSemanticSearchAvailable())
}

export interface SemanticSearchRequest {
  query: string
  filterPath?: string
  maxResults?: number
  /** Overlay the shared semantic snapshot with the active worktree's changed files. */
  includeWorktreeDelta?: boolean
}

let worktreeOverlayExecutor: (
  options: WorktreeSemanticOverlayOptions,
) => Promise<WorktreeSemanticOverlayResult> = overlayWorktreeSemanticResults

/** Test hook — replace git/filesystem worktree overlay generation. */
export function setWorktreeSemanticOverlayExecutorForTest(
  executor:
    ((options: WorktreeSemanticOverlayOptions) => Promise<WorktreeSemanticOverlayResult>) | null,
): void {
  worktreeOverlayExecutor = executor ?? overlayWorktreeSemanticResults
}

export type SemanticSearchOutcome =
  | { status: 'ok'; text: string }
  /** Backend exists but this root's index hasn't finished a build pass yet. */
  | { status: 'building' }
  | { status: 'unavailable' }

/**
 * Tool-facing note for the `building` outcome. Semantic tools return this
 * immediately instead of blocking the agent on the cold build (up to five
 * minutes on a fresh repo, #517) — the model gets steered to regex/read
 * tools until the index is queryable.
 */
export function semanticIndexBuildingNote(): string {
  if (isActiveSshWorkspace()) {
    return (
      'Semantic search is unavailable for SSH remote workspaces (v1). ' +
      'Use regex search (search_code, or search_codebase with mode: regex) instead.'
    )
  }
  if (isWorktreeExecutionContext()) {
    return (
      'The shared semantic index used by this worktree is still building. ' +
      'Use regex search (search_code, or search_codebase with mode: regex) for now.'
    )
  }
  const semantic = getWorkspaceIndexStatus().semantic
  if (semantic.phase === 'limited' || semantic.phase === 'skipped') {
    const detail = semantic.reason ? ` (${semantic.reason})` : ''
    return (
      `Semantic index is ${semantic.phase} for this workspace${detail}. ` +
      'Text/regex search remains available — use search_code, or search_codebase with mode: regex, ' +
      'or read_file.'
    )
  }
  const startedAt = semantic.startedAt
  const elapsed =
    startedAt !== undefined
      ? ` (${String(Math.round((Date.now() - startedAt) / 1000))}s so far)`
      : ''
  return (
    `Semantic index is still building${elapsed} — a fresh repo can take minutes. ` +
    'Use regex search (search_code, or search_codebase with mode: regex) or read_file ' +
    'for now, and retry semantic search later in this session.'
  )
}

/** True when the active turn executes in a linked worktree checkout. */
export function isWorktreeExecutionContext(): boolean {
  return getThreadExecutionContext()?.checkoutMode === 'worktree'
}

/** Native gortex/vera search, with a worktree-local delta overlay when needed. */
export async function executeSemanticSearch(
  request: SemanticSearchRequest,
  signal: AbortSignal,
): Promise<SemanticSearchOutcome> {
  const executionRoot = getAgentExecutionRoot()
  const context = getThreadExecutionContext()
  const maxResults = request.maxResults ?? 20

  if (!executionRoot || !isSemanticSearchAvailable()) return { status: 'unavailable' }

  const semanticPhase = getWorkspaceIndexStatus().semantic.phase
  if (semanticPhase === 'limited' || semanticPhase === 'skipped') {
    return { status: 'unavailable' }
  }

  const isWorktree = context?.checkoutMode === 'worktree'
  const indexRoot = isWorktree ? context.projectRoot : executionRoot
  if (semanticIndexPending(indexRoot)) return { status: 'building' }

  if (!isSemanticIndexReady(indexRoot)) {
    // Worktrees reuse the project root's index. This starts only the shared
    // baseline and never asks gortex to track the linked checkout.
    void ensureSemanticIndex(indexRoot)
    return { status: 'building' }
  }

  const includeWorktreeDelta = isWorktree && request.includeWorktreeDelta !== false
  const baselineLimit = includeWorktreeDelta ? Math.min(1000, maxResults * 5) : maxResults
  const native = await searchSemanticContent({
    query: request.query,
    workspaceRoot: indexRoot,
    maxResults: baselineLimit,
    signal,
    ...(request.filterPath ? { filterPath: request.filterPath } : {}),
  })
  if (!native) return { status: 'unavailable' }

  if (!includeWorktreeDelta) {
    return {
      status: 'ok',
      text: formatSemanticSearchResults(native.hits, maxResults, native.backend),
    }
  }

  try {
    const overlay = await worktreeOverlayExecutor({
      query: request.query,
      projectRoot: context.projectRoot,
      worktreeRoot: executionRoot,
      maxResults,
      baselineHits: native.hits,
      signal,
      ...(request.filterPath ? { filterPath: request.filterPath } : {}),
    })
    return {
      status: 'ok',
      text:
        formatSemanticSearchResults(overlay.hits, maxResults, native.backend) +
        `\n[Applied worktree delta overlay across ${String(overlay.changedPathCount)} changed paths.]`,
    }
  } catch (error) {
    console.warn('[copse-panel] worktree semantic delta failed:', error)
    return { status: 'unavailable' }
  }
}
