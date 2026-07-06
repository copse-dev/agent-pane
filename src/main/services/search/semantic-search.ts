import { buildSearchRoutingPromptBlock } from '@shared/agent/search-routing.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { getWorkspaceIndexStatus } from './index-status.ts'
import {
  ensureSemanticIndex,
  formatSemanticSearchResults,
  isSemanticIndexReady,
  isSemanticSearchAvailable,
  searchSemanticContent,
} from './semantic-index.ts'

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
  const startedAt = getWorkspaceIndexStatus().semantic.startedAt
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

/** Native gortex/vera semantic search only. */
export async function executeSemanticSearch(
  request: SemanticSearchRequest,
  signal: AbortSignal,
): Promise<SemanticSearchOutcome> {
  const root = getWorkspaceRoot()
  const maxResults = request.maxResults ?? 20

  if (!root || !isSemanticSearchAvailable()) return { status: 'unavailable' }

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
