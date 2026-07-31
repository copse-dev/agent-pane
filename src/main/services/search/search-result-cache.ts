import type { ToolExecuteResult } from '@shared/types'
import { expectRecord } from '@shared/unknown-value.ts'

/**
 * Result cache for the read-only "explore the workspace" tools (search_code,
 * search_codebase, semantic_search, find_files, list_dir). These tools shell
 * out to rg/ig/gortex or walk the filesystem on every call; agents routinely
 * repeat an identical search a few turns later (re-checking a grep after
 * reading the files it found, a subagent re-deriving context the parent
 * already has, etc.). Caching the exact (tool, args) pair per workspace root
 * avoids redundant filesystem/process work as long as nothing has written to
 * that root since.
 *
 * Deliberately NOT applied to read_file: re-reading a specific path is a
 * targeted lookup, not exploration, and paging/line-range semantics make
 * staleness more visible if missed.
 */
export const CACHEABLE_SEARCH_TOOLS = new Set<string>([
  'search_code',
  'search_codebase',
  'semantic_search',
  'find_files',
  'list_dir',
])

const MAX_ENTRIES_PER_ROOT = 200

// root -> (cache key -> result), insertion-ordered per root for FIFO eviction.
const cachesByRoot = new Map<string, Map<string, ToolExecuteResult>>()

/** JSON.stringify with object keys sorted recursively, so arg key order never busts the cache. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(expectRecord(value))
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

function cacheKey(toolName: string, args: unknown): string {
  return `${toolName}:${stableStringify(args)}`
}

export function getCachedToolResult(
  root: string,
  toolName: string,
  args: unknown,
): ToolExecuteResult | undefined {
  return cachesByRoot.get(root)?.get(cacheKey(toolName, args))
}

export function setCachedToolResult(
  root: string,
  toolName: string,
  args: unknown,
  result: ToolExecuteResult,
): void {
  let entries = cachesByRoot.get(root)
  if (!entries) {
    entries = new Map()
    cachesByRoot.set(root, entries)
  }
  const key = cacheKey(toolName, args)
  entries.delete(key)
  entries.set(key, result)
  if (entries.size > MAX_ENTRIES_PER_ROOT) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
}

/** Drop every cached search result for `root` — call once a tool may have changed files under it. */
export function invalidateSearchResultCache(root: string): void {
  cachesByRoot.delete(root)
}

/** Test hook. */
export function clearAllSearchResultCachesForTest(): void {
  cachesByRoot.clear()
}
