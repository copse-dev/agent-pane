# TypeSafe.ai as a bounded decision engine

Status: **Proposed** — evaluation and integration plan only. No TypeSafe dependency,
credential, network request, feature pack, or product behavior is implemented by this
document.

Reviewed against `origin/main` at `dfc15e48a` and TypeSafe's public documentation on
2026-09-19.

## Recommendation

Evaluate TypeSafe System One as an optional, cloud-hosted **decision engine** for narrow
classification and triage inside Copse. Do not treat it as another coding model or agent.
The first production candidate is Roadmap metadata: replace two independent prose
completions for category and complexity with one typed, multi-question request, then use
the returned probability distributions to accept confident answers and fall back safely
when the service is uncertain or unavailable.

Ship any integration as a disabled-by-default experimental first-party pack,
`copse.typesafe-decisions`. A user must enable the pack, save a TypeSafe API key, and
acknowledge that the selected text leaves the device before Copse sends a request. The
existing behavior remains byte-for-byte unchanged when the pack is disabled, has no key,
or cannot obtain a usable answer.

TypeSafe must never participate in shell permissions, auto-approval, sandbox policy,
credential access, or a claim that agent work is correct or complete. Repository text is
untrusted input, and TypeSafe documents that adversarial state can steer Jev.

## Why this fits Copse

System One exposes three bounded answer types: yes/no (`noul`), enumerated choice, and an
ordered score. It evaluates independent questions over shared state in parallel and
returns probabilities instead of generated prose. That is a good fit for a few existing
Copse seams:

- [`roadmap-category.ts`](../../src/main/services/roadmap-category.ts) and
  [`roadmap-complexity.ts`](../../src/main/services/roadmap-complexity.ts) currently make
  separate small-task model calls and recover one word from each response. They already
  run detached, skip unusable verdicts, re-read after awaiting, and protect manual
  category choices. That gives the first experiment a bounded blast radius.
- [`model-classifier.ts`](../../src/main/services/providers/model-classifier.ts) is an
  advisory heuristic scaffold that explicitly anticipates a learned or model-judged
  follow-up. A typed task-demand judgment could become one input to that router after the
  Roadmap pilot proves calibration.
- [`post-turn-orchestration.ts`](../../src/main/services/post-turn-orchestration.ts) runs
  a comparatively expensive generative review cycle. A later typed triage step could
  decide when that reviewer is clearly unnecessary, but cannot replace the reviewer or
  verify correctness.

This is not a fit for titles, summaries, plans, code, remediation instructions, or any
other generated output. Those stay on Copse's existing generative provider paths.

## Vendor snapshot and assumptions

The details below are inputs to the evaluation, not permanent facts. Re-check them before
each implementation or model-upgrade PR.

| Property         | Reviewed value                                                                                                                              | Consequence for Copse                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| API              | `POST https://api.typesafe.ai/v1/systemone`                                                                                                 | Main-process-only client; do not expose the key or raw response to the renderer.                                               |
| Production model | `jev-1.13.0`; moving alias `jev-latest`                                                                                                     | Explore with the alias, then pin the evaluated version in product code.                                                        |
| Inputs           | JSON `state` plus typed `questions`                                                                                                         | Send the minimum state needed for each decision, not a transcript or repository dump.                                          |
| Outputs          | Typed answers, probabilities/confidence, usage                                                                                              | Runtime-decode every response; thresholds are Copse-owned and evaluation-derived.                                              |
| Context          | 64k request; 32k state plus longest question                                                                                                | The initial integration keeps the existing 2,000-character Roadmap prompt cap.                                                 |
| Price            | $0.042 per million input tokens; output tokens free                                                                                         | Record actual usage locally and show it under a dedicated usage source.                                                        |
| Service limits   | 250k tokens/s and 1,200 requests/min                                                                                                        | More than sufficient for the pilot, but bounded retry/backoff is still required.                                               |
| Data policy      | No training/fine-tuning on customer input; retention is not given as a fixed default window; US hosted; ZDR offered to enterprise customers | Treat ordinary accounts as prompt-retaining, disclose external processing, and never imply that enabling the pack enables ZDR. |
| Known Jev limits | Literal interpretation, weak math/counting/date precision, indirection, irrelevant context, and adversarial state                           | Keep arithmetic/control flow in code, make criteria explicit, minimize state, and exclude security authority.                  |

The official JavaScript SDK currently requires Node 20 or newer, so it is compatible with
Copse's Node 24 floor. Use it behind a narrow app-owned adapter for cancellation,
timeouts, and retry support, but treat its returned value as untrusted. Copse's Zod schema
is the runtime contract even when SDK TypeScript types compile.

## Binding decisions for this integration

1. **Classification only.** TypeSafe supplies bounded judgments; Copse code owns control
   flow, side effects, deterministic rules, thresholds, and fallbacks.
2. **Roadmap metadata first.** Category and complexity are the only production candidate
   in the first rollout. Model routing and review triage wait for separate graduation
   gates.
3. **One experimental pack.** `copse.typesafe-decisions` follows the registry, lifecycle,
   settings, storage, and atomic disable semantics in
   [`hooks-and-feature-packs.md`](./hooks-and-feature-packs.md). Do not add a parallel
   top-level `typesafeEnabled` setting.
4. **Explicit cloud opt-in.** Fresh profiles have the pack disabled. No request is made
   until a key resolves from encrypted settings or `TYPESAFE_API_KEY`, the relevant pack
   mode is enabled, and the outbound-data disclosure has been accepted.
5. **Main process owns secrets and egress.** The renderer may learn only whether a key is
   present. It never receives the key, request authorization header, prompt payload, or
   raw vendor response.
6. **Pinned model and versioned questions.** Production uses an exact model id and an
   app-owned question-set version such as `roadmap-metadata@1`. Changing either requires
   rerunning the held-out evaluation before release.
7. **Runtime validation is mandatory.** Decode the entire response with a strict Zod
   schema, including question ids, answer types, option keys, finite probability ranges,
   probability sums within tolerance, legend entries, and usage counts. A malformed or
   partial response is a miss, never a coerced verdict.
8. **Per-answer abstention.** Category and complexity may graduate independently. A
   low-confidence answer falls back for that field only; one good answer is not discarded
   because the other is uncertain.
9. **Operational fallback preserves current behavior.** Disablement, missing credentials,
   aborts, timeouts, `401`, `422`, exhausted `429`/`529` retries, network errors, and
   invalid responses route to the existing small-task classifier. If it also fails, leave
   the field unstamped as today. Saving or importing a Roadmap item never waits for this.
10. **Human choices win.** Preserve the current stale-prompt check and
    `categoryManual` behavior. A late cloud answer cannot overwrite newer text or a
    user's category.
11. **No hidden telemetry.** Evaluation artifacts and shadow decisions remain local.
    Do not upload prompts, corrections, labels, or success signals to Copse or TypeSafe
    beyond the explicit inference request.
12. **No security authority.** A TypeSafe result cannot allow a shell command, widen a
    sandbox, expose a credential, suppress an approval, mark a review clean, or assert
    task completion. This is a permanent constraint, not a phase-one limitation.

## First use case: combined Roadmap metadata

Add one orchestration seam conceptually shaped like:

```ts
interface RoadmapMetadataDecision {
  category: Decision<RoadmapCategory>
  complexity: Decision<RoadmapComplexity>
  model: string
  questionSet: string
  inputTokens: number
}

type Decision<T> =
  | { kind: 'accepted'; value: T; confidence: number }
  | { kind: 'abstained'; reason: 'low-confidence' | 'invalid' | 'unavailable' }
```

The wire request contains only `{ prompt: redactSecrets(prompt).slice(0, 2_000) }` and
two independent questions:

| Question     | Initial primitive                   | Criteria                                                 | Stored result                                                                                                                  |
| ------------ | ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `category`   | Choice                              | Existing `bug`, `feature`, and `project` definitions     | Highest-probability valid option above the category threshold                                                                  |
| `complexity` | Score and Choice compete in Phase 0 | Existing ordered `low`, `medium`, and `high` definitions | Highest-probability valid level above its threshold; never round or otherwise treat the fractional score as an exact magnitude |

The evaluation chooses whether complexity ships as Score or Choice. Score represents the
ordinal relationship, but the vendor warns against treating its weighted value as
numerically precise; Copse stores an enum, so classification accuracy and calibration on
the actual enum are what matter.

The orchestration replaces the two independent launch sites with one detached metadata
operation. It applies each accepted value only after re-reading the note and confirming
the prompt still matches. During shadow mode, the existing small-task result remains
authoritative and TypeSafe output is recorded only as local evaluation metadata.

Do not persist confidence or vendor provenance in Roadmap frontmatter in the first slice.
Those fields are user-facing durable product data, while thresholds and model versions
will change during calibration. Keep bounded evaluation records in an explicitly local,
rotating diagnostic store containing a prompt digest, question-set/model versions,
answer distributions, latency, fallback reason, and baseline verdict — never the raw
prompt. Enforce a bounded retention window and provide an explicit clear action;
disabling the pack stops collection without silently rewriting its namespaced storage.

## Evaluation before product integration

Phase 0 produces evidence, not product behavior.

### Corpus

Build a versioned fixture set of 300–500 reviewed examples:

- public Copse issues and public issue text, stripped of author/account metadata;
- synthetic boundary cases covering bug versus feature, feature versus project, and all
  adjacent complexity pairs;
- short, long, negated, ambiguous, irrelevant-detail, quoted-instruction, and prompt-
  injection cases;
- at least two independent labels for a 20% stratified slice, with disagreements
  adjudicated before looking at model output; and
- a fixed 50/25/25 question-development/calibration/held-out split declared before the run.
  Threshold tuning may use calibration data, never the held-out split.

Private user Roadmap content is not needed to start. If opted-in dogfood data is later
used, keep it on the device and export only an explicitly reviewed, redacted fixture.

### Compared arms

Run the same corpus against:

1. the current configured small-task prompt/parser baseline;
2. a deterministic majority/heuristic baseline;
3. TypeSafe category Choice plus complexity Choice;
4. TypeSafe category Choice plus complexity Score; and
5. repeated TypeSafe trials for stability and probability calibration.

Record model ids, question-set version, raw probabilities, accepted/abstained outcome,
input tokens, wall-clock latency, retry count, HTTP failure class, and estimated USD. Do
not make the harness depend on the Electron renderer.

### Metrics

- category macro-F1 and per-class precision/recall;
- complexity macro-F1, mean absolute ordinal error, and quadratic weighted kappa;
- Brier score and expected calibration error for both outputs;
- selective accuracy and coverage as the confidence threshold rises;
- repeated-run agreement, especially for accepted high-confidence answers;
- p50/p95 latency, failure/fallback rate, token count, and cost per 1,000 items; and
- performance on the adversarial, negation, ambiguity, and irrelevant-context slices.

### Roadmap graduation gate

The pilot can enter shadow mode only when the held-out report shows all of the following:

- neither label's macro-F1 is more than 2 percentage points below the current baseline;
- accepted decisions are at least 95% accurate for each label at useful coverage of at
  least 60%;
- complexity ordinal error is no worse than the baseline;
- high-confidence repeated-run agreement is at least 99%;
- p95 end-to-end latency from Copse's target regions is below 1 second;
- non-authentication request failure is below 1% in the measured run; and
- TypeSafe provides a material reason to add a cloud dependency: at least a 5-point
  macro-F1 gain on one label, or at least a 40% reduction in both latency and estimated
  classification cost without an accuracy regression.

If no threshold satisfies accuracy and coverage, stop. Do not hide a failed calibration
behind a broad fallback that sends almost every item through two providers.

## Architecture and product surface

### First-party pack

The pack manifest should declare `stability: 'experimental'`, pack-scoped mode settings,
namespaced diagnostic storage, and a level-3 Settings contribution for credentials and
privacy copy. Suggested settings:

- `roadmapMode`: `off | shadow | active`, default `off`;
- later, only after their own gates: `modelRoutingMode` and `reviewTriageMode`, each
  default `off`.

The pack itself is disabled on fresh profiles. Disabling it immediately stops new
requests and drops all runtime contributions while leaving only encrypted credentials
and user-controlled diagnostic history, consistent with the platform's storage rules.
Do not create an agent-visible tool: these decisions are host orchestration, not something
the coding model should invoke opportunistically.

The Settings detail follows the direct Parallel Search precedent:

- masked key presence plus save/clear actions backed by Copse's encrypted key store;
- live model/account validation via a bounded `GET /v1/models` probe;
- clear text that Roadmap prompts leave the device, requests may be billable, ordinary
  retention is not a published fixed window, service hosting is in the US, and ZDR is an
  enterprise account/contract property;
- an outbound-origin approval before the first call to `api.typesafe.ai`; and
- a local “Clear decision diagnostics” action if shadow records exist.

Any Settings or Roadmap UI change needs the focused browser/Electron spec and screenshot
required by `AGENTS.md`. Shadow mode itself should be invisible in the Roadmap pane; a
diagnostic/status row belongs in the pack detail, not on every item.

### Main-process client

Introduce a small TypeSafe adapter owned by the main process. Responsibilities:

- resolve the encrypted key or `TYPESAFE_API_KEY` without sending either to the renderer;
- pin the evaluated model and send a versioned, minimal question set;
- reuse [`redact-secrets.ts`](../../packages/llm/src/redact-secrets.ts) at the outbound
  boundary;
- apply a bounded timeout, AbortSignal, and at most one retry for retryable `429`/`529`
  responses within the overall deadline;
- strictly decode the response and normalize it into app-owned decision types;
- record `typesafe-decisions` usage separately from `agent`, `small-tasks`,
  `safety-classifier`, and `advisor`; and
- return typed failure/abstention reasons without throwing into detached callers.

The official SDK stays behind this adapter so replacing it with direct `fetch`, responding
to an SDK regression, or moving to a compatible service does not leak vendor types across
Copse. Pin the SDK version and include its license/integrity review in the implementation
PR.

### Privacy catalog and cost reporting

TypeSafe is a decision service, not a selectable chat provider, so it should not appear in
the model picker. It still needs a machine-readable data-policy entry using the same
vocabulary as [`provider-data-policies.md`](../provider-data-policies.md): prompts retained
by default (duration unspecified), no training, ZDR by contract, and US hosting called
out in prose. Settings must not show a “Zero data retention” badge for an ordinary key.

Add the pinned Jev input price to app-owned pricing metadata and a dedicated usage source.
The usage ledger stores token counts and local cost calculation, not prompt contents or
answer distributions. A vendor pricing change is a catalog update; it must not silently
rewrite historical usage.

## Delivery phases and PR boundaries

| Phase                         | Scope                                                                                                                             | Exit condition                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Offline evaluation         | Versioned fixtures, reproducible runner, current baseline, Choice-versus-Score experiment, calibration report                     | Roadmap graduation gate passes and the report commits the selected primitive, thresholds, pinned model, and question-set version; otherwise stop    |
| 1. Client and pack foundation | Experimental pack, encrypted key UI, privacy disclosure, model probe, strict adapter, usage source, fake-fetch tests              | No calls while disabled/missing key; malformed/error/cancel paths fall back; focused Settings visual evidence passes                                |
| 2. Roadmap shadow             | Combined classifier runs beside existing classifiers for explicitly opted-in users; local bounded diagnostics only                | Minimum 500 opted-in dogfood decisions, no private corpus export, measured accuracy/latency/fallback still meets the gate                           |
| 3. Roadmap active             | High-confidence per-field answers become authoritative; low confidence uses existing fallback; manual/stale protections unchanged | Rollback test proves disabling the pack restores the prior path; Roadmap unit/import tests and required visual evidence pass                        |
| 4. Advisory model routing     | TypeSafe estimates bounded demand signals; Copse maps them to configured, reachable models and keeps the user override            | Separate A/B shows equal-or-better completion quality with lower cost/latency; no automatic routing before this gate                                |
| 5. Review triage              | Typed signals decide whether to run the existing reviewer, with uncertainty/risk always reviewing                                 | Seeded high-severity recall is 100%, overall recall at least 98%, and reviewer calls fall materially; TypeSafe never emits a “clean” verdict itself |

Phases 4 and 5 are optional consumers, not commitments. Each needs its own question set,
corpus, calibration, setting, and rollback evidence. Roadmap thresholds cannot be reused
for a different primitive or domain.

## Later candidate: model routing

TypeSafe may eventually replace only the judgment portion of the heuristic classifier.
Ask atomic questions such as whether the task is mechanical, cross-cutting, ambiguous,
security-sensitive, or likely to need tools. Copse code then combines those probabilities
with deterministic facts: context-window need, configured providers, model availability,
privacy mode, cost, local-only constraints, and the shared intellect scale.

The first release is advisory and explains the selected signals. Automatic selection
requires an end-to-end task-success evaluation, because classification accuracy does not
prove that the routed model completes the task. A user-selected model always wins.

## Later candidate: review triage

A triage request may ask whether the diff changes behavior, lacks relevant tests, touches
security-sensitive code, appears mechanical, or contains unrelated changes. Copse code
uses those signals only to decide whether to spend on the existing generative reviewer.

Uncertainty, sensitive files, failing tests, large diffs, dependency/permission changes,
or conflicting signals always run the reviewer. The triage path may skip review only for
confidently trivial work after meeting the phase gate. It cannot approve a diff, suppress
a known finding, or mark the task complete.

## Validation matrix for implementation PRs

| Layer                 | Required evidence                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure decision mapping | Unit tests for every label, label-specific thresholds, per-answer abstention, Score/Choice normalization, and exact probability-boundary cases                                                  |
| Runtime decoding      | Fixtures for valid responses, missing/extra question ids, wrong answer type, unknown choices, NaN/infinite/out-of-range values, probability sums, malformed legends, and oversized usage values |
| Client behavior       | Injected-fetch tests for authorization without secret logging, timeout, cancellation, one bounded retry, `401`/`422`/`429`/`529`, malformed JSON, and redaction                                 |
| Pack lifecycle        | Disabled/missing-key no-op, enable/key synchronization, atomic disable, environment-key fallback, stored-key masking, and diagnostic clearing                                                   |
| Roadmap integration   | One request per save/import, independent field fallback, stale prompt rejection, `categoryManual`, deletion during await, and no unhandled detached rejection                                   |
| Privacy and usage     | Policy rendering, non-ZDR default copy, dedicated usage attribution, current price fixture, and no raw prompts in usage/diagnostic stores                                                       |
| UI                    | Focused Settings spec plus screenshot; Roadmap visual evidence only if its DOM/copy changes                                                                                                     |
| Full gate             | `pnpm run oracle` for touched files, then every named tier and `pnpm run check` before commit                                                                                                   |

## Rollback and kill switches

- Pack disable is the primary local kill switch and takes effect before the next request.
- Authentication failures disable active calls for the session and surface one deduplicated
  Settings error; they do not retry on every Roadmap save.
- A short rolling failure circuit opens after repeated timeout/overload/invalid-response
  failures, uses the existing classifier during cooldown, and exposes local status.
- A model or question-set upgrade is a new evaluated version. Keep the last passing
  version available for one release so a regression can be rolled back without a code
  redesign.
- Removing the dependency restores existing classification; no thread, Roadmap, or
  knowledge-store format migration is required by the first slice.

## Non-goals

- Replacing Copse's LLM providers, small-task drafting, or agent loop.
- Generating code, prose, titles, plans, summaries, or remediation instructions.
- Sending whole repositories, diffs, transcripts, tool traces, or secrets to TypeSafe.
- Using model output for deterministic arithmetic, dates, counts, schema checks, or
  availability/cost calculations.
- Letting repository content define the questions, criteria, thresholds, model id, or
  control flow. All are app-owned constants.
- Adding TypeSafe to permission gates, sandbox decisions, auto-approval, credential
  policy, or correctness/completion authority.
- Enabling a third-party cloud call by default or silently replacing an on-device
  small-task model.
- Treating vendor `confidence` as calibrated for Copse without held-out measurement.

## Open questions to close in Phase 0

1. Does complexity Choice or Score produce better enum calibration on Copse's rubric?
2. Are thresholds global or label-specific? Prefer label-specific thresholds if the
   held-out reliability curves differ materially.
3. Does secret redaction remove information needed for classification often enough to
   affect accuracy? If so, abstain rather than weaken redaction.
4. Is the official SDK's retry/timeout surface sufficient for Copse's total deadline, or
   should the adapter use direct `fetch` while retaining the same app-owned contract?
5. Does TypeSafe's latency advantage hold from the regions where Copse is used, rather
   than only in vendor-reported measurements?
6. Is ordinary retention acceptable for this feature, or should active mode require an
   enterprise ZDR account? The default remains disabled either way.

## Primary sources

- TypeSafe, [How to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- TypeSafe, [API reference](https://docs.typesafe.ai/api)
- TypeSafe, [Models and limits](https://docs.typesafe.ai/models)
- TypeSafe, [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
- TypeSafe, [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- TypeSafe, [Legal overview](https://docs.typesafe.ai/legal) and
  [Privacy Policy](https://typesafe.ai/legal/privacy-policy)
