import type { ToolExecuteResult } from '@shared/types'
import { expectRecord } from '@shared/unknown-value.ts'

/**
 * Result cache for the read-only "explore the workspace" tools (search_code,
 * search_codebase, semantic_search, find_files, list_dir). These tools shell
 * out to rg/ig/gortex or walk the filesystem on every call; agents routinely
 * repeat an identical search a few turns later (re-checking a grep after
 * reading the files it found, re-deriving context established earlier in the
 * conversation). Serving the identical (tool, args) pair back avoids the
 * redundant subprocess/filesystem work.
 *
 * Scoped per **thread**, not per workspace. A thread's execution root is fixed
 * for its lifetime (the worktree checkout in worktree mode, the project root in
 * shared mode), so a thread-keyed bucket is implicitly worktree-correct — two
 * threads on separate worktrees of the same project never share entries. Across
 * threads the reuse is worth little and the staleness exposure is real (branch
 * switches, pulls, external tooling between conversations), so buckets are
 * bounded by {@link MAX_THREADS} and simply age out.
 *
 * Freshness within a thread comes from two directions: a mutating tool call
 * drops that thread's bucket (see tool-registry), and filesystem changes under
 * the execution root drop every bucket rooted there (see
 * execution-root-watcher). A root with no watcher coverage must not be cached
 * at all — callers check that before storing.
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

const MAX_ENTRIES_PER_THREAD = 200
const MAX_THREADS = 8

interface ThreadCache {
  /** Execution root this thread's results were produced against. */
  root: string
  entries: Map<string, ToolExecuteResult>
}

// threadId -> bucket. Insertion-ordered, refreshed on access, so the oldest
// untouched thread is evicted first.
const cachesByThread = new Map<string, ThreadCache>()

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

/** Move a bucket to the most-recently-used end of the eviction order. */
function touch(threadId: string, bucket: ThreadCache): void {
  cachesByThread.delete(threadId)
  cachesByThread.set(threadId, bucket)
}

export function getCachedToolResult(
  threadId: string,
  root: string,
  toolName: string,
  args: unknown,
): ToolExecuteResult | undefined {
  const bucket = cachesByThread.get(threadId)
  // A thread's root is fixed for its lifetime, so a mismatch means the bucket
  // predates a re-resolved checkout; treat it as stale rather than serve it.
  if (!bucket || bucket.root !== root) return undefined
  const hit = bucket.entries.get(cacheKey(toolName, args))
  if (hit !== undefined) touch(threadId, bucket)
  return hit
}

export function setCachedToolResult(
  threadId: string,
  root: string,
  toolName: string,
  args: unknown,
  result: ToolExecuteResult,
): void {
  let bucket = cachesByThread.get(threadId)
  if (!bucket || bucket.root !== root) {
    bucket = { root, entries: new Map() }
    cachesByThread.set(threadId, bucket)
  }
  const key = cacheKey(toolName, args)
  bucket.entries.delete(key)
  bucket.entries.set(key, result)
  if (bucket.entries.size > MAX_ENTRIES_PER_THREAD) {
    const oldest = bucket.entries.keys().next().value
    if (oldest !== undefined) bucket.entries.delete(oldest)
  }
  touch(threadId, bucket)
  while (cachesByThread.size > MAX_THREADS) {
    const oldestThread = cachesByThread.keys().next().value
    if (oldestThread === undefined) break
    cachesByThread.delete(oldestThread)
  }
}

/** Drop one thread's cached results — call once a tool may have written to its root. */
export function invalidateThreadSearchCache(threadId: string): void {
  cachesByThread.delete(threadId)
}

/**
 * Drop every thread's results that were produced at or under `changedRoot`.
 * Called from the execution-root watcher, so an edit made outside the agent's
 * own tool calls (the user's editor, a terminal command) can't leave a stale
 * result cached. A worktree root is never under the project root, hence the
 * exact-or-descendant test rather than plain equality.
 */
export function invalidateSearchResultCacheUnderRoot(changedRoot: string): void {
  const prefix = changedRoot.endsWith('/') ? changedRoot : `${changedRoot}/`
  for (const [threadId, bucket] of cachesByThread) {
    if (bucket.root === changedRoot || bucket.root.startsWith(prefix)) {
      cachesByThread.delete(threadId)
    }
  }
}

/** Test hook. */
export function clearAllSearchResultCachesForTest(): void {
  cachesByThread.clear()
}
