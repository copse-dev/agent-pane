# Surfacing the OpenAI service tier

The first-party OpenAI request path reads the global `openAiServiceTier`
setting. Settings → Providers → OpenAI owns its user-facing control, while the
usage ledger records the tier OpenAI actually reports for each response.

## Current OpenAI semantics

OpenAI's current [Chat API reference](https://developers.openai.com/api/reference/resources/chat)
distinguishes the two defaults:

- an omitted `service_tier` behaves as `auto` and follows the OpenAI Project's
  configured tier (normally `default`);
- `default` explicitly requests Standard pricing and performance;
- `flex` requests cheaper processing that can be slower or unavailable;
- `fast` requests Fast mode. The legacy `priority` spelling has the same
  behavior and completed responses can report `priority`;
- `scale` uses contract-managed reserved capacity.

OpenAI's [Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode)
also documents that a Fast request can be served as `default`. The response
tier is therefore authoritative for pricing; the request tier is only the
fallback when a provider omits the response field.

## Offered choices

`SERVICE_TIER_CHOICES` is a maintained product list rather than a discovery
response from OpenAI:

| Stored request value | Label            | Offered | Reason                                               |
| -------------------- | ---------------- | ------- | ---------------------------------------------------- |
| `auto`               | Project default  | yes     | Follows the OpenAI Project setting                   |
| `default`            | Standard         | yes     | Explicit standard pricing and performance            |
| `flex`               | Flex             | yes     | Cheaper, slower, and may queue or fail under load    |
| `fast`               | Fast             | yes     | Faster and more consistent at a per-token premium    |
| `priority`           | Fast             | no      | Preserved legacy spelling; new selections use `fast` |
| `scale`              | retained current | no      | Contract-managed capacity is not a general default   |

Blank values written by older versions still mean omission and display as
Project default. A stored `priority` value displays as Fast. Settings does not
rewrite either spelling until the user selects a different semantic choice.
`scale` and unrecognized stored strings remain visible as retained advanced
values and are likewise left untouched until an offered choice is selected.

## Surface and scope

The picker is a **Global OpenAI service tier** control in Settings → Providers
→ OpenAI, under Request processing. It applies only to first-party OpenAI model
requests. It does not appear in onboarding and never reaches custom providers,
including third-party endpoints that share the Responses transport.

This remains a global default because that is the existing setting contract.
A per-thread override would require separate persistence and is outside this
surface.

## Accounting contract

Both first-party OpenAI transports attach the requested and reported response
tier to usage chunks. `fast` and `priority` normalize into the same priority
pricing bucket. A response of `default` overrides a Fast request and remains in
the standard bucket. Where a model has no complete published tier price, the
usage view retains the existing labelled standard-rate fallback rather than
inventing a premium.

## Related

- #1526 — first-party OpenAI request support
- #1543 / #2759 — tier-aware usage accounting and pricing
- #1590 — user-facing provider capability surface
- #1527 — first-party reasoning models on the Responses transport
