# Central request-cache spike

## Decision

Centralize the correctness machinery for asynchronous TTL caches, but keep
cache policy at semantic resource boundaries. Do not make an implicitly cached
`fetch` or `runGh` the mandatory gateway.

The shared `AsyncTtlCache<Key, Value>` owns per-key in-flight coalescing,
invalidation-safe ownership of late responses, forced refreshes, fixed or
result-dependent TTLs, completion-time expiry, rejected-load handling, and
bounded LRU retention. Each resource still chooses its key, TTL, size bound,
failure behavior, and mutation invalidation.

## Why transport-level caching is insufficient

- `POST` can be a GraphQL read or a mutation.
- The same URL under a different token is a different security principal.
- Manual refresh must supersede an older request while ordinary duplicates join
  it.
- One successful write can invalidate details, CI state, diffs, and aggregate
  lists with unrelated URLs.
- Streaming, watches, and cancellable long polls must not become TTL entries.

## GitHub layering

GitHub already has two appropriate, complementary layers:

1. `github-read-cache.ts` decorates the semantic backend. It knows which methods
   are reads and which mutations should invalidate related resources. This
   layer now uses `AsyncTtlCache` for its common state machine.
2. `github-http-cache.ts` owns GitHub-specific HTTP behavior: ETags, immutable
   commit-addressed resources, rate-limit headers, stale serving during backoff,
   and response-size bounds. It remains purpose-built.

Raw `gh` or HTTP calls should become explicit semantic backend methods before
they are considered cacheable. HTTP validators reduce bandwidth and quota use;
they do not replace application freshness policy.

## Prototype coverage

The shared primitive is also used for Artificial Analysis, OpenRouter model and
ZDR catalogs, LM Studio models, provider-key validation, Cursor Cloud models,
and plan usage. Tests cover TTL boundaries, completion-time expiry, coalescing,
independent keys, rejection, invalidation races, forced loads, result-dependent
TTLs, and LRU eviction. Existing adapter regression tests continue to cover
credential changes, refresh races, and resource-specific behavior.

## Rollout rule

Use the shared primitive for bounded asynchronous remote reads that would
otherwise implement the same TTL/in-flight/generation state. Leave HTTP
validators, persistent caches, live streams, filesystem state, and renderer
view state on purpose-built mechanisms.
