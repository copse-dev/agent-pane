import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolExecuteResult } from '@shared/types'
import { expectRecord, isRecord } from '@shared/unknown-value.ts'

/**
 * Result cache for read-only tools whose answer is a pure function of the
 * workspace on disk. Currently the "explore the workspace" set (search_code,
 * search_codebase, semantic_search, find_files, list_dir): each shells out to
 * rg/ig/gortex or walks the filesystem on every call, and agents routinely
 * repeat an identical call a few turns later (re-checking a grep after reading
 * the files it found, re-deriving context established earlier).
 *
 * Nothing here is search-specific — entries are keyed by tool name and
 * arguments — so other deterministic read-only tools can opt in by joining
 * {@link CACHEABLE_TOOLS}. The bar for joining is that the tool reads the
 * workspace and nothing else: no clock, no network, no user state. A tool whose
 * result depends on anything the invalidation signals below can't observe will
 * go stale silently.
 *
 * ## Identity
 *
 * An entry belongs to a (thread, root, branch) triple:
 *
 * - **thread** — a thread's execution root is fixed for its lifetime (the
 *   worktree checkout in worktree mode, the project root in shared mode), so a
 *   thread-keyed bucket is implicitly worktree-correct: two threads on separate
 *   worktrees of one project never share entries. Across threads the reuse is
 *   worth little and the staleness exposure is real (branch switches, pulls,
 *   external tooling between conversations), so buckets are bounded by
 *   {@link MAX_THREADS} and age out.
 * - **root** — belt-and-braces against a re-resolved checkout mid-thread.
 * - **branch** — a checkout rewrites the working tree, so results from one
 *   branch must never be served on another. The watcher also catches this via
 *   `.git/HEAD`, but only for a normal checkout; a linked worktree keeps HEAD in
 *   the common git dir, out of watch range, and there the per-turn branch from
 *   the thread execution context is the reliable signal. The two cover each
 *   other's blind spot.
 *
 * ## Freshness
 *
 * Three signals, and anything not covered by them is not cached at all:
 * a mutating tool call drops the thread's bucket (see tool-registry); a
 * filesystem change drops entries whose scope contains it (below); and a root
 * with no watcher coverage is never written in the first place.
 *
 * Deliberately NOT applied to read_file: re-reading a specific path is a
 * targeted lookup, not exploration, and paging/line-range semantics make
 * staleness more visible if missed.
 */
export const CACHEABLE_TOOLS = new Set<string>([
  'search_code',
  'search_codebase',
  'semantic_search',
  'find_files',
  'list_dir',
])

const MAX_ENTRIES_PER_THREAD = 200
const MAX_THREADS = 8

/** The (thread, root, branch) triple an entry belongs to. */
export interface ToolCacheIdentity {
  threadId: string
  root: string
  branch: string | null
}

interface CacheEntry {
  result: ToolExecuteResult
  /** Absolute directory this result was derived from; edits outside it can't affect it. */
  scope: string
}

interface ThreadCache {
  root: string
  branch: string | null
  entries: Map<string, CacheEntry>
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

/** True when `candidate` is `dir` itself or sits underneath it. */
function isAtOrUnder(candidate: string, dir: string): boolean {
  return candidate === dir || candidate.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)
}

/**
 * Directory a call's result was derived from, so an edit elsewhere leaves it
 * alone. These tools spell their subtree as a `path` argument; anything without
 * one (or pointing outside the root, e.g. the read-only chat store) falls back
 * to the root, which is the conservative answer — invalidated by any change.
 *
 * Deliberately ignores `file_glob`: a glob narrows which files match, not which
 * directories were walked, so treating it as scope would miss real edits.
 */
export function resolveToolResultScope(root: string, args: unknown): string {
  if (!isRecord(args)) return root
  const path = args['path']
  if (typeof path !== 'string' || path === '' || path === '.') return root
  const absolutePath = resolve(root, path)
  const rel = relative(root, absolutePath)
  if (rel.startsWith('..') || isAbsolute(rel)) return root
  return absolutePath
}

/** Move a bucket to the most-recently-used end of the eviction order. */
function touch(threadId: string, bucket: ThreadCache): void {
  cachesByThread.delete(threadId)
  cachesByThread.set(threadId, bucket)
}

/** The thread's bucket, or undefined when it is absent or belongs to a different root/branch. */
function liveBucket(identity: ToolCacheIdentity): ThreadCache | undefined {
  const bucket = cachesByThread.get(identity.threadId)
  if (!bucket) return undefined
  if (bucket.root !== identity.root || bucket.branch !== identity.branch) return undefined
  return bucket
}

export function getCachedToolResult(
  identity: ToolCacheIdentity,
  toolName: string,
  args: unknown,
): ToolExecuteResult | undefined {
  const bucket = liveBucket(identity)
  if (!bucket) return undefined
  const hit = bucket.entries.get(cacheKey(toolName, args))
  if (hit) touch(identity.threadId, bucket)
  return hit?.result
}

export function setCachedToolResult(
  identity: ToolCacheIdentity,
  toolName: string,
  args: unknown,
  result: ToolExecuteResult,
): void {
  let bucket = liveBucket(identity)
  if (!bucket) {
    // Replaces any bucket held for a stale root/branch on the same thread.
    bucket = { root: identity.root, branch: identity.branch, entries: new Map() }
    cachesByThread.set(identity.threadId, bucket)
  }
  const key = cacheKey(toolName, args)
  bucket.entries.delete(key)
  bucket.entries.set(key, { result, scope: resolveToolResultScope(identity.root, args) })
  if (bucket.entries.size > MAX_ENTRIES_PER_THREAD) {
    const oldest = bucket.entries.keys().next().value
    if (oldest !== undefined) bucket.entries.delete(oldest)
  }
  touch(identity.threadId, bucket)
  while (cachesByThread.size > MAX_THREADS) {
    const oldestThread = cachesByThread.keys().next().value
    if (oldestThread === undefined) break
    cachesByThread.delete(oldestThread)
  }
}

/** Drop one thread's cached results — call once a tool may have written to its root. */
export function invalidateThreadToolCache(threadId: string): void {
  cachesByThread.delete(threadId)
}

/**
 * Drop results invalidated by a filesystem change, so an edit made outside the
 * agent's own tool calls (the user's editor, a terminal command) can't leave a
 * stale result cached.
 *
 * `changedPath` is the absolute path that changed; entries survive unless it
 * falls inside their scope, so editing `src/` leaves a `docs/`-scoped search
 * alone. Pass null when the change can't be located (fs.watch omits the
 * filename, or a branch pointer moved) and every entry under the root goes.
 *
 * A worktree root is never under the project root, hence the at-or-under test
 * rather than plain equality on the root.
 */
export function invalidateToolResultCacheForChange(
  changedRoot: string,
  changedPath: string | null,
): void {
  for (const [threadId, bucket] of cachesByThread) {
    if (!isAtOrUnder(bucket.root, changedRoot)) continue
    if (changedPath === null) {
      cachesByThread.delete(threadId)
      continue
    }
    for (const [key, entry] of bucket.entries) {
      if (isAtOrUnder(changedPath, entry.scope)) bucket.entries.delete(key)
    }
    if (bucket.entries.size === 0) cachesByThread.delete(threadId)
  }
}

/** Execution roots with at least one live bucket — the only roots worth watching. */
export function cachedExecutionRoots(): Set<string> {
  return new Set(Array.from(cachesByThread.values(), (bucket) => bucket.root))
}

/** Test hook. */
export function clearAllToolResultCachesForTest(): void {
  cachesByThread.clear()
}
