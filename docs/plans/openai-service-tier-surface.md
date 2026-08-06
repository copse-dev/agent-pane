# Surfacing the OpenAI service tier

Design only — the request side ships in #1526, the choice data ships here, the
picker itself is deliberately deferred (see **Sequencing**).

## Why a surface is needed

#1526 adds `service_tier` to first-party OpenAI requests, fed by an
`openAiServiceTier` setting. Nothing writes that setting: it is in
`RENDERER_WRITABLE_SETTING_SCHEMAS` and read in `provider-selection.ts`, but no
UI offers it. As shipped, the tier is unreachable without editing stored
settings by hand — the feature exists end to end except for the one step a user
would take.

## What lands in this change

`SERVICE_TIER_CHOICES` in `packages/llm/src/service-tier.ts`: the tiers worth
offering, each with a label and a one-line description, shaped like ACP's
`AcpConfigChoice` so a single picker can render either.

It is deliberately a **subset** of `SERVICE_TIERS`, because "what the API
accepts" and "what a person should be offered" are different questions:

| Tier              | Offered | Why                                                                                                                                             |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `''` (omit field) | yes     | Standard processing — the default                                                                                                               |
| `flex`            | yes     | Cheaper, slower, may queue under load                                                                                                           |
| `priority`        | yes     | Faster, pricier. OpenAI markets it as "Fast mode"                                                                                               |
| `scale`           | **no**  | Bills against committed reserved throughput on a ≥30-day contract; offering it as a per-chat toggle presents capacity most accounts do not have |
| `auto`, `default` | **no**  | Both mean standard processing, which `''` already expresses by sending no field. Three spellings of one outcome invites "how do these differ?"  |

## The surface

Mirror the ACP config-option picker (#1493): a context menu off the model
picker, one row per selector, current value ticked.

**One structural difference is worth writing down.** ACP options are
_advertised_ — the agent reports `availableConfigOptions` when probed, and
`acpOptionGroupsFor()` renders whatever it is told, so the list self-updates as
agents change. OpenAI advertises nothing. `SERVICE_TIER_CHOICES` is Copse's own
list and must be maintained by hand when OpenAI's tiers change. Anyone reading
the picker code will reasonably assume a discovery call exists; there isn't one.

## Scope question: global or per-chat

The setting is currently global (`openAiServiceTier`). The ACP surface it would
sit beside is per-agent. Worth deciding deliberately rather than by default —
"cheap and slow for this batch job, fast for this one" is per-chat by nature,
which argues for a per-thread override on top of a global default.

## Sequencing

Deferred until #1493 lands: the context-menu and model-picker styling this
would extend live on that branch, so building against it now would either
duplicate the substrate or guess at an API still in review.

## Watch out for, when wiring it up

`ResponsesProvider` accepts a `serviceTier` option that **nothing currently
supplies**, and that is correct today: its only construction site is
`createExtraCloudProvider`, which serves third-party `apiStyle: 'responses'`
providers such as Perplexity. `service_tier` is an OpenAI field — sending it
there would earn a 400.

It becomes live only when first-party OpenAI models are routed through the
Responses API, which is what **#1527** does. Whoever wires that must pass the
tier on the first-party path **only**, and must not let it reach extra providers
sharing the same class.

## Related

- #1526 — the request-side support and the pinned tier enum
- #1543 — the usage ledger prices every turn at the standard tier, so a
  non-default tier is mispriced
- #1493 — the ACP config-option picker this surface would mirror
- #1527 — routes reasoning-capable OpenAI models through the Responses API
