/**
 * HTTP-layer discipline for GitHub REST reads.
 *
 * GitHub does **not** give `gh` a separate quota. The CLI is a client of the
 * same REST + GraphQL APIs, billed to the signed-in user:
 *
 * - REST `core`: 5,000 requests/hour (authenticated user).
 * - GraphQL: 5,000 points per hour (separate bucket; billed by query cost).
 * - Search: 30 requests/minute (separate, much tighter).
 * - Secondary limits (concurrency / abuse) apply across both APIs.
 *
 * A 304 from a conditional GET (`If-None-Match`) does **not** count against the
 * REST primary limit. Caching ETags and serving SHA-addressed blobs as
 * immutable lets the UI refresh often without spending that budget.
 */
import { safeJsonParse, safeJsonStringify } from '@shared/safe-json.ts'
import { isRecord } from '@shared/unknown-value.ts'

const MAX_ENTRIES = 200
const MAX_BYTES = 32 * 1024 * 1024

export interface GithubHttpResult {
  status: number
  json: unknown
  /** True when the body was served without a network round-trip. */
  fromCache: boolean
}

interface CacheEntry {
  etag: string | undefined
  json: unknown
  status: number
  immutable: boolean
  bytes: number
}

let clock: () => number = Date.now

/** Test hook — drive TTL / retry-window checks without sleeping. */
export function setGitHubHttpCacheClockForTest(next: (() => number) | null): void {
  clock = next ?? Date.now
}

const entries = new Map<string, CacheEntry>()
const getInflight = new Map<string, Promise<GithubHttpResult>>()
let totalBytes = 0

interface RateLimitSnapshot {
  remaining: number
  resetAtMs: number
  limit: number
}

const rateLimits = new Map<string, RateLimitSnapshot>()
let retryUntilMs = 0

/** In-flight GraphQL POSTs, keyed by body. Reset with the HTTP cache in tests. */
export const githubGraphqlInflight = new Map<
  string,
  Promise<{ data: unknown; errorMessage: string | null }>
>()

export function resetGitHubHttpCacheForTest(): void {
  entries.clear()
  getInflight.clear()
  githubGraphqlInflight.clear()
  totalBytes = 0
  rateLimits.clear()
  retryUntilMs = 0
  clock = Date.now
}

function nowMs(): number {
  return clock()
}

function headerOf(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)
  return value && value.length > 0 ? value : undefined
}

function parseIntHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : undefined
}

/** Record `X-RateLimit-*` / `Retry-After` from any GitHub response (REST or GraphQL). */
export function noteGitHubRateLimitHeaders(headers: Headers): void {
  const remaining = parseIntHeader(headers, 'x-ratelimit-remaining')
  const reset = parseIntHeader(headers, 'x-ratelimit-reset')
  const limit = parseIntHeader(headers, 'x-ratelimit-limit')
  const resource = headerOf(headers, 'x-ratelimit-resource') ?? 'core'
  if (remaining !== undefined && reset !== undefined) {
    rateLimits.set(resource, {
      remaining,
      resetAtMs: reset * 1000,
      limit: limit ?? 0,
    })
    if (remaining === 0) retryUntilMs = Math.max(retryUntilMs, reset * 1000)
  }
  if (headers.get('retry-after')) {
    retryUntilMs = Math.max(retryUntilMs, retryAtFromRetryAfter(headers))
  }
}

function retryAtFromRetryAfter(headers: Headers): number {
  const raw = headers.get('retry-after')
  if (!raw) return nowMs() + 60_000
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return nowMs() + seconds * 1000
  const date = Date.parse(raw)
  return Number.isFinite(date) ? date : nowMs() + 60_000
}

export function githubRateLimitRemaining(resource = 'core'): number | null {
  const snap = rateLimits.get(resource)
  if (!snap) return null
  if (nowMs() >= snap.resetAtMs) return snap.limit > 0 ? snap.limit : null
  return snap.remaining
}

export function isGitHubRateLimited(): boolean {
  if (nowMs() < retryUntilMs) return true
  for (const snap of rateLimits.values()) {
    if (snap.remaining === 0 && nowMs() < snap.resetAtMs) return true
  }
  return false
}

function cacheKey(method: string, url: string): string {
  return `${method}:${url}`
}

function sizeOf(json: unknown): number {
  const serialized = safeJsonStringify(json)
  return serialized ? Buffer.byteLength(serialized, 'utf8') : 0
}

function remember(key: string, entry: CacheEntry): void {
  const existing = entries.get(key)
  if (existing) {
    totalBytes -= existing.bytes
    entries.delete(key)
  }
  entries.set(key, entry)
  totalBytes += entry.bytes
  evict()
}

function evict(): void {
  while (entries.size > 1 && (entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES)) {
    const oldestKey = entries.keys().next().value
    if (oldestKey === undefined) break
    const oldest = entries.get(oldestKey)
    if (oldest) totalBytes -= oldest.bytes
    entries.delete(oldestKey)
  }
}

function touch(key: string, entry: CacheEntry): void {
  entries.delete(key)
  entries.set(key, entry)
}

/**
 * Coalesce concurrent identical work so a double-mount or overlapping poll
 * never doubles a round-trip. Typed per-map so REST GETs and GraphQL POSTs
 * don't share a `Promise<unknown>` bucket.
 */
export function coalesceKeyed<T>(
  inflight: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const pending = inflight.get(key)
  if (pending) return pending
  const promise = load().finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

function serveCached(entry: CacheEntry): GithubHttpResult {
  return { status: entry.status, json: entry.json, fromCache: true }
}

/**
 * GET with ETag revalidation, immutable-blob short-circuit, in-flight
 * coalescing, and stale-serve when GitHub has asked us to back off.
 */
export function githubCachedGet(
  url: string,
  headers: Record<string, string>,
  opts: { immutable?: boolean } = {},
): Promise<GithubHttpResult> {
  const key = cacheKey('GET', url)
  return coalesceKeyed(getInflight, key, async () => {
    const cached = entries.get(key)
    if (cached) {
      touch(key, cached)
      if (cached.immutable || opts.immutable) return serveCached(cached)
      if (isGitHubRateLimited()) return serveCached(cached)
    } else if (isGitHubRateLimited()) {
      return {
        status: 429,
        json: { message: 'GitHub API rate limit exceeded. Retry after the reset window.' },
        fromCache: true,
      }
    }

    const requestHeaders: Record<string, string> = { ...headers }
    if (cached?.etag) requestHeaders['If-None-Match'] = cached.etag

    const response = await fetch(url, { method: 'GET', headers: requestHeaders })
    noteGitHubRateLimitHeaders(response.headers)

    if (response.status === 304 && cached) {
      return serveCached(cached)
    }

    const text = await response.text()
    const json: unknown = text ? safeJsonParse(text) : null
    if (response.ok) {
      remember(key, {
        etag: headerOf(response.headers, 'etag'),
        json,
        status: response.status,
        immutable: opts.immutable === true,
        bytes: sizeOf(json),
      })
    }
    if (response.status === 429) {
      retryUntilMs = Math.max(retryUntilMs, retryAtFromRetryAfter(response.headers))
    }
    return { status: response.status, json, fromCache: false }
  })
}

/** True when `ref` is a full commit SHA — contents at that URL never change. */
export function isGitCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref)
}

export function githubHttpErrorMessage(status: number, json: unknown): string {
  if (isRecord(json)) {
    const message = json['message']
    if (typeof message === 'string' && message) return message
  }
  if (status === 429) return 'GitHub API rate limit exceeded. Retry after the reset window.'
  return `GitHub API request failed (HTTP ${String(status)}).`
}
