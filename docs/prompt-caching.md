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
selected through `createOpenRouterProvider` place up to three:

| Breakpoint                                                                | Caches                                   |
| ------------------------------------------------------------------------- | ---------------------------------------- |
| Last tool definition                                                      | `tools`                                  |
| System prompt block                                                       | `tools` + `system`                       |
| Last cacheable conversation content before trailing operator instructions | `tools` + `system` + conversation prefix |

The third is the rolling one: each request marks its own tail, and the next
request matches that entry as a cached prefix. The fourth slot is currently
unused. OpenRouter uses its documented text-block extension on the leading
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
The Responses adapter reads `input_tokens_details.cached_tokens` into
`cacheReadTokens`. Cost estimates use the route's cache rates when available;
missing rates retain the existing input-rate fallback.

Known gaps are tracked in
[#1286](https://github.com/copse-dev/agent-pane/issues/1286): the fourth breakpoint
is unused, only the 5-minute TTL is used, and changing auto-attached rules,
invoked skills or terminal state can still change the system prefix. A large
tool round may move the rolling breakpoint beyond the provider's lookback
window; the tests covering twelve parallel results verify request mapping, not
a guaranteed cache hit. Stable/dynamic tool partitioning is also still open.

Wire format and usage fields follow
[OpenRouter's prompt-caching documentation](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
and its [SDK tool-caching contract](https://github.com/OpenRouterTeam/python-sdk/issues/51).

## Verifying

`cache_read_input_tokens` at zero across repeated requests with a supposedly
identical prefix means something upstream is varying. Diff the rendered system
prompt between two turns first — that is where the volatile inputs live
(auto-attached rules, invoked skills, terminal state).

For development diagnostics, launch with `COPSE_DEBUG_PROMPT_CACHE=1 pnpm run dev`.
Completed Anthropic and Chat Completions streams write one `[prompt-cache]` JSON
record to stderr containing:

- request ID, transport, model and a hashed comparison scope;
- SHA-256 hashes of the rendered leading system message and tool definitions;
- `systemChanged` and `toolsChanged` relative to the previous dispatched request;
- total input/output tokens and provider-reported cache read/write tokens.

Missing usage fields are `null`, distinct from an observed zero. The first
request has `null` change flags. Comparisons survive provider recreation when
the thread key, endpoint, model and transport match. Only hashes for the 128
most recently used scopes are retained; an evicted scope starts fresh. Without
a thread key, comparison is limited to one provider instance. Disabled
diagnostics perform no prompt hashing. No prompt, tool schema, endpoint, thread
ID or API key is written to the diagnostic log. Failed/cancelled streams do not
emit a completed-stream record. Responses and externally hosted ACP agents are
not instrumented by this diagnostic.

To measure, send a synthetic prefix exceeding the model's cache minimum, then
append a follow-up within the TTL. Check that the system/tool hashes stay fixed
and `cacheReadTokens` becomes positive. Change the start of the system prompt
and repeat to test invalidation, then send another unchanged-prefix request to
test reuse. Minimum size, TTL, routing and provider availability still determine
whether a valid request hits; a request-shape unit test alone cannot prove savings.

`pnpm test -- prompt-caching anthropic-provider openai-provider create-provider`
covers the request controls, real SDK serialization/SSE parsing, cache accounting,
cost buckets, cloud/local routing, nonmutation, diagnostic isolation and bounded
history. These deterministic tests use synthetic responses and make no live calls.
