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

**Seed from public leaderboards, don't self-measure (yet).** Concrete, fetchable
sources (all machine-readable, git/HF-hosted like LiteLLM):

- **Coding / agent edit:** Aider polyglot + edit leaderboards
  (`Aider-AI/aider` → `aider/website/_data/*.yml`; `pass_rate_2` is the headline).
- **HumanEval+/MBPP+:** EvalPlus results.
- **LiveCodeBench:** its leaderboard export.
- **GPQA / MMLU-Pro / IFEval / BBH:** Open LLM Leaderboard v2 (HF dataset;
  archived mid-2025 but data persists).
- **Preference:** LMArena (HF dataset). **SWE-bench:** swebench.com JSON.

**Two caveats confirmed by probing Aider's live data:** (1) _Coverage is sparse
for small local models_ — of our six-model shortlist only Qwen2.5-Coder-32B has a
clean polyglot entry; the rest are absent or only appear at other sizes.
(2) _Published scores are full-precision, not the 4-bit GGUF a user actually
runs_ — so a synced number is directional, an upper bound. Both are exactly why
Copse-specific evals (Phase 4) earn their keep later; the public seed fills what
it can and leaves the rest "—". The sync needs a model-id **alias map** (leaderboard
names like `Qwen2.5-Coder-32B-Instruct` / `ollama/qwen2.5-coder:32b` → our ids).

**Estimating the 4-bit "damage" (caveat 2).** Rather than discard the plentiful
full-precision numbers, adjust them down by a modelled quantization penalty
(`quant-penalty.ts`). The penalty is monotonic — fewer bits per weight → more
damage (steep below ~4 bpw); larger models → less damage — anchored so a 30B
model loses ≈1.2% at Q4_K_M, ≈13% at Q2_K, near-nothing at Q8:

| bpw \ size | 70B  | 32B  | 13B  | 7B   | 3B   |
| ---------- | ---- | ---- | ---- | ---- | ---- |
| Q5_K_M     | 0.2% | 0.3% | 0.5% | 0.6% | 0.9% |
| Q4_K_M     | 0.9% | 1.2% | 1.7% | 2.2% | 3.0% |
| Q3_K_M     | 3.4% | 4.7% | 6.7% | 8.6% | 12%  |
| Q2_K       | 9.3% | 13%  | 18%  | 23%  | 33%  |

An estimated score is stored with `estimated: true` + a `basis` string and must
render _as an estimate_, never as measured. The constants are **tunable**: a
calibration pass refits them from the paired (fp16, quantized) points the
leaderboards do have (Aider's fp16 vs `ollama/*` GGUF entries) and from
llama.cpp's K-quant perplexity/KL-divergence tables. So the layering is:
measured-quantized > estimated-from-full > unknown ("—").

### 3. Defaults: role → recommended model

For each role, a ranked recommendation is computed from the catalog: filter by
the user's hardware budget, then rank by the benchmark(s) that matter for that
role (e.g. `coder` ranks on SWE-bench + Aider Polyglot; `tool-use` on τ-bench;
`judge` on GPQA + determinism). This is the "good defaults" seed — and because
it is derived from data, it updates automatically as the catalog is re-synced.
Every recommendation is overridable, and the UI shows _why_ it was picked.

**Hardware classes (VRAM tiers).** Rather than a single 64 GB reference, the
budget comes from a named class (`HARDWARE_CLASSES`): Compact (≈8 GB) → Standard
(≈16 GB) → Plus (≈24–32 GB) → Workstation (≈48–64 GB) → Server (96 GB+). Each
class caps the model download at ≈65–70% of memory to leave headroom for the KV
cache, OS, and app. `recommendedSetupForClass(id)` sizes the whole role setup to
the machine. _Done in Phase 0/3 code; UI to pick the class is pending._

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
- **Phase 1 — role indirection: _backend done; UI reframed._** `role-models.ts`
  resolves a role assignment (the renderer-writable `roleModels` setting) ahead
  of the legacy per-feature setting, with a fallback so behaviour is unchanged
  until a role is assigned. Wired into the coder / small-tasks / research
  resolution sites. The main-only security settings (`safetyModel`,
  `reviewModel`) are intentionally NOT routed through the renderer-writable bag
  (they stay on the guarded security IPC).

  **UI principle — roles _replace_ the granular controls, they don't stack on
  top.** The indirection only simplifies if the default view shrinks: the
  Settings routing section is now "Local model roles" with the two primary roles
  (Coder, Research) visible and the finer routes (safety, review) collapsed under
  "Advanced routes", so nothing is shown twice. `readValues()` is unchanged, so
  the save flow is untouched. _Note:_ this changes the settings screenshot —
  regenerate `settings-general-model-routing.png` (needs a runnable Electron env;
  couldn't be done in the container this landed from). _Remaining:_ let a role
  feed multiple features (the real payoff), and cloud-capable roles.

- **Phase 2 — picker classifications: _first cut done._** Local models in the
  picker now carry a compact role hint from the catalog (e.g. "qwen/qwen2.5-coder-32b
  — coder · refactor · test-gen") via `localModelRoleHint()`; unknown models render
  bare. Unit-tested in `model-options.test.ts`. _Remaining:_ "recommended for
  &lt;role&gt;" grouping and badges for cloud models.
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
