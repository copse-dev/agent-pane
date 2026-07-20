# Provider data retention and training policies

Copse sends prompts, conversation context, tool results, and file contents to
whichever model provider the user selects
([privacy-data-flow.md](privacy-data-flow.md)). What happens to that data next
is governed by each provider's own policy. This document records what each
supported provider retains and whether it trains on API inputs **by default**,
the request-level protections Copse enables, and how the in-app metadata is
maintained.

The machine-readable version of this table lives in
`packages/llm/src/data-policies.ts` and drives the privacy badges in
Settings → Providers and the annotations in the model picker.

Last verified: **2026-07-19** (each claim against the provider's own
documentation; see sources).

## What Copse sends by default

- **OpenRouter — privacy routing on by default, on two independent axes**
  (retention and training are separate policy dimensions in OpenRouter's
  routing, controlled by two toggles in Settings → Providers → OpenRouter):
  - `provider: { zdr: true }` (`openRouterZdrOnly`, default ON) restricts
    routing to zero-data-retention endpoints. While on, the model picker only
    lists models with a ZDR endpoint (from OpenRouter's auto-updated
    `/endpoints/zdr` feed; the picker filter fails open, request-level
    enforcement does not), and a model with no compliant endpoint fails with
    a deterministic routing error — surfaced immediately (not retried) with a
    pointer to these toggles.
  - `data_collection: "deny"` (`openRouterAllowTraining`, default OFF)
    excludes providers that store or train on inputs. It stays active even
    when the ZDR toggle is turned off, so relaxing retention (to reach
    retained-but-not-trained endpoints) never silently re-admits trainers;
    only the explicit allow-training opt-in drops it (needed for most
    `:free` models).

  OpenRouter itself stores no prompts unless logging is explicitly opted
  into. The per-request `zdr` parameter ORs with any account-level ZDR
  settings, so Copse's default achieves maximum enforcement without
  dashboard configuration.

- **OpenAI — `store: false` on every direct request.** OpenAI stores Chat
  Completions/Responses output for 30 days by default on new accounts
  ("application state"); Copse opts each request out. This does not affect
  OpenAI's separate abuse-monitoring retention (below).

## Per-provider defaults

"Trains by default" means inputs/outputs may be used to train or improve
models under the tier Copse's preset advertises, before any opt-out.

| Provider (slug)                     | Retains prompts by default             | Trains by default                   | Stricter option                                                                         |
| ----------------------------------- | -------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| Anthropic (`anthropic`)             | ~30 days                               | No                                  | ZDR via enterprise/sales arrangement                                                    |
| OpenAI (`openai`)                   | ≤30 days (abuse monitoring)            | No                                  | ZDR / modified abuse monitoring, OpenAI approval required                               |
| OpenRouter (`openrouter`)           | No (with Copse's default ZDR routing)  | No (with `data_collection: "deny"`) | Already default; account-level ZDR toggles at openrouter.ai/settings/privacy            |
| Mistral (`mistral`)                 | 30 rolling days                        | **Yes** on Free/Pro plans (opt-out) | Opt out in Admin Console → Privacy; ZDR is Scale-plan only                              |
| Google Gemini (`gemini`)            | Yes (55 days on paid tier)             | **Yes** on the free tier            | Paid tier stops product-improvement use; per-project ZDR program by request             |
| DeepSeek (`deepseek`)               | Yes — indefinitely, stored in the PRC  | **Yes** (service improvement)       | Opt-out by request (privacy@deepseek.com); no documented ZDR                            |
| Hugging Face router (`huggingface`) | HF: no bodies (30-day debug logs only) | **Partner-dependent**               | None — HF explicitly delegates to each routed partner's policy                          |
| Perplexity Agent API (`perplexity`) | **Unclear for Agent API**              | **Unclear for Agent API**           | General API FAQ says no query retention/training; dedicated ZDR page names Sonar only   |
| Together AI (`together`)            | No (org privacy setting)               | No (opt-in)                         | Confirm org setting answers "No" to storing prompts                                     |
| Groq (`groq`)                       | Yes (≤30-day troubleshooting logs)     | No                                  | Console Data Controls → Zero Data Retention toggle                                      |
| Fireworks AI (`fireworks`)          | No (volatile memory only)              | No (opt-in)                         | ZDR is the default                                                                      |
| xAI (custom prefill)                | 30 days, encrypted                     | No                                  | Team Settings → Zero Data Retention (responses carry an `x-zero-data-retention` header) |
| Local (LM Studio, Ollama, …)        | n/a — data stays on the machine        | n/a                                 | n/a                                                                                     |

Notes:

- **Hugging Face** is the least determinate provider: HF states it does not
  store request/response bodies and keeps only ~30-day debug logs, but the
  router fans requests out to third-party partners (Together, Fireworks,
  Novita, SambaNova, …) that each apply their **own** data policy, and HF makes
  no ZDR guarantee on their behalf. Copse pins each HF model to a specific
  partner (`org/model:provider`), so the responsible party is at least visible
  in the model id.
- **Perplexity Agent API** is intentionally marked unknown rather than ZDR.
  Perplexity's FAQ says API query data is not retained or trained on, but its
  dedicated zero-retention documentation explicitly scopes the promise to the
  Sonar API. Until Perplexity names Agent API or third-party routed models in
  that guarantee, Copse does not show a zero-retention badge for this preset.
- **Anthropic ZDR caveat**: under a strict Anthropic ZDR arrangement, models
  that require 30-day retention are unavailable; that trade-off is between the
  customer and Anthropic, not something Copse configures.
- An unrecognized provider (user-added custom endpoint) gets a "Data policy
  unknown" badge — unknown is surfaced, never treated as safe.

## Keeping this data fresh

There is no single maintained registry of AI-provider retention policies.
What exists:

- **OpenRouter's public feeds** (the only live machine-readable source found):
  - `GET https://openrouter.ai/api/v1/endpoints/zdr` — the authoritative,
    automatically updated list of zero-data-retention endpoints.
  - `GET https://openrouter.ai/api/v1/providers` — per-provider
    privacy-policy/ToS URLs and locations (no structured retention flags).
  - `GET https://openrouter.ai/api/frontend/v1/all-providers` — undocumented
    but the source of OpenRouter's own provider-retention table; exposes
    `dataPolicy: { training, retainsPrompts, retentionDays, … }` per provider.
    Unversioned; treat as best-effort.
- **LiteLLM / models.dev** carry pricing/capability data only — no retention
  fields — so the existing model-catalog sync cannot supply this.

Because the first-party providers (Anthropic, OpenAI, Google, Mistral,
DeepSeek, Hugging Face) publish policy changes in prose, the table in
`data-policies.ts` is hand-maintained against primary sources, with
`DATA_POLICIES_LAST_VERIFIED` recording the audit date. Re-verify it on the
same cadence as the model-catalog sync (see
`.github/workflows/sync-model-catalog.yml`) or when adding a provider. If
automated drift-detection is added later, the right shape is the existing
sync-script pattern: fetch OpenRouter's feeds, diff against the table, and
open a PR for human review — not silent auto-merge, since a wrong "safe" label
is worse than a stale one.

## Sources

- OpenRouter ZDR & provider routing: <https://openrouter.ai/docs/guides/features/zdr>,
  <https://openrouter.ai/docs/guides/routing/provider-selection>
- Hugging Face Inference Providers security: <https://huggingface.co/docs/inference-providers/security>
- Anthropic API data retention: <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention>
- OpenAI data controls: <https://platform.openai.com/docs/guides/your-data>,
  <https://openai.com/enterprise-privacy/>
- Google Gemini API terms & ZDR: <https://ai.google.dev/gemini-api/terms>,
  <https://ai.google.dev/gemini-api/docs/zdr>
- Mistral privacy & ZDR: <https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training>,
  <https://help.mistral.ai/en/articles/347612-can-i-activate-zero-data-retention-zdr>
- DeepSeek privacy policy: <https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html>
- Perplexity API FAQ and privacy page: <https://docs.perplexity.ai/docs/resources/faq>,
  <https://docs.perplexity.ai/docs/resources/privacy-security>
- Together AI: <https://docs.together.ai/docs/privacy-and-security>
- Groq: <https://console.groq.com/docs/your-data>
- Fireworks AI: <https://docs.fireworks.ai/guides/security_compliance/data_handling>
- xAI: <https://docs.x.ai/developers/faq/security>
- Ollama FAQ (local): <https://docs.ollama.com/faq>
