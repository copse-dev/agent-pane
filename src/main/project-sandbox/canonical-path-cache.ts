import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Short-lived memo for the `realpathSync.native` calls that canonicalize
 * sandbox-rule paths.
 *
 * Every sandboxed command rebuilds its whole filesystem rule set from scratch
 * (`spawn.ts` calls {@link workspaceSandboxOverlay} per spawn), and each rule
 * path is canonicalized so seatbelt/bwrap rules match the kernel's view of the
 * filesystem. A DevTools trace of a running agent turn recorded 56 sandboxed
 * spawns in 5.5s — ~10/second — each re-resolving the same workspace root,
 * `homedir()`, and sibling worktree roots. `realpath` is a blocking syscall on
 * the Electron main thread, so that redundancy shows up directly as IPC stalls.
 *
 * The memo is deliberately time-bounded rather than permanent. Canonicalization
 * is a filesystem fact, and these rules are a security boundary: a cached answer
 * that outlives a symlink change would emit rules naming the old target. A short
 * TTL collapses a burst of tool calls into one syscall per path while keeping any
 * staleness window far shorter than the work it saves.
 */
const CACHE_TTL_MS = 2_000

/** Bounds memory when a session touches many projects or worktrees. */
const MAX_ENTRIES = 256

export interface CanonicalPathCacheOptions {
  readonly ttlMs?: number
  readonly maxEntries?: number
  /** Injected so tests can advance time without sleeping. */
  readonly now?: () => number
  /** Injected so tests can drive resolution without touching the filesystem. */
  readonly resolvePath?: (path: string) => string
}

/**
 * Resolve a path to its canonical, symlink-free form, memoized for {@link CACHE_TTL_MS}.
 *
 * Falls back to the plain resolved path when canonicalization fails (the path may
 * not exist yet), matching the uncached behaviour it replaces. Failures are cached
 * the same way as successes so a missing path costs one syscall per window too.
 */
export function createCanonicalPathCache(
  options: CanonicalPathCacheOptions = {},
): (path: string) => string {
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const now = options.now ?? Date.now
  const resolvePath =
    options.resolvePath ??
    ((path: string): string => {
      try {
        return realpathSync.native(path)
      } catch {
        return path
      }
    })
  const entries = new Map<string, { readonly value: string; readonly expiresAt: number }>()

  return (path: string): string => {
    const resolved = resolve(path)
    const at = now()
    const hit = entries.get(resolved)
    if (hit && hit.expiresAt > at) return hit.value

    const value = resolvePath(resolved)
    // Re-insert at the tail so insertion order stays resolution order: the head
    // is then always the entry resolved longest ago, and therefore the entry
    // closest to expiring anyway. A hit does not reorder — it costs no syscall,
    // so there is nothing to amortise by keeping it.
    entries.delete(resolved)
    entries.set(resolved, { value, expiresAt: at + ttlMs })
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next()
      if (!oldest.done) entries.delete(oldest.value)
    }
    return value
  }
}

/** Process-wide cache used by the sandbox rule builders. */
export const canonicalizePathCached = createCanonicalPathCache()
