# Orchestration strategy

Status: **Resolved (experimental scaffold shipped)** in
[#969](https://github.com/copse-dev/agent-pane/pull/969). It remains off by default
behind the `orchestrationStrategyEnabled` setting (Settings → Experimental). The
deliberately out-of-scope refinements below are separate follow-ups. Builds on the
advisor strategy scaffold
([advisor-strategy.md](advisor-strategy.md)); the two are complementary and can be enabled
together.

## What this is

The inverse of the advisor pattern. The advisor keeps the everyday loop on a cheap
executor and pulls a _stronger_ model in for guidance; the orchestration pattern keeps the
chat model as the **orchestrator** (planning, reviewing, integrating) and delegates each
bounded implementation step to a **cheaper / faster worker model** running as a subagent
with implementation tools (reads/searches, file edits, `run_shell`, git inspection).

The defining property is that **the parent observes between steps**: every `delegate_step`
result carries the worker's final report _plus_ a `git status --short` snapshot of the
working tree, so the orchestrator reviews what actually changed (digging in with
`git_diff` when in doubt) before writing the next step's brief. One tool call = one step =
one observation point.

The second deliberate contrast with the advisor: the advisor is handed the **full
transcript** automatically, while the worker sees **only the brief the orchestrator
writes** — the step, curated context (file paths, interfaces, conventions, constraints),
and an optional expected outcome. Curating context is the orchestrator's job; it is what
keeps the worker's window small and the delegation cheap.

## What landed in this scaffold

- **Settings** `orchestrationStrategyEnabled` (experimental, default off) and
  `orchestrationWorkerModel` (default `claude-haiku-4-5`, the cheapest tracked Claude) —
  schema in `settings-writable.ts`, UI in the Experimental section of `settings-dialog.ts`.
- **Core** `src/main/services/orchestration-strategy.ts` — pure: the worker tool
  allow-list and system prompt, `buildWorkerTask()` (the brief the worker sees),
  `buildStepObservation()` (report + working-tree snapshot the parent reviews), and
  `validateOrchestrationPair()` (refuses same-model delegation; warns when the worker is
  not actually cheaper per the model catalog).
- **Runner** `src/main/services/orchestration-runner.ts` — run-scoped context (ALS, like
  the explore seam, so fanned-out independent steps don't cross wires), set by
  `agent-service.ts` around a `delegate_step` call. Builds the worker provider via
  `buildProvider`, resolves the worker model's own context window, and drives the shared
  `runSubagent` loop with the implementation tool set (subagent kind `delegate`, so the
  timeline card shows the worker's inner steps like an explore run). Worker tokens are
  attributed at the worker model's rate and fold into the run's aux-model usage.
- **Tool** `delegate_step` (`src/main/tools/delegate-step-tool.ts`) — parameters `step`,
  `context`, optional `expected_outcome`; registered only when the flag is on
  (`registry-bootstrap.ts`).
- **Worker confinement.** The worker gets reads/searches + `write_file` / `str_replace` /
  `delete_file` / `rename_file` / `make_directory` + `run_shell` + `git_status` /
  `git_diff`, and nothing else: no `git_commit` (integration stays with the orchestrator),
  no `explore`/`investigate_ci` (no subagent nesting), no `ask_user` (the worker reports
  mismatches back instead of interrogating the user). Every inner tool call still goes
  through the normal registry gates — permission prompts, staged-edit approval, and
  read-only mode (which blocks `delegate_step` itself by default-deny).
- **Post-turn review gating.** A `delegate_step` call marks the turn as file-changing, so
  the existing post-turn review runs over the worker's edits just as it would over the
  parent's own.
- **Tests** `orchestration-strategy.test.ts` (brief/observation formatting, pair
  validation, tool allow-list invariants) and a `tool-display` mapping test.

While the flag is off, nothing is registered and no worker call is ever made.

## Deliberately out of scope (follow-ups)

- **Local worker routing.** Today the worker is whatever `orchestrationWorkerModel` says
  (which may be an `lmstudio:` model); it does not reuse `buildSubagentRoute`'s
  local-with-cloud-fallback logic or the `localFallback` card stamp.
- **Dedicated worker cost line.** Worker tokens fold into the run's aux-model usage line
  (via `addSubagentUsage`), same as the advisor; splitting them out per strategy is the
  same tracked follow-up.
- **Pair-validation surfacing.** `validateOrchestrationPair()` is implemented and tested
  but not yet shown in the settings UI (mirrors the advisor's pending pair-validation UX).
- **Prompting/timing.** System-prompt steering for when the parent should orchestrate vs.
  edit directly (today the tool description carries all the steering), a per-turn cap on
  delegated steps, and combining with the advisor (orchestrator consults the advisor,
  delegates to the worker).
