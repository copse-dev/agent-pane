# Model roles, defaults, and light evals

Status: **proposal** — scopes an evolution of the existing model-routing and
model-classifier work (see [`model-classifier.md`](./model-classifier.md), issue
[#557](https://github.com/jonathanKingston/agent-pane/issues/557)).

## The core idea: two axes, not one

Today Copse conflates two different questions:

1. **What is a model _good at_?** — a property of the weights, measured by
   benchmarks (SWE-bench, Aider Polyglot, τ-bench, …). Stable across apps.
2. **What _role_ does it play in Copse's pipeline?** — chat, review, safety
   classification, planning, and so on. A property of _our_ product.

Separating these gives us the abstraction the rest of this doc builds on:

- A **capability catalog** describes models objectively (params, quant, context,
  benchmark scores) — sourced, not anecdotal.
- A **role registry** names the jobs Copse needs done. Roles are pre-seeded but
  fully user-editable. Features bind to a _role_, never to a hardcoded model id.
- **Defaults** are the mapping from role → recommended model, derived from the
  capability catalog filtered by the user's hardware budget.

The payoff is exactly what was asked for: a user picks (say) `Qwen2.5-Coder 32B`
as their `coder` role once, and every feature wired to `coder` (chat, refactor,
test-gen) uses it — while they remain free to reassign any individual feature.

## Where we are today

| Concern          | Current state                                                                      | File                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Implicit roles   | `chat` / `smallTasks` / `safety`, hardcoded to LM Studio ids                       | `src/shared/preferred-models.ts`                                                       |
| Routing settings | `localDefaultModel`, `subagentModel`, `safetyModel`, `reviewModel`                 | `src/main/services/storage/settings-writable.ts`, `.../setup/model-routing-section.ts` |
| Cloud catalog    | Pricing + context only, synced weekly from LiteLLM                                 | `src/shared/llm/model-catalog.ts`, `scripts/sync-model-catalog.mts`                    |
| Local models     | Discovered live from the LM Studio server; no metadata                             | `src/main/services/providers/lm-studio-models.ts`                                      |
| Auto-download    | Works via LM Studio native API, for the 3 preferred ids                            | `src/main/services/providers/lm-studio-setup.ts`                                       |
| Classifier       | Experimental `fast`/`balanced`/`frontier` heuristic, Anthropic-only, advisory tool | `src/main/services/providers/model-classifier.ts`                                      |
| Picker           | Grouped by provider only (Cloud, OpenRouter, Local, …)                             | `src/renderer/views/model-options.ts`                                                  |

Everything needed already exists in primitive form. This proposal generalizes
it rather than starting new subsystems.

## Proposal

### 1. A named role registry (the indirection layer)

Promote roles to first-class, pre-seeded-but-editable named slots. This
generalizes `PreferredModelRole` (`'chat' | 'smallTasks' | 'safety'`) into the
full agent pipeline:

| Role               | Job in the pipeline                         | Capability it wants                                  |
| ------------------ | ------------------------------------------- | ---------------------------------------------------- |
| `coder`            | Writing new code (chat default when coding) | Code generation, long context, instruction following |
| `debugger`         | Fixing bugs                                 | Careful iterative reasoning                          |
| `reviewer`         | Post-turn diff review, maintainability      | Consistency, architecture awareness                  |
| `security-auditor` | Finding vulnerabilities                     | Security knowledge, low false negatives              |
| `judge`            | Accept/reject a patch or answer             | Conservative, deterministic, rubric-following        |
| `test-gen`         | Unit / integration / property tests         | Edge-case reasoning                                  |
| `refactor`         | Behaviour-preserving changes                | Semantic preservation                                |
| `planner`          | Break work into tasks                       | Decomposition, prioritisation                        |
| `docs`             | READMEs, comments, API docs                 | Clear writing, technical accuracy                    |
| `research`         | API / framework lookup                      | Broad knowledge, synthesis                           |
| `tool-use`         | Calling tools correctly                     | Structured output, reliable function calling         |
| `small-tasks`      | Titles, lightweight prompts                 | Cheap, fast                                          |
| `safety`           | Shell-command classification (sandbox off)  | Instruct-tuned, deterministic                        |

Each role carries: `id`, `label`, `description`, the capability profile it
prefers, and a default model per backend (local / cloud). Existing settings keys
become aliases onto roles, so nothing breaks:

- `localDefaultModel` → `coder` (local backend)
- `reviewModel` → `reviewer`
- `safetyModel` → `safety`
- `subagentModel` → `research` (exploration subagent)

A one-shot settings migration maps current keys onto role slots; unset roles
inherit from a parent (`coder` → chat default → cloud default), matching the
"auto" fallbacks the routing UI already uses.

### 2. A capability catalog with benchmark columns

Add a **local** model catalog beside the cloud one, curated and research-backed.
Columns mirror the objective axes requested:

- **Sizing:** total params, active params (for MoE), quant, download GB, native
  context window.
- **Benchmarks:** SWE-bench (Verified), HumanEval / HumanEval+, LiveCodeBench,
  Aider Polyglot, MultiPL-E, GPQA, MMLU-Pro, τ-bench (agentic tool use),
  Arena / preference ranking.

Seed shortlist (64 GB M4, 4-bit — a documented reference profile, not a hard
constraint):

| Model                  | Best-fit roles            | Notes                            |
| ---------------------- | ------------------------- | -------------------------------- |
| Qwen3 35B A3B          | coder, reviewer, planner  | Strong all-round local MoE       |
| Qwen2.5-Coder 32B      | coder, refactor, test-gen | Among the strongest local coders |
| DeepSeek-Coder V2 Lite | reviewer, coder           | Efficient alternative            |
| Mistral Small 24B      | tool-use, small-tasks     | Fast, lower ceiling              |
| Gemma 3 12B            | docs, small-tasks         | Good latency                     |
| Phi-4 ~14B             | judge, tool-use           | Efficient reasoning              |

**Sourcing rule (important):** benchmark numbers are _facts_ and must be cited,
not invented. The catalog stores each score with a `source` and `asOf`, and we
add a `sync:local-models` step analogous to `sync:models` (which pulls cloud
pricing from LiteLLM) to refresh them. Until a score is sourced it stays `null`
and the UI shows "—", never a guess. Note the repo already references
forward-looking ids (`qwen/qwen3.6-35b-a3b`, `google/gemma-4-e4b`), so catalog
ids stay data, not literals baked into logic.

### 3. Defaults: role → recommended model

For each role, a ranked recommendation is computed from the catalog: filter by
the user's hardware budget, then rank by the benchmark(s) that matter for that
role (e.g. `coder` ranks on SWE-bench + Aider Polyglot; `tool-use` on τ-bench;
`judge` on GPQA + determinism). This is the "good defaults" seed — and because
it is derived from data, it updates automatically as the catalog is re-synced.
Every recommendation is overridable, and the UI shows _why_ it was picked.

### 4. Classifications in the picker

Extend `model-options.ts` so entries can carry a capability/role badge and,
optionally, group by "recommended for <role>" in addition to the existing
provider grouping. The badge reads from the catalog; models with no metadata
just render as today. This is where the classifications "slot into the dropdown."

### 5. Generalized auto-download

`downloadLmStudioModel` / `getLmStudioDownloadStatus` already drive LM Studio's
native download API with progress polling. Generalize the caller from "the 3
preferred ids" to "any catalog model" and add a "download the recommended set
for role X" action (e.g. one click to fetch a coder + reviewer + safety trio).
The onboarding flow already surfaces `preferredMissing`; this reuses that path.

### 6. Light evals and measured defaults

The harness exists: `test:e2e:agent-eval` (`wdio.eval.conf.ts`) and
`validate:local-agent`. Add small per-role rubric tasks (a handful each) so a
user can benchmark _their_ loaded local models on _their_ hardware and populate a
"measured" column in the catalog — closing the classifier feedback loop the
`model-classifier.md` plan calls for (did the chosen model succeed, or need
escalation?). Keep them light: enough to rank candidates for a role, not a
research benchmark.

## Phasing

- **Phase 0 — data foundation (no behaviour change): _done._** `agent-roles.ts`
  (role registry) and `local-model-catalog.ts` (capability catalog + benchmark
  structure + `recommendLocalModelsForRole`), with tests. Additive; each module
  wired to a consumer so `check:dead-code` stays green.
- **Phase 1 — role indirection: _backend done; UI pending._** `role-models.ts`
  resolves a role assignment (the renderer-writable `roleModels` setting) ahead
  of the legacy per-feature setting, with a fallback so behaviour is unchanged
  until a role is assigned. Wired into the coder / small-tasks / research
  resolution sites. The main-only security settings (`safetyModel`,
  `reviewModel`) are intentionally NOT routed through the renderer-writable bag
  (they stay on the guarded security IPC). _Remaining:_ a settings-UI slice to
  assign roles, and a decision on surfacing the security roles.
- **Phase 2 — picker classifications:** capability/role badges and
  "recommended for" grouping in `model-options.ts`.
- **Phase 3 — generalized download: _foundation done; UI pending._** The
  `lmstudio:download` IPC already accepts any model id, so the backend is already
  general — only the presentation was pinned to the three preferred ids.
  `recommendedLocalSetup()` turns the catalog into a budget-fitting set of core
  roles to download; each `model.id` feeds the existing download IPC.
  _Remaining:_ a "download the recommended set" action in onboarding/settings.
- **Phase 4 — light evals:** per-role rubric tasks, "measured" catalog column,
  feedback into the classifier.

## Answers to the specific questions

- **Improve default model advice** — yes; make defaults data-derived (role →
  catalog) instead of three hardcoded ids, and cite the benchmarks behind each.
- **Auto-download models** — the infrastructure already exists; generalize it
  beyond the preferred trio (Phase 3).
- **More use-cases / classifications in the dropdown** — yes (Phase 2), badges
  and role grouping layered onto the current provider grouping.
- **Pre-seeded default names the user can change, with features consuming those
  names** — yes; this is the role registry (Phase 1) and the central
  recommendation of this doc.
- **Seed with these but reuse via research** — yes; the capability catalog with a
  sourced benchmark sync (`sync:local-models`).
- **Light evals and good defaults** — yes (Phase 4), reusing the existing eval
  harness.

## Risks and notes

- **Never fabricate benchmark numbers.** Store `source` + `asOf`; show "—" until
  sourced; refresh via a sync step.
- **Model ids are data, not literals.** The repo already uses forward-looking
  ids; keep the catalog swappable and user-editable.
- **Guard the dead-code gate.** Land each new module with a real consumer.
- **Hardware budget is a filter, not a wall.** 64 GB M4 / 4-bit is one reference
  profile; the ranking function takes the budget as a parameter.
