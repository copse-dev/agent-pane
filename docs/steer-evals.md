# Steer evals — runbook

How to run the prompt-steer evals, what each one proves, and how to read the
result. Mechanics of the harness itself live in
[`benchmarks/steer/README.md`](../benchmarks/steer/README.md); this is the
operator's guide.

## Why these exist

Almost every steer in the app is backed by a unit test that asserts the string
is wired up. Very few are backed by anything that asserts the string **does
something**. A presence test stays green while the prompt text is inert, which
means we can pay tokens for wording that changes no behaviour and never find
out.

Two structural findings from the audit that prompted this work:

- `tests/e2e/scenarios/*.json` never runs in CI.
- `eval:doctrine` only ever passes `--sections tools`, so seven of eight prompt
  sections have no model-backed arm.

So the suite is deliberately cheap to run on demand rather than wired into every
PR. Real-model runs are **trend evidence**, never a merge gate.

## The one number that matters

```
lift = withPassRate - withoutPassRate
```

Each pack runs the same task twice — once with the steer text exactly as it
ships, once without — and scores both against deterministic checks. Pass rate on
its own tells you the model behaved; only lift tells you the _prompt_ caused it.

## Running the suite

### Before you start

- `npm ci` (once)
- A model. For LM Studio: start the server, load a model, note the model id.
- Nothing else. The evals are headless — no Electron, no display.

```bash
# 0. Harness self-test. Deterministic, no model, ~5s. Run this first.
npm run eval:steer -- --provider mock --repeats 1 --require-gates

# 1. Everything, against a local model
export LM_STUDIO_MODEL=<model-id>
export LM_STUDIO_API_KEY=<key>          # or LM_API_TOKEN
npm run eval:steer -- --provider lmstudio --repeats 5

# 2. One pack, keeping the workspaces so you can inspect what happened
npm run eval:steer -- --provider lmstudio --pack git-branch-safety --repeats 5 --keep-workspaces

# 3. Cloud
ANTHROPIC_API_KEY=… npm run eval:steer -- --provider anthropic --model claude-opus-5 --repeats 5
```

If step 0 fails, stop — the problem is the harness or your environment, not a
steer.

### Cost and runtime

Per attempt: one agent loop, `maxSteps` between 8 and 20, a few thousand tokens
of context. **Each repeat runs both arms**, so a pack with one task at
`--repeats 5` is 10 model runs.

| scope                               | model runs | rough wall clock (local 30B) |
| ----------------------------------- | ---------- | ---------------------------- |
| one single-task pack, `--repeats 5` | 10         | 5–15 min                     |
| one two-task pack, `--repeats 5`    | 20         | 10–30 min                    |
| whole suite, `--repeats 5`          | ~120       | 1–3 hours                    |
| whole suite, `--repeats 3`          | ~72        | 40–90 min                    |

Start with `--repeats 3` on one pack to sanity-check your setup before
committing to a full run. On cloud models, budget by token spend rather than
time — the suite is small but not free, and `report.json` records per-arm token
counts.

## What each pack proves

| pack                    | steer                          | the question it answers                                                                                                    | PR    |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----- |
| `git-branch-safety`     | `GIT_BRANCH_SAFETY`            | Does a model on the default branch actually branch before committing — and does it leave an existing working branch alone? | #1608 |
| `commit-steering`       | `buildCommitSteeringPrompt`    | Does the agent reach for `git_commit` instead of `run_shell git commit`, so the attribution trailer survives?              | #1610 |
| `forced-todo-plan`      | `FORCED_TODO_PLAN_PROMPT`      | Does a weak model plan _before_ acting when the block fires?                                                               | #1612 |
| `forced-written-plan`   | `FORCED_WRITTEN_PLAN_PROMPT`   | Does the no-plan-tool fallback produce a written plan?                                                                     | #1612 |
| `loop-nudge`            | `LOOP_NUDGE_USER_MESSAGE`      | Does the nudge actually end a loop, or just cost a turn?                                                                   | #1613 |
| `stuck-finalize-nudge`  | `STUCK_FINALIZE_NUDGE`         | Same, for the harder "stop calling tools" wording.                                                                         | #1613 |
| `opus5-response-length` | `OPUS_5_RESPONSE_LENGTH_BLOCK` | Do answers get shorter — without degrading into fragments?                                                                 | #1614 |
| `opus5-tone-reminder`   | `OPUS_5_TONE_REMINDER`         | Does the end-of-prompt restatement carry any effect on its own?                                                            | #1614 |

Two packs care which model you point them at:

- **`forced-*` want a genuinely weak model.** A small local weight, not a
  frontier model. That is the population the pack targets; lift on a strong
  model reads ~0 for the uninteresting reason that it would have planned anyway.
- **`opus5-*` want Opus 5.** The blocks are gated on `isOpus5Model` in
  production and the premise is a claim about that model's verbosity.

## Reading the result

Every run writes `report.md` (the matrix), `report.json` (every attempt, with
per-check results and token counts), and a `.jsonl` chunk trace per attempt.

Four outcomes, and only one is "the steer is fine":

**High `with`, low `without`** — the steer works. Ship it, record a baseline.

**High `with`, high `without`** — the model already did the right thing
unprompted. The steer is redundant _on this model_. Before deleting the text,
run it against a weaker one; most of these exist for the models that need them.

**Low `with`, low `without`** — the steer is not landing. Either the wording is
being ignored, or the behaviour needs a mechanism rather than a sentence. For
anything with a destructive failure mode, prefer the mechanism: prompt text is
not a control surface for something that must not happen. `git-branch-safety`
failing this way is an argument for a tool gate on `git_commit`, not for
rewording the paragraph.

**`with` lower than `without`** — the steer is actively harmful, or the task is
noisy. Check `report.json` for per-check breakdowns before concluding anything;
with small `--repeats` this is usually noise.

### Read the per-check rates, not just the headline

`compliant` requires every check to pass, which deliberately conflates severity.
`git-branch-safety` is the clearest example: `default-branch-untouched` failing
is dangerous, `branch-named-copse` failing is cosmetic. Both drop the pass rate
identically. `report.json` → `arms[].perCheckPassRate` separates them.

### Calibrating the gates

Every declared gate in this series is an **opening guess, not a measurement** —
nothing here has been run against a real model yet. Treat the first run as
calibration:

1. Run with `--repeats 5` and no `--require-gates`.
2. Read the actual rates.
3. Set `minLift` below what you observed, with room for noise.
4. Commit the adjusted gate in that pack's PR, with the observed numbers in the
   commit message.

A gate set above the observed rate makes the eval fail forever and get ignored.
A gate at zero makes it unable to fail. Both are worse than no eval, because
both look like coverage.

## When a steer fails its eval

The eval failing is not automatically a bug in the eval. In order of likelihood:

1. **The task is wrong.** Too easy (both arms pass), too hard (both fail), or it
   doesn't create the condition the steer fires on. Check the `.jsonl` trace.
2. **The check is wrong.** A regex that under-matches makes a steer look
   _more_ effective than it is. Every check kind is asserted in both directions
   in `scripts/steer-eval-lib.test.ts`; per-pack regexes should be spot-checked
   against real phrasings before you trust a green result.
3. **The steer really is inert.** This is the finding worth having. Options, in
   order: reword and re-run; move the behaviour into a mechanism; delete the
   text and reclaim the tokens.

Deleting a steer that shows no lift on any model is a legitimate outcome and the
main reason to run this suite.

## Recording a baseline

There is no baseline file yet — the first real run should create one, the same
way `benchmarks/doctrine/doctrine-baseline.json` works for the doctrine eval.
Until then, keep `report.json` from a known-good run in the PR that calibrates
the gates so later runs have something to compare against.

## Related harnesses

- `npm run eval:doctrine` — ablates base-prompt **sections** and scores
  working-style doctrine compliance. Use it for doctrine questions; use
  `eval:steer` for a specific behavioural check.
- `npm run test:e2e:agent-eval` — drives the real Electron UI. Use it when the
  steer depends on app state (settings, packs, the thread store) rather than
  prompt text alone.
- `npm test` — unit pins that a steer is wired up. Necessary, not sufficient.
