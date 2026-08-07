# Forced planning for weaker models

Copse ships an opt-in first-party pack, **`copse.forced-planning`**, that makes a
plan mandatory when the model running a turn measures below a capability
threshold.

The premise: a frontier model can hold a multi-step task in its head and recover
from a wrong turn. A smaller — or heavily quantized — model drifts, forgets the
second half of the request, and declares victory early. An externalised plan is
the cheapest known fix: it gives the weaker model a checklist to re-read every
step instead of relying on recall. So rather than asking the user to remember to
say "make a plan first", the pack decides from the _measured_ capability of
whatever model is selected.

Turn it on in **Settings → Packs → Forced planning**. It ships disabled.

## What it does

On every turn start, while the pack is enabled:

1. Resolve the capability of the model about to run
   (`resolveModelIntellect`, [`packages/llm/src/intellect-lookup.ts`](../packages/llm/src/intellect-lookup.ts)).
2. If it measures below the threshold for its scale, inject a **plan-first**
   steering block into that turn's system message:
   - `update_todos` when the host reports that tool in the turn's tool list —
     3–7 concrete steps, one `in_progress` at a time, no "finished" while items
     are open. The plan shows up in the usual plan panel.
   - a **written numbered plan** in the reply when it does not (the `copse.todos`
     pack is disabled, or read-only mode dropped the tool). The plan is still
     mandatory; it just has nowhere structured to live.
3. Otherwise abstain — the turn is assembled exactly as it would have been
   without the pack.

It also abstains when the request is under 40 characters (greetings, "continue",
one-line follow-ups) and when a plan from a prior turn is still open — the
todo-pin hook already carries that one, and re-forcing a plan on top of it is
noise.

The model is never told _why_ it was asked to plan. A score is not actionable for
it and risks it narrating its own limitations to the user; the measured reason is
recorded on the decision instead.

## Two scales, two thresholds

Capability resolves on one of two deliberately incomparable rulers, and the pack
holds a threshold for each:

| Scale                                              | Typical range                                                    | Setting                       | Default |
| -------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------- | ------- |
| Artificial Analysis Intelligence Index (canonical) | frontier ≈ 55–60; Claude Haiku 4.5 = 24; local 4-bit weights low | `canonicalIntellectThreshold` | 40      |
| Copse composite (`composite-intellect.ts`)         | weighted mean of 0–100 pass-rate benchmarks                      | `compositeIntellectThreshold` | 60      |

A local weight resolves to its **quant-adjusted** canonical score when one is
sourced — the model as it actually runs on-device, not the full-precision
number — and falls back to the composite only when Artificial Analysis has never
measured it but enough per-benchmark axes are sourced to publish a mean. The two
numbers are never converted into one another: a composite of 45 is not a
canonical 45, and comparing them on one axis would silently mis-threshold every
local model. See the scale warning in
[`packages/llm/src/composite-intellect.ts`](../packages/llm/src/composite-intellect.ts).

A third setting, `unmeasuredModels`, decides what happens when neither scale has
a number for the model:

- `skip` (default) — leave the turn untouched. An unmeasured model is as likely
  to be a brand-new frontier release as an obscure small one, and changing every
  prompt on a guess is worse than doing nothing.
- `plan` — assume it needs one. Suits a workspace that runs mostly unlisted local
  weights, where "unmeasured" reliably means "small".

## How it is wired

| Piece                                                                                                         | Role                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`packages/llm/src/intellect-lookup.ts`](../packages/llm/src/intellect-lookup.ts)                             | Scale-tagged capability lookup for a selected model id (cloud, OpenRouter, ACP, local). |
| [`packages/agent/src/forced-planning.ts`](../packages/agent/src/forced-planning.ts)                           | The pure policy: thresholds, gates, and the two steering texts.                         |
| `forcedPlanningHook` in [`turn-start-hooks.ts`](../packages/agent/src/hooks/turn-start-hooks.ts)              | The `turnStart` hook — supplies turn facts and reads the pack's own settings.           |
| [`packages/agent/src/plugins/forced-planning-pack.ts`](../packages/agent/src/plugins/forced-planning-pack.ts) | The manifest: the hook contribution, the settings schema, namespaced storage.           |

Two small platform additions came with it, both documented in
[`docs/plans/hooks-and-feature-packs.md`](plans/hooks-and-feature-packs.md) (P12):

- `TurnStartPayload` carries `model` and `toolNames` — facts the fire site
  already had in hand, so a steering hook can condition on which model is running
  and never name a tool the turn filtered out. `turnStart` has no dialect
  marshaller, so no external hook wire contract changed.
- `HookContext.resolvePackSetting(packId, key)` is the service-injection seam a
  first-party pack hook reads its own configuration through — the same shape as
  `resolveGithubRepoSlug`, and what keeps `packages/agent` free of any import of
  the host's pack service or `electron-store`.

Disabling the pack drops the hook from the assembly pipeline in one atomic flag
flip, restoring a byte-identical system prompt.

## Related

- [`docs/packs.md`](packs.md) — the pack manifest, registry, and lifecycle
- [`docs/hooks.md`](hooks.md) — the hook registry the pack's hook registers through
