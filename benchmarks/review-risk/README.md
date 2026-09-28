# Copse Reviewer risk-rating eval (`pnpm run bench:risk`)

Does the **Low / Medium / High risk** line that Copse Reviewer writes at the bottom of a pull
request's description (`packages/review/src/pr-summary.ts`, §PR description summary in
[`docs/plans/copse-reviewer.md`](../../docs/plans/copse-reviewer.md)) match what actually
happened to the change? `bench:review` measures the reviewer's _findings_. This harness
measures the _rating_.

The truth comes from each change's history after it merged, not from the surfaces its diff
touches. A rubric that rates by surface can't be checked against labels that are also
derived from surfaces.

## The corpus

[`corpus.json`](corpus.json) holds 81 merged pull requests from `copse-dev/agent-pane`, in
two cohorts:

| cohort   | cases | what                                                                                                                               |
| -------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------- |
| `rated`  |    43 | every change merged to `main` that carries a Copse Reviewer summary block (the feature shipped 2026-09-26), with its posted rating |
| `mature` |    38 | changes merged 2026-08-10 → 2026-09-20, so each has a full 7-day outcome window; no posted rating (they predate the feature)       |

The mature sample is deliberately stratified. Half comes from changes with candidate evidence,
taking every change a later one blames outright first. The other half comes from changes with
none. Each half is spread over three size buckets in a stable pseudo-random order.
**Changes with bad outcomes are oversampled on purpose**, so the corpus has outcomes to miss.
Its base rates are therefore not the repository's. For the population rate, see the
collector's tier counts below.

Each case records:

- **What the summary step reads.** For a merged change this is the commit it landed as on
  `main` and that commit's parent. `main`'s history has been rewritten, so GitHub's
  `merge_commit_sha` and old pull request heads are not on it. A squash commit is exactly the
  pull request's net change.
- **Size.** Changed files, lines, and **source lines**: added plus deleted lines outside tests,
  docs, fixtures, screenshots and lockfiles. Also how many of those source lines were
  deletions.
- **Surfaces.** The rubric's high-risk surfaces the changed source paths touch
  (`pathSurfaces`). This is what a purely surface-based rater would see.
- **The posted rating**, parsed from the block the tool still owns (`findBotBlock`). It
  includes the model's level before `applyEvidenceFloor` raised it, when it did.
- **Evidence items**, each with a person's verdict and a note.

### Evidence and the labelling rules

`bench:risk collect` finds candidate evidence within **7 days** of the merge from four
sources:

1. **revert**: a later pull request titled `Revert …` that names the change.
2. **reference**: a later pull request or issue that names the change (`#n` or this
   repository's URL). Matches come from its description, or from GitHub's cross-reference
   timeline, which covers comments and commits. Dependabot bodies are skipped because they
   quote upstream issue numbers.
3. **fix-overlap**: a later merged pull request with a fix-like title (`Fix`, `Stop`,
   `Restore`, `Keep`, …) that changed one of this change's source files. Files touched by 2%
   or more of the window's merged changes are excluded as too hot to mean anything.
4. **main-ci**: the `CI` push run failed on the landed commit and passed on its parent.

Every item starts `unverified`, and a person rules on it. The verdicts, with a one-line note
each, are in the corpus:

| verdict      | meaning                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `regression` | something that worked before stopped working because of this change: product behaviour, data, a security property, or a CI, deploy or release pipeline |
| `cosmetic`   | a regression visible only as copy or styling, with no loss of function                                                                                 |
| `incomplete` | the change needed a correction to finish its own intent, or left only the test suite red on `main` (a stale expectation or reference)                  |
| `unrelated`  | the later change names this one without blaming it: new work building on it, a screenshot re-baseline for an intended change, or a rebase note         |

A case's **truth** is **High** if any item is a `regression`, **Medium** if any is `cosmetic`
or `incomplete`, and **Low** otherwise. A case with any `unverified` item is not scored. A
merged case is **mature** once its full window has been observed. Re-collecting keeps every
verdict and note.

In this corpus, 88 evidence items were ruled on: 9 regressions, 1 cosmetic, 12 incomplete and
66 unrelated. Most fix-overlaps and many references turn out to be noise (a formatter switch
shares a file with every later fix; screenshot re-baselines list the PRs whose UI they
capture), which is why every item needs a ruling.

### Known limits of the truth

- **Outcomes are a proxy for risk.** A risky change handled well leaves no trace, so a High
  rating on a change with a clean history is only weak evidence of over-rating. A Low or
  Medium rating on a change that caused a regression is a clear miss.
- **Only regressions someone wrote down are found.** A regression fixed without naming the
  change that caused it, or one not noticed within 7 days, is missed.
- **Review rounds aren't usable here.** The repository has one maintainer, and the only PR
  reviews come from Copse Reviewer's own bot. Its findings already feed the rating through
  `applyEvidenceFloor`, so using them as truth would be circular.
- **The `rated` cohort is immature.** Those changes merged between 2026-09-26 and
  2026-09-27, so they have 0 to 1.3 days of history, not 7. Re-run `collect` after
  2026-10-04 to mature them; verdicts carry over.

## Running it

```bash
# Build or refresh the corpus (GitHub token in GITHUB_TOKEN or GH_TOKEN; behind an HTTPS
# proxy, Node's fetch also needs NODE_USE_ENV_PROXY=1). New evidence arrives `unverified`.
pnpm run bench:risk collect --mature-from 2026-08-10 --mature-to 2026-09-20 --mature-count 38

# Score the ratings already posted in the descriptions
pnpm run bench:risk score

# Rate every case with the real summary step: `copse-review --summary-only` at the case's base
# and head, read-only, nothing posted. The flags after `--` go to copse-review unchanged.
pnpm run bench:risk run --label baseline -- --provider openrouter --model openai/gpt-6-luna

# A/B a prompt change: run the same flags from a checkout that carries the candidate prompt,
# then compare the two rating sets case by case.
git worktree add ../copse-candidate my-rubric-branch
pnpm run bench:risk run --label candidate --reviewer ../copse-candidate -- --provider openrouter --model openai/gpt-6-luna
pnpm run bench:risk compare bench-results/review-risk/baseline.json bench-results/review-risk/candidate.json
```

Each rating set records the reviewer revision it ran at, and a digest of that revision's
`summarySystemPrompt()`, so a comparison says which prompt produced each rating. Model keys
come from the environment in the same way `copse-review` takes them. `--provider mock
--mock-script <file>` runs the whole path without a model; the self-test in
`scripts/bench-risk.test.ts` does this.

## Results (2026-09-27)

**What was measured with a live model: nothing.** This environment has no model-provider
credentials, so no summary was generated. Every rating below was **already posted** in a
pull request's description by the production workflow (`review-summary.yml`, whose model
this harness does not know). The 38 mature cases have no posted rating, and are waiting for
`bench:risk run`. The full report is in [`results/posted.md`](results/posted.md).

### Posted ratings against outcomes (43 rated cases, all immature)

| predicted ↓ / truth → | low | medium | high |
| --------------------- | --: | -----: | ---: |
| low                   |  10 |      0 |    0 |
| medium                |  18 |      3 |    0 |
| high                  |  11 |      0 |    1 |

- **Under-rated: 0 of 43.** The one regression (#3231: the new required CLA check failed
  every pull request with agent-written commits) was rated High. The two `incomplete` cases
  (#3123, #3181) and the one `cosmetic` case (#3128) were all rated Medium.
- **Over-rated: 29 of 43 (67%)**, but truth here covers at most 1.3 days, so this figure is
  an upper bound, not a finding.
- **The rate at which High is issued is the stronger signal, and it needs no outcomes.**
  - High went on 14 of 46 merged PRs (30%) and 24 of 34 open PRs (71%) that carried a block
    on 2026-09-27.
  - Of 517 changes merged to `main` between 2026-08-10 and 2026-09-20, only 15 (3%) were
    blamed outright by a later change ("regression from #n", "introduced by #n", "broke",
    "follow-up to #n"); another 152 had any candidate evidence at all.
  - Even allowing for regressions nobody wrote down, a High issued on a third or more of
    changes has single-digit-percent precision.

### What the High reasons cite

| clause cited in the reason | cited | rated high | over-rated (immature) |
| -------------------------- | ----: | ---------: | --------------------: |
| cross-cutting              |    13 |          4 |                    11 |
| process / IPC              |    12 |          6 |                    11 |
| dependency / build         |    12 |          7 |                     8 |
| permissions / sandboxing   |    11 |          4 |                     7 |
| persisted data             |     7 |          4 |                     6 |
| auth / secrets             |     4 |          3 |                     4 |

The clauses are matched by keyword in the one-sentence reason (`rubricClauses`), which is
approximate.

### What actually predicts a bad outcome here (no rater involved)

Over the 38 mature cases, which have a full window:

| changes that…                             | cases | truth medium | truth high | medium or high |
| ----------------------------------------- | ----: | -----------: | ---------: | -------------: |
| all                                       |    38 |            7 |          4 |            29% |
| touch no high-risk surface                |    16 |            4 |          1 |            31% |
| touch security                            |     5 |            1 |          1 |            40% |
| touch permissions / sandboxing            |     4 |            1 |          1 |            50% |
| touch persisted data                      |     5 |            0 |          1 |            20% |
| touch process / IPC                       |    12 |            3 |          1 |            33% |
| touch dependency / build                  |     8 |            0 |          1 |            13% |
| are small (under 100 source lines)        |    14 |            4 |          0 |            29% |
| are medium (100–499)                      |    17 |            3 |          4 |            41% |
| are large (500+)                          |     7 |            0 |          0 |             0% |
| touch a surface, under 100 source lines   |     3 |            0 |          0 |             0% |
| touch a surface, 100 or more source lines |    19 |            3 |          3 |            32% |

Over all 81 merged cases the same pattern holds:

- **Size:** no change under 100 source lines caused a regression (0 of 37).
- **Weak clauses:** `persisted-data` and `dependency-build` have the lowest bad-outcome rates
  (13% each).
- **Strong clauses:** `security`, `permissions-sandboxing` and `auth-secrets` have the highest
  (43–50%).
- **Rewriting is not the risk:** every regression came from a change that was mostly
  additive, and none from one that rewrote existing code (0 of 24).

These are small numbers: 5 regressions in the whole corpus, and the mature sample is
oversampled for outcomes. Read them as direction, not effect size.

### Case study: #3079

The posted rating was **High**: _"The change crosses renderer-to-main agent dispatch and
persisted thread review metadata, including an API protocol version bump, alongside prompt
behavior in bounded runtime surfaces."_ What the change does:

- adds one optional field to a persisted report type;
- adds one optional field to the renderer-to-main run payload, with the protocol version bump
  that follows (20 → 21);
- adds a gated system-prompt paragraph.

That is 289 source lines out of 958 added in total. There is no migration, and nothing
existing changes shape. The reason names the surfaces the change crosses and says nothing
about what it does to them. `persisted-data` and `process-ipc` are the two clauses most often
behind an immature over-rating above, and two of the weakest predictors of outcomes. #3079
merged on 2026-09-27, so its own outcome is not in yet.

The small Highs are a different story. #3230 (4 source lines) bumps the release-signing
toolchain. #3202 (30) changes the CI token's permissions. #3144 (109) deletes user worktrees.
All three are defensible under a reading of what the change _does_. A size cap alone would
wrongly lower them.

## Findings

1. **It is not a one-off; it is systematic, but it is not about size.** The rating tracks
   which surfaces a change touches, while outcomes track what it does to them:
   - High goes on a third of merged and seven in ten open pull requests, against roughly 3%
     of changes blamed for a regression.
   - The reasons most often cite IPC, persisted data and build surfaces, which are the
     weakest predictors of a bad outcome in this repository.
2. **The opposite error was not observed.** No change with a recorded regression, cosmetic
   regression or incomplete fix was rated below its outcome (0 of 4 in the rated cohort). The
   mature cohort, with 4 regressions and 7 incomplete changes, has no ratings yet. It is the
   real test of under-rating and needs a model run.
3. **"Additive" is not a safe proxy for "low".** The regressions in this corpus were all
   mostly-additive changes that altered an existing decision or behaviour. For example:
   - #1822 let approval be skipped for a new file;
   - #1785's new fallback fired on completed turns;
   - #3231 added a required check.

   A rubric that down-weights by the added/deleted ratio would miss them. The distinction
   that matters is whether existing behaviour, data, contracts or decisions change.

## Recommendations (not applied)

The evidence justifies changing the rubric, but `pr-summary.ts` is left unchanged because
the before/after has not been run with a model. The proposed replacement for the three
`Risk levels` lines of `summarySystemPrompt`:

```text
Risk is how much could go wrong if this change is wrong, and how likely that is. Judge what the change does to each surface, not which surfaces it touches.
- low: documentation, tests, comments, configuration with no runtime effect, or a small, contained behaviour change.
- medium: a runtime behaviour change in a bounded area; a change to shared code with a limited set of callers; or an addition on a sensitive surface that leaves existing behaviour, data and contracts as they were, such as a new optional field in persisted data or an IPC message that existing readers ignore, a new setting, or a new CI step.
- high: a change that alters an existing security, permission, sandbox or approval decision, or how authentication or secrets are handled; changes the shape or meaning of existing persisted data, or needs a migration; changes an existing process or IPC contract in a way an older peer cannot handle; introduces or changes concurrency; changes a dependency's major version, or how the app is built, signed or released; adds or changes a required gate; or changes behaviour broadly across many areas.
In riskReason, say what the change does to the surface (adds to it, alters it, removes from it), not only which surface it touches.
```

And the matching tool description for `riskReason`: _"One sentence: why this risk level —
what the change does to the surfaces it touches."_

Expected effect on the posted cases, to be confirmed by the A/B:

- #3079 → Medium (optional fields old readers ignore);
- #3208, #3145 → re-examined;
- #3230, #3202, #3144 → stay High (release signing, token permissions, deleting user data);
- #3231 → stays High (a required gate).

**Before merging a prompt change, run this A/B** with the production model, using the
commands above:

1. **No new under-ratings.** No mature regression (#1785, #1822, #2260, #2404) or rated
   regression (#3231) may fall below High.
2. **Fewer over-ratings.** Fewer Highs on cases whose truth is Low, in both cohorts.
3. **The case study moves.** #3079 moves to Medium.

Change `pr-summary.ts` only if all three hold. Then re-run `collect` after 2026-10-04 so the
rated cohort's outcomes mature, and score again.

Two further changes would make the eval stronger:

- **Record the model with the rating.** Have the summary footer name the model that wrote
  it, so posted ratings can be grouped by model.
- **Keep the window rolling.** Re-collect monthly, so the mature cohort grows past five
  regressions.
