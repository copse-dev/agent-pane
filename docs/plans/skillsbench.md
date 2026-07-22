# SkillsBench exploration and skill-effectiveness evals

Tracking: [#752](https://github.com/copse-dev/agent-pane/issues/752),
[#1079](https://github.com/copse-dev/agent-pane/issues/1079), and
[#874](https://github.com/copse-dev/agent-pane/issues/874)

Status: **Scaleway spike implemented; study not yet run.** The runnable boundary is documented in
[`benchmarks/skillsbench/README.md`](../../benchmarks/skillsbench/README.md). It deliberately stops
short of selecting cohorts, publishing results, or changing the regular Copse agent's
skill-selection behaviour.

The spike uses BenchFlow's `RolloutConfig.planes` composition seam: the official Docker task,
curated-skill deployment, verifier, result, and trajectory lifecycle remain upstream-owned, while
only ACP execution is replaced with Copse's bundled headless loop. This is narrower and more
auditable than pretending Copse is one of BenchFlow's built-in agents or reimplementing the
official verifier contract.

## Why this benchmark

Copse already discovers skills from user, project, plugin, plugin-path, and bundled roots; presents
a name/description catalog; exposes `read_skill`; and injects the complete `SKILL.md` body when the
user explicitly invokes `/skill-name`. What we do not know is whether those mechanics improve task
outcomes, whether the agent finds a useful skill without being told its name, or whether the added
context and workflow constraints merely cost tokens.

[SkillsBench](https://github.com/benchflow-ai/skillsbench) is a useful first external test because
it pairs professional tasks with curated skill folders and deterministic verifiers. Its official
comparison runs the same task with and without the curated skills. Crucially, the task instruction
does not name the relevant skill: the harness must make the skill available and the agent must
discover and use it. That makes it possible to separate three questions:

1. **Content value:** does the curated procedure help when its instructions are definitely loaded?
2. **Discovery value:** does Copse's catalog and `read_skill` path cause the agent to load it at the
   right time?
3. **Product value:** does the complete Copse path improve official reward enough to justify its
   token, latency, and safety cost?

This remains a harness evaluation, not a model leaderboard. Hold the model and all runtime limits
fixed, vary only skill delivery, and retain the complete trajectories needed to explain the delta.

## Pinned upstream contract

Begin with the official
[SkillsBench v1.1 release](https://github.com/benchflow-ai/skillsbench/releases/tag/v1.1):

- dataset tag `v1.1`, commit `b63b7b2850226b6aa4fb5929a8c1ac7bc4d9a6af`;
- 87 active native BenchFlow `task.md` packages across eight categories;
- 14 credential-dependent or integration-incompatible `tasks-extra` packages retained as excluded
  metadata, never silently admitted to the score;
- BenchFlow `0.6.3` for the first adapter, matching the release's `>=0.6.3,<0.7` compatibility
  contract;
- binary official verifier reward as the primary outcome; no Copse-authored substitute grader;
- matched `no-skill` and `with-skill` task environments, with the task instruction unchanged.

Generate a checked-in descriptor from the release's machine-readable task manifest and the pinned
task tree. For each task retain its category, difficulty, tags, task digest, complete skill-bundle
file inventory and digest, environment digest, verifier digest, and exclusion reason. The generator
must fail rather than fall back to `main` when the tag, commit, or attached manifest is unavailable.

Scores from another SkillsBench release, another BenchFlow line, or the paper's agent/model
configurations are context only. They are not directly comparable with a Copse run.

## What is product fidelity, and what is diagnostic

The official `with-skill` condition cannot be represented by forcing `/skill-name` into the task.
That would remove the discovery problem which SkillsBench intentionally tests. Conversely, one
plain with/without comparison would not tell us whether a null result came from bad skill content or
from Copse never loading it.

Use three immutable profiles:

| Profile             | Skill surface                                                                                                   | Purpose                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `skills-none@1`     | No task skill catalog, no task `read_skill` entries, and no injected skill body                                 | Official no-skill baseline                                |
| `skills-product@1`  | Curated bundle registered ephemerally; normal Copse catalog, `read_skill`, trust envelope, and prompt text      | Product-fidelity mapping of official with-skill condition |
| `skills-explicit@1` | Same bundle and trust policy, but full instructions injected through the regular invoked-skill builder up front | Diagnostic content ceiling with discovery removed         |

`skills-product@1 - skills-none@1` is the primary **Skill Lift**. `skills-explicit@1 -
skills-product@1` estimates the discovery/delivery gap. `skills-explicit@1 - skills-none@1` is a
diagnostic content ceiling, not an official SkillsBench result, because no user explicitly invoked
the skill.

Freeze the exact catalog prompt, tool schema, body envelope, trust settings, and profile hash for
each run. A future prompt or routing experiment gets a new profile ID; it must not mutate
`skills-product@1` in place.

### Trust and isolation

Benchmark skills are third-party input. Load them into an ephemeral per-trial registry as untrusted
project-like skills; never install them into `~/.agents/skills`, reuse ambient user skills, or expose
host credentials. Preserve Copse's external-link warnings, sandbox guidance, path-containment and
symlink checks, file-size limit, and approval policy. Run the official task environment without
network unless a later, separately approved credential lane requires it.

Hash the entire mounted skill bundle, not only `SKILL.md`. Skills may include scripts, references,
assets, or other files that materially change the trial. Record every `read_skill` path and the hash
of the bytes returned so the trajectory proves which version the model actually saw.

## Implementation slices

### Slice 1 — compatibility and deterministic conformance

Do not run a model matrix yet.

- Add a `bench:skills` entry point over the same headless run/capsule/report contract used by the
  other benchmark adapters. Keep benchmark-specific environment setup outside the regular agent.
- Pin SkillsBench v1.1 and BenchFlow 0.6.3. Generate and check in the 87-task descriptor plus the 14
  excluded records.
- Add an ephemeral skill-bundle loader which feeds the normal catalog, `read_skill`, and invoked
  body builders without importing Electron state into `@copse/agent` or touching user-installed
  skills.
- Implement the three profile IDs and stable content hashes. Local, fleet, and workflow inputs all
  require a profile, defaulting to `skills-product` only after the adapter is proven; one-task smoke
  commands should require an explicit profile before that point.
- Reuse the existing run manifest, sealed capsule, resumability, shard, and report conventions. Add
  benchmark-generic fields where needed rather than creating a second incompatible evidence format.
- Run the upstream oracle on every development/held-out candidate. A task is eligible only after
  its oracle returns reward `1` in our pinned environment.

Deterministic tests cover:

- exactly 87 unique active tasks and 14 explicitly excluded packages;
- pinned task, verifier, environment, and skill-bundle digests;
- no task skill, description, path, or body leaks into `skills-none@1`;
- `skills-product@1` exposes only the ordinary catalog and `read_skill` path, without pre-injection;
- `skills-explicit@1` uses the regular invoked-skill envelope without adding benchmark-specific
  instructions;
- resource reads remain within the mounted skill root, including symlink cases;
- ambient user/project/plugin skills cannot enter a trial;
- manifests round-trip and sealed capsules retain profile and skill provenance.

The slice is complete after one oracle smoke returns reward `1` and deterministic mock runs prove
that the three profiles expose exactly their intended prompts and tools.

### Slice 2 — small diagnostic cohort

Freeze both cohorts before inspecting model outcomes. Eligibility may exclude only recorded
infrastructure incompatibilities such as unavailable credentials, unsupported GPU requirements, or
an oracle failure; never exclude a task because the agent finds it hard.

Construct the development cohort by grouping eligible tasks by official category, sorting each
group by `SHA256("copse-skillsbench-v1.1-dev-v1:" + taskName)`, and taking the first task from each
group. This gives up to eight tasks with domain breadth and a reproducible selection rule.

Run all three profiles once per development task with one fixed model/provider configuration and
identical context limit, output limit, command timeout, agent timeout, permission policy, and
infrastructure. Inspect trajectories for adapter failures, missing resources, unsupported output
types, skill-load events, verifier failures, and timeouts. This cohort is diagnostic only; no product
or default change may be justified from it.

Before continuing, publish a short study note containing every run, failure, exclusion, and any
adapter change caused by the pilot. If the adapter changes, increment the affected profile rather
than rewriting the evidence.

### Slice 3 — held-out paired study

For each category, take the next two eligible tasks after the frozen development selection. This
creates a held-out cohort of up to 16 tasks, with the exact roster and task digests committed before
its outcomes are inspected.

Run three attempts per task/profile. Pair attempts by task and attempt index, and keep model,
provider, sampling, budgets, tool schemas, sandbox, permission policy, and runner image fixed. Do
not substitute a model or silently resume with changed settings midway through the study.

Primary comparisons:

- macro-average official reward for `skills-product@1 - skills-none@1`;
- paired per-task Skill Lift after averaging attempts within each task;
- task-level bootstrap 95% confidence interval, with the task as the inference unit;
- discovery gap, `skills-explicit@1 - skills-product@1`, reported as diagnostic evidence.

Secondary comparisons:

- solve count and stable/unstable/zero-pass task counts;
- skill invocation rate, first skill-read turn, files read, and task-specific skills touched;
- input/output tokens, model requests, tool calls, commands, and elapsed time;
- verifier/validation failures, missing-output failures, timeouts, and infrastructure-invalid trials;
- external-link/permission prompts and any denied or attempted unsafe operation.

Infrastructure-invalid trials are never scored as task failures and never omitted without being
reported. Missing paired attempts block a final comparison rather than changing the denominator.

### Slice 4 — routing stress, then full-roster confirmation

The official suite normally makes a task's relevant bundle available. That measures whether an
agent uses available relevant knowledge, but it is weak evidence for selection from a real catalog
containing many irrelevant or similarly named skills.

Only after Slice 3, add a separate Copse routing lane:

- relevant skill alone versus relevant skill plus a deterministic set of confusable distractors;
- a no-relevant-skill control requiring the agent to abstain from skill reads;
- catalog sizes of 1, 8, and a larger product-like catalog, changed one factor at a time;
- composition tasks tracked separately from single-skill tasks.

Report selection precision, relevant-skill recall, abstention rate, wrong-skill cost, and downstream
reward. Do not call this modified lane an official SkillsBench score.

If the held-out adapter is stable and the primary comparison is informative, confirm the result on
all compatible v1.1 tasks with `skills-none@1` and `skills-product@1`, three attempts each. Run
`skills-explicit@1` only on a predeclared failure-stratified subset unless budget permits the full
third arm.

## Trial and report contract

Every trial capsule records:

- benchmark ID, tag, full source commit, task ID, category, difficulty, task digest, environment
  digest, verifier digest, oracle status, and official reward;
- profile ID/content hash and Copse source commit;
- every available skill's name, source/trust classification, `SKILL.md` hash, complete bundle
  inventory/digest, external-link hosts, and whether it was catalogued or injected;
- every skill read/invocation event with turn, tool index, relative path, content hash, and result;
- model/provider and sampling settings, context/output budgets, timeouts, attempt index, runner
  image, sandbox/permission settings, and BenchFlow version;
- input/output tokens, model requests, tool calls, commands, elapsed time, stop reason, failure
  category, final outputs, verifier artifacts, raw event trace, and thread-store transcript.

Reports group by profile, task, category, difficulty, and attempt. The report generator must make it
impossible to combine different dataset revisions, profile hashes, model configurations, or
permission policies into one unlabeled aggregate.

## Decision rules

Keep all profiles available as historical experiment definitions. Do not change regular-agent
skill discovery or injection unless the held-out study shows:

- the candidate improves paired official reward with a task-bootstrap 95% interval excluding zero;
- it does not increase median tokens or elapsed time by more than 25% without additional solves;
- the improvement is not explained by missing pairs or infrastructure-invalid trials; and
- the routing lane does not materially worsen wrong-skill selection, abstention, or unsafe
  operations.

Interpret the three-arm result before designing a mechanism:

- explicit helps, product does not: investigate discovery/catalog/routing;
- neither skill arm helps: investigate skill compatibility, execution, or task/tool support before
  changing selection;
- product helps and explicit adds little: current progressive disclosure is probably sufficient;
- either arm hurts: inspect version mismatch, conflicting instructions, excess context, and
  resource/tool misuse task by task.

If no arm meets the rule, publish the null result and keep current product behaviour. Use the
trajectories to precommit a later single-mechanism factorial study rather than folding benchmark
prompts or task-specific recovery into the regular agent.

## Relationship to product work and other benchmarks

- The stable product-host/headless contract remains owned by
  [#1079](https://github.com/copse-dev/agent-pane/issues/1079). The SkillsBench adapter should be a
  consumer of that contract and should emit the same authoritative thread artifacts as CLI and ACP.
- [#874](https://github.com/copse-dev/agent-pane/issues/874) keeps playbooks distinct: skills are
  repo/plugin workflow packages, while playbooks are project-authored procedures. Do not pool them
  into one treatment. A later study may compare delivery mechanisms after both are independently
  specified.
- [SWE-Skills-Bench](https://github.com/GeniusHTX/SWE-Skills-Bench) is a useful later validation
  lane for repo-grounded software-engineering skills and project-version compatibility. It should
  reuse this profile and provenance machinery, not delay the first SkillsBench v1.1 pilot.
- Self-generated skill evaluation is deferred. SkillsBench's generated-skill condition and
  [SkillLearnBench](https://github.com/cxcscmu/SkillLearnBench) ask whether an agent can author or
  improve skills, which is a different causal question from whether Copse can consume a curated
  skill. Do not add generation to the initial matrix.

## Exit criteria

This plan is complete when the pinned v1.1 descriptor and adapter are reproducible, the diagnostic
and held-out studies are published with sealed evidence, the three causal comparisons can be made
without profile or dataset ambiguity, and the decision rule has either justified a narrowly scoped
product experiment or preserved the current default with a documented null result.
