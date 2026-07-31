import { buildSearchRoutingPromptBlock } from '@copse/agent/search-routing.ts'
import { getAgentExecutionRoot } from '../execution-root.ts'
import { getThreadExecutionContext } from '../thread-execution-context.ts'
import { isActiveSshWorkspace } from '../ssh-workspace/execution-target.ts'
import { getWorkspaceIndexStatus } from './index-status.ts'
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
      'Semantic search is unavailable inside worktree threads (v1) — the native ' +
      'index only tracks the shared workspace checkout. Use regex search ' +
      '(search_code, or search_codebase with mode: regex) instead.'
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

/**
 * True when the active agent turn is running inside a worktree thread's linked
 * checkout rather than the shared workspace root. gortex/vera only ever index
 * the workspace root (`scopeGortexToActiveRepo` scopes the shared daemon to
 * one active repo), so semantic search inside a worktree thread must fall back
 * to regex/text search rather than silently answering from the wrong checkout
 * (#1400) — the same posture already taken for SSH workspaces.
 */
export function isWorktreeExecutionContext(): boolean {
  return getThreadExecutionContext()?.checkoutMode === 'worktree'
}

/** Native gortex/vera semantic search only. */
export async function executeSemanticSearch(
  request: SemanticSearchRequest,
  signal: AbortSignal,
): Promise<SemanticSearchOutcome> {
  const root = getAgentExecutionRoot()
  const maxResults = request.maxResults ?? 20

  if (!root || !isSemanticSearchAvailable() || isWorktreeExecutionContext()) {
    return { status: 'unavailable' }
  }

  const semanticPhase = getWorkspaceIndexStatus().semantic.phase
  if (semanticPhase === 'limited' || semanticPhase === 'skipped') {
    return { status: 'unavailable' }
  }

  if (semanticIndexPending(root)) {
    return { status: 'building' }
  }

  if (!isSemanticIndexReady(root)) {
    // Kick (or join) the build in the background rather than awaiting it —
    // workspace open already started it, so this only matters when that
    // failed or the workspace was opened through an unusual path.
    void ensureSemanticIndex(root)
    return { status: 'building' }
  }

  const native = await searchSemanticContent({
    query: request.query,
    workspaceRoot: root,
    maxResults,
    signal,
    ...(request.filterPath ? { filterPath: request.filterPath } : {}),
  })
  if (!native) return { status: 'unavailable' }

  return {
    status: 'ok',
    text: formatSemanticSearchResults(native.hits, maxResults, native.backend),
  }
}
