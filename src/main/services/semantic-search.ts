import { buildSearchRoutingPromptBlock } from '@shared/agent/search-routing.ts'
import { getWorkspaceRoot } from './workspace.ts'
import {
  formatSemanticSearchResults,
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

export interface SemanticSearchResult {
  text: string
}

/** Native gortex/vera semantic search only. */
export async function executeSemanticSearch(
  request: SemanticSearchRequest,
  signal: AbortSignal,
): Promise<SemanticSearchResult | null> {
  const root = getWorkspaceRoot()
  const maxResults = request.maxResults ?? 20

  if (!root || !isSemanticSearchAvailable()) return null

  const native = await searchSemanticContent({
    query: request.query,
    workspaceRoot: root,
    maxResults,
    signal,
    ...(request.filterPath ? { filterPath: request.filterPath } : {}),
  })
  if (!native) return null

  return {
    text: formatSemanticSearchResults(native.hits, maxResults, native.backend),
  }
}
