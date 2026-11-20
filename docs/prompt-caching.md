# Prompt caching

Anthropic prompt caching is a **prefix match**. The cache key is the exact bytes
of the rendered prompt up to each `cache_control` breakpoint, so a single changed
byte at position N invalidates every breakpoint at or after N. Render order is
`tools` → `system` → `messages`, and a request may carry at most **4**
breakpoints.

Cache reads cost roughly a tenth of fresh input; cache writes cost about 1.25×.
On a long agent run the prefix is re-sent on every loop iteration, so whether it
hits or misses is one of the larger levers on cost.

## Where the breakpoints are

`AnthropicProvider` (`packages/llm/src/anthropic-provider.ts`) and Claude models
selected through `createOpenRouterProvider` place up to four:

| Breakpoint                                                                | Caches                                   |
| ------------------------------------------------------------------------- | ---------------------------------------- |
| Last tool definition                                                      | `tools`                                  |
| System prompt block                                                       | `tools` + `system`                       |
| Last cacheable conversation content before trailing operator instructions | `tools` + `system` + conversation prefix |
| Message before a large parallel tool round                                | Previous request's conversation prefix   |

The third is the rolling one: each request marks its own tail, and the next
request matches that entry as a cached prefix. When a round contains at least
10 parallel tool calls, the fourth breakpoint repeats the preceding message's
boundary so a round of more than 20 blocks cannot hide that cached prefix.
OpenRouter uses its documented text-block extension on the leading
system message and conversation tail, plus `cache_control` on the final tool
definition. Tool outputs become text blocks without changing their call IDs.
Images retain their order and detail; if a message ends in an image, the boundary
is on its last nonempty text block. Empty messages and tool-call-only messages
do not get fabricated text. Caller-owned history and tool schemas are not mutated.

This is enabled only for `anthropic/claude-*` selections on the built-in
OpenRouter route. Other models and arbitrary compatible endpoints keep their
existing wire format. An OpenAI-compatible endpoint alone is not evidence that
it accepts Anthropic extensions.

Usage comes back decomposed — `inputTokens` is the sum of fresh, cache-creation,
and cache-read tokens — and `estimate-cost.ts` prices the three buckets
separately, so the Settings usage table reflects real cache savings.

ACP agents report the other way: `PromptResponse.usage.inputTokens` is fresh
input only, with `cachedReadTokens` / `cachedWriteTokens` beside it
(`claude-agent-acp` sums Anthropic `input_tokens`; `codex-acp` subtracts OpenAI's
cached input). `acpTurnUsage` folds the cache counts into `inputTokens` at the
ACP boundary, so every usage record has the same meaning. If an agent's
`totalTokens` is less than input + output + cache, its input already counts the
cache, so it is used as reported.

ACP records written before that normalisation are repaired on read. The repair
only touches a record whose cache tokens are larger than its input, because such
a record can only have been written under the old rule. That makes it
idempotent, and the repaired values persist on the next write.

- **Ledger events** (`parseUsageEvents`, `repairLegacyAcpInputTokens`) each
  describe one call, so the repair is exact: input becomes input + cache.
- **Thread `byModel` entries** (the thread-meta decoder,
  `repairLegacyAcpTotalInputTokens`) are running totals. They can mix old and
  normalised turns, for example when an older Copse build keeps writing to the
  same profile, and the old turns' share of the cache can't be recovered. Input
  is raised to the cache total instead. That never overstates; a wholly legacy
  entry undercounts only by its fresh input.

The rule can't identify an old record whose fresh input was at least as large as
its cache, mostly low-hit `codex-acp` turns. Those records stay as recorded and
undercount input by their cache share, so their cost is understated, never
overstated.

## What breaks the prefix

Anything that changes the rendered bytes ahead of a breakpoint:

- **Editing the system prompt.** It sits at the front, so per-turn text there
  invalidates the entire conversation cache. Capability-aware turn assembly
  avoids that cost where the model has a documented operator channel: routed
  GPT models receive a trailing `developer` message, while the explicit
  `supportsMidConversationSystem` allowlist receives a trailing `system`
  message. Every other selection merges the instruction into `messages[0]`.
  That conservative fallback intentionally loses the prefix cache when steering
  changes, but it works with strict single-system templates such as Qwen under
  LM Studio / MLX and does not weaken the instruction into a pseudo-role user
  message. See `operatorInstructionPlacement` in
  `packages/llm/src/model-catalog.ts`.
- **Changing the tool set or the model.** Tools render at position 0, and caches
  are model-scoped; either change forces a full rebuild.
- **Trimming history.** Dropping the oldest messages is a prefix edit, so
  context pressure and cache cost are coupled.
- **Pinning the plan at a todo boundary.** `compactAtTodoBoundary` keeps the
  plan and touched files in `messages[0]`. It writes them only when it drops
  history, which breaks the prefix anyway, or when an earlier compaction's pin
  needs refreshing. A completion that drops nothing leaves the request
  byte-identical, since the `update_todos` result already carries the plan.

The rule of thumb when adding anything to a request: stable content goes as early
as possible, volatile content goes after the last breakpoint.

## Other providers

Copse uses OpenAI's implicit prefix caching, so
`OpenAIProvider` sends `prompt_cache_key` (the thread id) to keep a
conversation's turns on the same cache. Extra cloud providers receive this hint
on both Chat Completions and Responses; local providers omit it because their
servers may reject unknown fields. Advanced `extraBody` overrides still win.

Chat Completions reads `prompt_tokens_details.cached_tokens` into
`cacheReadTokens`, and OpenRouter's `cache_write_tokens` into
`cacheCreationTokens`. Both are subsets of `prompt_tokens`, not additional input.
The Responses adapter reads `input_tokens_details.cached_tokens` and
`cache_write_tokens` into `cacheReadTokens` and `cacheCreationTokens`. Both are
subsets of `input_tokens`; explicit zero is retained and missing or malformed
cache fields remain absent. Cost estimates use the route's cache rates when available;
missing rates retain the existing input-rate fallback.

Cloud agents report cache tokens beside, not inside, their input count, so the
clients add them in. Claude Managed Agents session usage is cumulative:
`cache_read_input_tokens` plus the per-TTL `cache_creation` buckets (5-minute
and 1-hour, summed into `cacheCreationTokens`) are tracked on the persisted
session and reported as per-turn deltas. Cursor's per-run usage carries
`cacheReadTokens` and `cacheWriteTokens`.

Known gaps are tracked in
[#1286](https://github.com/copse-dev/agent-pane/issues/1286): only the 5-minute
TTL is used, and changing auto-attached rules, invoked skills or terminal state
can still change the system prefix. Stable/dynamic tool partitioning is also
still open. The large-tool-round tests verify the matching request boundaries;
an actual cache read still depends on the upstream provider and TTL.

Wire format and usage fields follow
[OpenRouter's prompt-caching documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
and its [SDK tool-caching contract](https://github.com/OpenRouterTeam/python-sdk/issues/51).

## Verifying

Zero cache reads can mean prefix drift, an undersized prefix, an expired entry,
or a different upstream host. Compare rendered system/tool hashes and the
request interval before attributing a miss to changing instructions.

For development diagnostics, launch with `COPSE_DEBUG_PROMPT_CACHE=1 pnpm run dev`.
Anthropic, Chat Completions and Responses adapters write a
`[prompt-cache-dispatch]` JSON record immediately before each SDK request, then
one `[prompt-cache]` outcome with the same `requestId`. These records contain:

- request ID, transport, model and a hashed comparison scope;
- SHA-256 hashes of the rendered leading system message and tool definitions;
- `systemChanged` and `toolsChanged` relative to the previous dispatched request;
- total input/output tokens and provider-reported cache read/write tokens.
- dispatch time, elapsed duration, and `completed`, `failed`, `cancelled`,
  `interrupted` (the consumer stopped reading), or `retry` (an in-stream fallback);
- a native parent request's `catalog` assembly footprint: hash, advertised/user
  skill counts, total UTF-8 bytes, user-entry UTF-8 bytes, and approximate tokens.

Count dispatch records, not both lifecycle records. `attemptKind: "sdk-dispatch"`
names the boundary: adapter fallbacks and stream retries get separate IDs, but
retries internal to an SDK are not separate HTTP-attempt records. A dispatch
without an outcome is unfinished (for example, a process exit), not a cache miss.
Failed/cancelled/interrupted requests may retain partial usage; never treat it as
a complete bill. No error text is logged. Request hashes are captured after
adapter transformations, including Responses fallback and request overrides.

Catalog construction is silent, including composer previews/context estimates.
The native parent loop and its continuations carry their build's footprint;
auxiliary requests and externally hosted ACP agents do not inherit it.
`catalog: null` means unmeasured, while a measured empty catalog has zero counts.
The footprint describes the assembled catalog before redaction, provider
overrides or server compaction, not exact provider-billed tokens. User-entry bytes
exclude shared guidance and separators. The token estimate is UTF-16 string
length divided by four, rounded up. Full invoked skill bodies and skill activation
frequency are outside this slice. Skill discovery and all prompt text stay unchanged.

Missing usage fields are `null`, distinct from an observed zero. The first
request has `null` change flags. Comparisons survive provider recreation when
the thread key, endpoint, model and transport match. Only hashes for the 128
most recently used scopes are retained; an evicted scope starts fresh. Without
a thread key, comparison is limited to one provider instance. Disabled
diagnostics perform no prompt hashing. No prompt, tool schema, endpoint, thread
ID or API key is written to the diagnostic log. Externally hosted ACP model
requests are not instrumented by this diagnostic.

The persisted usage ledger (`user-data/usage-events/`) also
keeps, per call, the cache read/write tokens and the `hostingProvider` that
OpenRouter reports served the request. Caches are per upstream, so a change of
host between consecutive calls in a thread explains a full miss that no request
byte change does.

To measure, send a synthetic prefix exceeding the model's cache minimum, then
append a follow-up within the TTL. Check that the system/tool hashes stay fixed
and `cacheReadTokens` becomes positive. Change the start of the system prompt
and repeat to test invalidation, then send another unchanged-prefix request to
test reuse. Minimum size, TTL, routing and provider availability still determine
whether a valid request hits; a request-shape unit test alone cannot prove savings.

`pnpm test -- prompt-cache-measurement prompt-caching skill-prompt responses-provider anthropic-provider openai-provider create-provider`
covers the request controls, real SDK serialization/SSE parsing, cache accounting,
cost buckets, cloud/local routing, nonmutation, diagnostic isolation and bounded
history. These deterministic tests use synthetic responses and make no live calls.
