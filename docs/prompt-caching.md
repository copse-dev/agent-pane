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

`AnthropicProvider` (`packages/llm/src/anthropic-provider.ts`) places three:

| Breakpoint                            | Caches                                   |
| ------------------------------------- | ---------------------------------------- |
| Last tool definition                  | `tools`                                  |
| System prompt block                   | `tools` + `system`                       |
| Tail of the last conversation message | `tools` + `system` + conversation prefix |

The third is the rolling one: each request marks its own tail, and the next
request matches that entry as a cached prefix. The fourth slot is currently
unused.

Usage comes back decomposed — `inputTokens` is the sum of fresh, cache-creation,
and cache-read tokens — and `estimate-cost.ts` prices the three buckets
separately, so the Settings usage table reflects real cache savings.

## What breaks the prefix

Anything that changes the rendered bytes ahead of a breakpoint:

- **Editing the system prompt.** It sits at the front, so per-turn text there
  invalidates the entire conversation cache. Turn steering and hook-injected
  context therefore ride a **trailing `role: 'system'` message** instead of being
  folded into `messages[0]`. Models that don't accept a mid-conversation system
  turn get the same content as a `<system-reminder>` block in a trailing user
  message — same caching profile, less authority. See
  `supportsMidConversationSystem` in `packages/llm/src/model-catalog.ts`; note
  that the default cloud model (`claude-sonnet-4-6`) is on the fallback path.
- **Changing the tool set or the model.** Tools render at position 0, and caches
  are model-scoped; either change forces a full rebuild.
- **Trimming history.** Dropping the oldest messages is a prefix edit, so
  context pressure and cache cost are coupled.

The rule of thumb when adding anything to a request: stable content goes as early
as possible, volatile content goes after the last breakpoint.

## Other providers

OpenAI's prefix caching is implicit — there are no breakpoints to place, so
`OpenAIProvider` sends `prompt_cache_key` (the thread id) to keep a
conversation's turns on the same cache. The Responses adapter reads
`input_tokens_details.cached_tokens` back into `cacheReadTokens`.

Known gaps are tracked in
[#1286](https://github.com/copse-dev/agent-pane/issues/1286): Anthropic models
served through OpenRouter get no `cache_control` blocks at all, the Chat
Completions path does not read `prompt_tokens_details.cached_tokens` (so those
cache reads are billed at the full input rate in the ledger), and only the
5-minute TTL is used.

## Verifying

`cache_read_input_tokens` at zero across repeated requests with a supposedly
identical prefix means something upstream is varying. Diff the rendered system
prompt between two turns first — that is where the volatile inputs live
(auto-attached rules, invoked skills, terminal state).
