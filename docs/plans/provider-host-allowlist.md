# Hostname sandboxing for LLM model provider egress

**Status:** Design proposal (not yet implemented). Tracks issue #438.

Restrict outbound LLM-provider network traffic to known / approved hostnames.
Today there is no hostname allowlist on model API calls, and a user-added custom
provider accepts an arbitrary `baseUrl` that is sent verbatim to the OpenAI SDK
client, the validate-key fetch, and the fetch-models fetch.

Keep this separate from the Hugging Face pricing work on branch
`claude/nice-keller-ih6bnc`.

## 1. Current state

### Where provider traffic originates

LLM provider calls run in the **main process** through SDK clients, **outside**
the macOS project sandbox (`src/main/project-sandbox/`, which only isolates a
subprocess's filesystem + auto-run command network). Three call paths reach a
provider host:

1. **Streaming completions** — `createProvider` / `createExtraCloudProvider`
   (`src/shared/llm/create-provider.ts`) build an `OpenAIProvider`
   (`src/shared/llm/openai-provider.ts`) or `AnthropicProvider`
   (`src/shared/llm/anthropic-provider.ts`), each of which constructs an SDK
   client with a `baseURL`. `createExtraCloudProvider` is reached via
   `src/main/services/provider-selection.ts`.
2. **Key validation** — `validateExtraProviderApiKey`
   (`src/main/services/validate-api-key.ts`) does `fetch(\`${baseUrl}/models\`)`.
3. **Model listing** — `fetchOpenAiCompatibleModels`
   (`src/main/services/provider-models.ts`) does `fetch(\`${base}/models\`)`.

### What hosts are reachable today

| Source                                            | Host                    | Locked?                                                                                    |
| ------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| Anthropic (`anthropic-provider.ts`)               | `api.anthropic.com`     | hardcoded                                                                                  |
| OpenAI (`openai-provider.ts`)                     | `api.openai.com`        | hardcoded                                                                                  |
| OpenRouter (`create-provider.ts`)                 | `openrouter.ai`         | hardcoded                                                                                  |
| Cursor (`validate-api-key.ts`)                    | `api.cursor.com`        | hardcoded                                                                                  |
| Mistral / Gemini / DeepSeek / HuggingFace presets | preset `baseUrl`        | locked by `mergeBuiltin` in `extra-providers.ts` (label/baseUrl/envVar stay on the preset) |
| **User-added custom provider**                    | **arbitrary `baseUrl`** | **not locked**                                                                             |

The only open surface is the **user-added custom OpenAI-compatible provider**.
`customToProvider` (`extra-providers.ts`) stores whatever `baseUrl` the user
typed; `storedExtraProviderSchema` (`src/main/services/settings-schema.ts`)
validates it as `z.string().max(2048).optional()` — **length only, no URL or
host check**. That `baseUrl` then flows unchecked into all three call paths
above.

Re HuggingFace: the HF router fans out to upstream providers **server-side**, so
Copse only ever connects to `router.huggingface.co`; a `:together`-style suffix
is a routing hint and adds **no** outbound hosts. No special handling needed.

### The existing web-origin policy (separate today)

`src/main/services/web-origin-policy.ts` + `browser-origin-policy.ts` already
implement a host allowlist for the agent's **web tools and built-in browser**:

- Default allowlist `DEFAULT_WEB_ALLOWED_ORIGINS` (`src/shared/web-origins.ts`):
  loopback on any port + DuckDuckGo.
- `assertLowRiskHost` rejects private / link-local IPs and single-label / mDNS
  names; `parseOriginPattern` supports `*.host` and `:*` port wildcards.
- A soft "approve this origin" flow in `permission-gate.ts`
  (`promptWebOrigin` → `requestApproval`): "Always allow" persists into
  `webAllowedOrigins`; a one-time approval calls `grantWebOriginForNextFetch`
  (an in-memory `temporaryAllowedOrigins` set).
- Gated by `webAllowUserApproval` — when off, an un-allowlisted origin is a hard
  deny instead of a prompt.

This policy is **not** applied to provider traffic. The reuse question is the
core design decision below.

## 2. Threat model

**Mitigated.** Exfiltration of an API key (or chat content) to an
attacker-controlled host via a **malicious or tampered custom-provider
`baseUrl`**. The realistic vectors:

- Settings sync / import or a hand-edited settings store seeds a custom provider
  whose `baseUrl` points at `evil.example`. The next completion, key
  validation, or model fetch ships the configured key (as `Authorization:
Bearer`) and prompt/transcript to that host.
- A social-engineered "add this provider" with a look-alike host.

The mitigation is a host check at every seam where a custom `baseUrl` becomes a
network call, plus an explicit approval step before a never-seen host is ever
contacted.

**Not mitigated** (out of scope, state explicitly):

- A **legitimately approved** host that is itself malicious or later
  compromised — approval is trust transfer, not a guarantee.
- Built-in preset providers (Anthropic/OpenAI/etc.) — already hardcoded, trusted
  by definition.
- DNS rebinding / a benign hostname resolving to an internal IP. `baseUrl` is a
  hostname allowlist, not an IP allowlist; `assertLowRiskHost` blocks
  _literal_ private IPs and single-label names but not a public name that
  resolves inward. Pinning resolved IPs is a possible later hardening, noted but
  not proposed here.
- Exfiltration through the agent's own tools (covered by the separate web-origin
  policy) or through auto-run subprocess network (covered by the sandbox).

## 3. Recommended design

### 3.1 Policy model

A **two-tier** model mirroring the web-origin policy:

1. **Hard allowlist (implicit, always trusted):** the hosts of all built-in
   sources — `api.anthropic.com`, `api.openai.com`, `openrouter.ai`,
   `api.cursor.com`, and every `BUILTIN_EXTRA_PROVIDERS` preset `baseUrl` host.
   These are derived from code, never user-editable, and never prompt. Loopback
   hosts (`localhost`, `127.0.0.1`, `::1`) are auto-allowed so LM Studio / vLLM
   keep working with **no** prompt (consistent with `web-origin-policy`'s
   loopback default and `isLoopbackHostname`).
2. **Soft allowlist (user-approved custom hosts):** the host of a user-added
   custom provider must be **approved once** before any call. Approval is
   surfaced at the point the provider is saved (see 3.3) and persisted.

**Default posture:** a custom-provider host that is neither built-in, loopback,
nor previously approved is **blocked**, with an approval prompt when interactive
(governed by a new `providerAllowUserApproval` toggle, default **on**, mirroring
`webAllowUserApproval`). With the toggle off, an un-approved host is a hard deny
— no prompt. This is strictly additive: existing presets and loopback are
unaffected, so no current working configuration breaks. The only behaviour
change is that adding/using a custom cloud provider now requires a one-time
approval.

`assertLowRiskHost` (already exported from `web-origin-policy.ts`) is reused to
reject private/link-local IPs and single-label/mDNS names for **non-loopback**
custom hosts — a custom cloud provider should never legitimately resolve to a
literal private IP.

### 3.2 Enforcement seam

A single new module, `src/shared/llm/provider-host-policy.ts`, exporting:

```ts
// The set of always-allowed hosts, derived from code (built-ins + loopback).
export function builtinProviderHosts(): Set<string>
// Throws if `baseUrl`'s host is not allowed by (built-ins ∪ loopback ∪ approved).
export function assertProviderHostAllowed(baseUrl: string, approved: readonly string[]): void
export function isProviderHostAllowed(baseUrl: string, approved: readonly string[]): boolean
// Normalize a baseUrl to its host key for storage/compare (reuse normalizeHostname).
export function providerHostKey(baseUrl: string): string
```

It lives in `src/shared/llm/` (next to `create-provider.ts`) and is pure — the
approved-host list is passed in by the caller so the shared module stays free of
main-process settings imports. Host normalization (`normalizeHostname`) and the
low-risk-host check are imported from / shared with `web-origin-policy.ts`.

The check is installed at **three** seams — the central one plus the two fetch
paths — because each can be reached independently:

1. **`createExtraCloudProvider`** (`create-provider.ts`) — the one place every
   custom-provider completion is built. Call `assertProviderHostAllowed` before
   constructing the `OpenAIProvider`. This is the primary runtime gate. (The
   built-in `createProvider` / `createOpenRouterProvider` / local paths hit only
   hardcoded or loopback hosts, so they pass trivially; no change needed beyond
   the shared host set listing them.)
2. **`validateExtraProviderApiKey`** (`validate-api-key.ts`) — guard before the
   `/models` fetch so key validation can't be used to probe / leak to a
   disallowed host.
3. **`fetchOpenAiCompatibleModels`** (`provider-models.ts`) — guard before the
   `/models` fetch for the same reason.

Plus a **save-time** validation (3.3) so a bad host is rejected (or routed to
approval) before it is ever persisted.

### 3.3 Persistence + UX

**Storage.** A new main-only setting `approvedProviderHosts: string[]`
registered in `settings-schema.ts` (schema:
`z.array(z.string().max(256)).max(256)`), normalized to lowercase host keys.
Mirrors how `webAllowedOrigins` is stored, but a plain host list (no
scheme/port/path patterns) since provider base URLs are always full origins and
we only care about the host.

**Save-time approval.** `saveExtraProvider`
(`src/main/services/extra-providers-store.ts`) is the natural choke point for a
custom provider. On save of a **custom** (non-builtin) provider:

- Parse + validate the `baseUrl`: require `https:` (or `http:` only for
  loopback) and reject embedded credentials — exactly the
  `validateRemoteAgentBaseUrl` rule already in `web-origin-policy.ts`, which
  should be generalized/reused rather than duplicated.
- If the host is built-in/loopback/already-approved → save as today.
- Otherwise, the IPC handler prompts via `requestApproval` (same
  `permission-gate.ts` flow as `promptWebOrigin`): "Allow model provider host
  `evil.example`? Your API key and prompts will be sent here." On "Always allow",
  add the host key to `approvedProviderHosts`, then save; on deny, reject the
  save with a clear error and do not persist.

**Settings UX.** Surface approved provider hosts in Settings next to the custom
providers / API-keys section (the renderer view is
`src/renderer/views/setup/custom-providers-section.ts`), with a remove control
per host — symmetric with the web-allowed-origins management. Add the
`providerAllowUserApproval` toggle alongside the existing
`webAllowUserApproval` / `browserAllowUserApproval` toggles.

### 3.4 Relationship to the web-origin policy

**Share the primitives, keep the policy lists separate.** Provider egress and
agent web-tool egress have different trust semantics — the web allowlist defaults
to DuckDuckGo for _search_, which is irrelevant to provider calls, and a host you
trust to answer a search is not necessarily one you trust with your API key.
Conflating them would let a host approved for one purpose receive the other's
secrets.

Concretely:

- **Reuse** (extract shared helpers, don't fork): `normalizeHostname`,
  `isLoopbackHostname`, `assertLowRiskHost`, the `validateRemoteAgentBaseUrl`
  https/loopback/credentials rule, and the `requestApproval` prompt plumbing.
  These already live in `web-origin-policy.ts` / `permission-gate.ts`; promote
  the genuinely shared ones into a small shared host-util if needed so both
  policies import one copy.
- **Separate:** the stored allowlist (`approvedProviderHosts` vs
  `webAllowedOrigins`), the approval toggle, the in-memory one-time grant set,
  and the prompt copy (provider prompt names the API-key risk explicitly).

### 3.5 Failure UX (blocked mid-run)

- **At save / add time** — the most common case — the approval prompt or a hard
  validation error stops a bad host from ever being stored. The user sees an
  inline error in the add-provider form.
- **At completion time** (host was approved then later removed, or settings were
  synced after the model was selected): `assertProviderHostAllowed` throws in
  `createExtraCloudProvider`. The thrown `Error` should carry an actionable
  message — `Provider host "evil.example" is not approved. Re-add it in Settings
→ Providers.` — surfaced through the same chat/run error path that already
  renders provider-not-configured errors from `createProvider` (it throws plain
  `Error`s today, e.g. "Anthropic is not configured…"). No partial request is
  sent: the check runs before the SDK client is constructed.
- **At validate / fetch-models time:** the existing `{ ok: false, error }`
  result shape carries the block reason straight back to the form.

## 4. Files to touch (implementation checklist)

| File                                                   | Change                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/llm/provider-host-policy.ts` _(new)_       | `assertProviderHostAllowed` / `isProviderHostAllowed` / `builtinProviderHosts` / `providerHostKey`; pure, approved-list passed in.                                     |
| `src/shared/llm/create-provider.ts`                    | Gate `createExtraCloudProvider` on the host policy before building the client.                                                                                         |
| `src/main/services/validate-api-key.ts`                | Gate `validateExtraProviderApiKey` before the `/models` fetch.                                                                                                         |
| `src/main/services/provider-models.ts`                 | Gate `fetchOpenAiCompatibleModels` before the `/models` fetch.                                                                                                         |
| `src/main/services/extra-providers-store.ts`           | In `saveExtraProvider`, validate + approval-gate a custom provider's host; read approved hosts from settings to pass into the policy at the runtime seams.             |
| `src/main/services/settings-schema.ts`                 | Add `approvedProviderHosts` + `providerAllowUserApproval` schemas.                                                                                                     |
| `src/main/services/permission-gate.ts`                 | `promptProviderHost` (mirror `promptWebOrigin`); persist on "always allow".                                                                                            |
| `src/main/services/web-origin-policy.ts`               | Export / extract the shared host helpers (`normalizeHostname`, low-risk-host, the base-URL rule) for reuse without forking.                                            |
| `src/renderer/views/setup/custom-providers-section.ts` | Surface approved hosts (list + remove) and the approval toggle.                                                                                                        |
| IPC (settings handlers)                                | Thread the approval prompt through the `saveExtraProvider` IPC; expose approved-host add/remove.                                                                       |
| Tests                                                  | `provider-host-policy.test.ts`; extend `create-provider.test.ts`, `validate-api-key`/`provider-models` tests, and `extra-providers-store.test.ts` for the gated paths. |

## 5. Open questions

1. **One-time vs always-only approval.** The web policy offers both "always" and
   a one-shot grant. For a custom provider you intend to keep using, a one-shot
   grant is awkward (every completion re-prompts). Recommend **always-allow only**
   at save time; drop the one-time grant for providers.
2. **Editing a preset's host.** `mergeBuiltin` currently locks preset base URLs.
   Keep that — presets stay non-editable, so they never need approval. Confirm no
   path lets a stored override smuggle a `baseUrl` onto a built-in slug (today
   `mergeBuiltin` ignores `override.baseUrl`; the new save-time check should also
   reject a `baseUrl` on a built-in slug defensively).
3. **IP pinning / DNS rebinding** — deliberately out of scope (see threat
   model); revisit if provider egress ever needs to match the browser's
   resolved-IP guarantees.
