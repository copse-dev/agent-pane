# Steer evals (`npm run eval:steer`)

Every prompt steer in the app ships with a unit test that asserts the string is
wired up. Almost none has a test that asserts the string **does anything**. A
presence test stays green while the prompt text is inert, so we can pay tokens
for wording that changes no behaviour and never find out.

This harness closes that gap. It holds the task and the model constant and runs
each task twice:

| arm       | prompt                                         |
| --------- | ---------------------------------------------- |
| `with`    | the steer text is present, exactly as it ships |
| `without` | the steer text is removed                      |

The headline number is **lift**:

```
lift = withPassRate - withoutPassRate
```

A steer with ~0 lift is not steering. That is the finding the existing tests
cannot produce, and it is the reason this harness exists.

## Running it

```bash
# Harness self-test — deterministic, no model, ~5s. Safe in per-PR CI.
npm run eval:steer -- --provider mock --repeats 1 --require-gates

# Local model (LM Studio). Start the server and load a model first.
LM_STUDIO_MODEL=<model-id> LM_STUDIO_API_KEY=<key> \
  npm run eval:steer -- --provider lmstudio --repeats 5

# Cloud
ANTHROPIC_API_KEY=… npm run eval:steer -- --provider anthropic --model claude-sonnet-5 --repeats 5
OPENAI_API_KEY=…    npm run eval:steer -- --provider openai    --model <model> --repeats 5
OPENROUTER_API_KEY=… npm run eval:steer -- --provider openrouter --model <model> --repeats 5

# One pack, keeping workspaces for inspection
npm run eval:steer -- --provider lmstudio --pack git-branch-safety --keep-workspaces
```

Useful flags: `--repeats <n>` (default 3), `--pack <id>`, `--packs <dir>`,
`--out <dir>`, `--model`, `--base-url`, `--keep-workspaces`, `--require-gates`
(exit non-zero when a pack misses its declared gate).

Each run writes `report.md` (the lift matrix), `report.json` (every attempt),
and a `.jsonl` chunk trace per attempt.

## Reading the result

Three outcomes matter, and only one of them is "the steer is fine":

- **High `with`, low `without`** — the steer works. This is the goal.
- **High `with`, high `without`** — the model already did the right thing
  unprompted. The steer is redundant on this model; it may still earn its place
  on weaker ones, so check a small model before deleting the text.
- **Low `with`** — the steer is not landing. Either the wording is ignored, or
  the behaviour needs a mechanism (a tool gate, a hook) rather than a sentence.
  Prompt text is not a control surface for something that must not happen.

Repeats matter. Single runs on a real model are noise; use `--repeats 5` or more
before concluding anything, and prefer comparing lift across models over
chasing an absolute pass rate on one.

## Writing a pack

A pack is one JSON file in `packs/`. It names the steer, the tasks, and the
behavioural checks:

```jsonc
{
  "id": "git-branch-safety",
  "description": "…",
  "steer": { "kind": "section", "ref": "gitBranchSafety" },
  "gate": { "minLift": 0.3, "minWithPassRate": 0.6 },
  "tasks": [
    {
      "id": "commit-on-default-branch",
      "prompt": "…",
      "gitInit": { "defaultBranch": "main" },
      "checks": [{ "id": "…", "kind": "shell", "command": "…" }],
    },
  ],
}
```

`steer.kind` selects how the text enters the run, matching how production adds
it:

| kind        | production analogue                                 | arms differ by                      |
| ----------- | --------------------------------------------------- | ----------------------------------- |
| `section`   | a base-prompt section in `agent-prompt-sections.ts` | omitting the section                |
| `block`     | a conditional block appended by `buildSystemPrompt` | appending the block                 |
| `turnStart` | a `turnStart` hook's `injectContext`                | appending the injection             |
| `nudge`     | a mid-loop guard injection                          | the message sent after `afterSteps` |

`ref` resolves to the **shipping constant**, never a copy — edit the prompt in
`agent-prompt.ts` and the eval re-runs against the edit. A pack that inlined its
own copy of the text would stay green while production drifted.

For `nudge` packs both arms run identically up to `afterSteps`, then the steered
arm receives the real nudge and the control receives a neutral `Continue.`
(override with `controlText`). Both arms get _a_ message so the comparison
isolates the wording rather than the existence of an extra turn.

### Check kinds

| kind                                        | passes when                                   |
| ------------------------------------------- | --------------------------------------------- |
| `tool-used` / `tool-not-used`               | the tool was / was not called                 |
| `first-tool-is`                             | the first tool call is this tool              |
| `tool-arg-matches` / `tool-arg-not-matches` | some / no call's arg matches the regex        |
| `final-matches` / `final-not-matches`       | the final message matches the regex           |
| `final-max-chars` / `final-min-chars`       | the final message is within bounds            |
| `max-tool-calls`                            | the run stayed under a tool-call budget       |
| `shell`                                     | the command exits 0 in the finished workspace |

An attempt is compliant only when **every** check passes. Checks are asserted in
both directions in `scripts/steer-eval-lib.test.ts` — a checker that cannot fail
would make every steer look effective.

## Tasks and the sandbox

Tasks run in a throwaway temp workspace. `fixture` copies a directory in and
`gitInit` turns it into a repo:

| field            | effect                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `defaultBranch`  | the repo's default branch name                                                                                        |
| `stageFixture`   | default `true` — commit the fixture so the agent sees a normal project. Set `false` when the task needs a dirty tree. |
| `checkoutBranch` | leave the run on a second, non-default branch                                                                         |

`stageFixture` defaults to true on purpose: a repo where every file is untracked
is itself a strong behavioural cue and would confound the comparison.
`checkoutBranch` exists because "preserve an existing working branch" is
unobservable when the only branch is also the default one.

`run_shell` is restricted to `allowedCommands` (exact) plus
`allowedCommandPatterns` (regex). Patterns exist so a model can phrase its own
command — which is the point for steers about _how_ to do something: the eval
has to let the agent do the wrong thing, or the check can never fail.

`mockOnly: true` marks a task as a harness self-test; it is excluded from
real-model runs, and real-model tasks are excluded from `--provider mock`.

## Relationship to the other harnesses

- `npm run eval:doctrine` — ablates base-prompt **sections** and scores the
  working-style doctrine. Overlaps on `section` steers; use it for doctrine
  compliance, this for a specific behavioural check.
- `npm run test:e2e:agent-eval` — drives the real Electron UI. Use it when the
  steer depends on app state (settings, packs, the thread store).
- `npm test` — unit pins that the steer is wired up. Necessary, not sufficient.
