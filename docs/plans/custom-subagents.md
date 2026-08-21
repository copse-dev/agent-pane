# Custom subagents from `.claude/agents`

Status: **Active (P1 + P2 landed)**. Discovery, Settings visibility, and explicit
`/name` invocation are implemented. Automatic delegation (P4) and the remaining phases
are still design only. Owns
[#1819](https://github.com/copse-dev/agent-pane/issues/1819) ("I want to use agents that
are in my `~/.claude/agents` when using copse").

Related: [orchestration-pattern.md](orchestration-pattern.md) (the `delegate_step` worker
seam this reuses), [advisor-strategy.md](advisor-strategy.md),
[hooks-and-feature-packs.md](hooks-and-feature-packs.md) (the `subagentStart` /
`subagentStop` hook events a custom agent fires),
[agent-plugins-migration.md](agent-plugins-migration.md) (where a plugin-supplied
`agents/` slot lands).

## What the request actually is

A subagent definition is a Markdown file with YAML frontmatter — `name`, `description`, an
optional model, an optional tool list — whose body is the subagent's system prompt. Three
products now ship the format, and they already read each other's directories:

|                     | Claude Code                                                                                                                                                                                        | Cursor (2.4+)                                                                                                                   | Codex                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Project dir         | `.claude/agents/`                                                                                                                                                                                  | `.cursor/agents/`, and also `.claude/agents/` + `.codex/agents/`                                                                | `.codex/agents/`                                                                   |
| User dir            | `~/.claude/agents/`                                                                                                                                                                                | `~/.cursor/agents/` (+ the other two)                                                                                           | `~/.codex/agents/`                                                                 |
| Format              | Markdown + YAML frontmatter                                                                                                                                                                        | Markdown + YAML frontmatter                                                                                                     | **TOML**                                                                           |
| Fields              | `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation`, `color`, `initialPrompt` | `name` (defaults to the filename), `description`, `model` (`inherit` or `id[fast,effort,context]`), `readonly`, `is_background` | `name`, `description`, `model`, `model_reasoning_effort`, `developer_instructions` |
| Precedence          | project > user > plugin                                                                                                                                                                            | `.cursor` > `.claude`/`.codex`; project > user                                                                                  | —                                                                                  |
| Explicit invocation | `@agent-name`                                                                                                                                                                                      | **`/name rest of the task`**                                                                                                    | name it in the prompt                                                              |

Sources: [Claude Code subagents](https://code.claude.com/docs/en/sub-agents),
[Cursor subagents](https://cursor.com/docs/subagents),
[Codex subagents](https://simonwillison.net/2026/Mar/16/codex-subagents/).

Copse already ships subagents, but they are **hardcoded**: `explore`
(`src/main/tools/explore-tool.ts`), `investigate_ci`, `delegate_step`, the advisor, and
the post-turn review. Each is a distinct native tool with a fixed system prompt and a
fixed tool allow-list, all driven by one shared loop, `runSubagent()` in
[`packages/agent/src/run-subagent.ts`](../../packages/agent/src/run-subagent.ts). There is
no user-authored subagent of any kind, and nothing reads an `agents/` directory.

### Which backend this is for

Copse runs two kinds of agent, and the gap is only in one of them:

- **External ACP agents (Claude Code, cursor-agent, …).** Claude Code already loads its
  own `~/.claude/agents` and `.claude/agents` when Copse spawns it, including under the
  macOS seatbelt: `KNOWN_ACP_AGENTS` declares `homeDirs: ['.claude', …]`
  (`src/shared/acp-known-agents.ts`), which the project sandbox turns into an explicit
  `allowRead`/`allowWrite` for that subtree (`src/main/project-sandbox/config.ts`).
  **Nothing to build here** beyond visibility (P1) — and this is worth confirming on a
  real GUI machine before writing code, because if it were blocked the fix would be a
  sandbox rule, not a feature.
- **Copse's native agent** (the main-process loop that talks to providers directly). This
  is where the feature belongs, and everything below is about it.

## Shape of the change

Mirror the **skills registry**, which already solves the same problem for a different
artifact: discover Markdown-with-frontmatter from `.cursor` / `.agents` / `.claude`
containers at user and project scope, cache it, expose it over IPC to a Settings list, and
inject the body only when something invokes it
([`src/main/services/skills/skills-registry.ts`](../../src/main/services/skills/skills-registry.ts),
[`skill-prompt.ts`](../../src/main/services/skills/skill-prompt.ts)).

Then hand the parsed definition to the loop Copse already has:

```
.copse|.cursor|.claude       agents-registry        task tool          custom-agent-runner       runSubagent()
  /agents/*.md          ──►  (parse, precedence, ──► (registered   ──►  (ALS-scoped ctx,     ──► (existing loop:
  (project + user)            trust, cache)           only for a         tool filter,             hooks, usage,
                                                      turn that          model resolve)           stream chunks)
                                                      invoked one)
```

Five new modules, one widened union, one new tool. No new agent loop.

## Decisions log

Binding once this plan is accepted; divergence updates this file in the same PR.

### 1. Explicit invocation only in v1 — no automatic delegation

The parent model is **not** told which agents exist. There is no `<available_agents>`
catalog block in the system prompt, so the model cannot decide on its own to spend a turn
inside someone's `code-reviewer`. Delegation happens because the user asked for it.

This is the single most load-bearing decision here, and it collapses most of the risk in
the rest of the feature: no unattended spend, no `description`-driven behaviour change,
no untrusted third-party text in the system prompt of every turn, and no new
`context-estimate.ts` accounting. Automatic delegation stays a follow-up (P4) with its own
eval pass — it is the part that needs a gate, not discovery.

### 2. `/agent-name` invocation, sharing the existing slash namespace

Cursor's syntax is `/verifier confirm the auth flow`; Claude Code's is `@agent-name`.
Copse already has the `/` machinery — `resolveSkillInvocation`
([`parse-skill-invocation.ts`](../../src/shared/skills/parse-skill-invocation.ts)), the
picker's token-boundary scan (`skill-picker.ts`), and the `invokedSkills` payload through
`input-bar.ts` — and `/` reads as "run this named thing", which is what a subagent is. So:
generalise the slash surface from skills to **invocables** (`{ name, description, kind:
'skill' | 'agent' }`), tag the rows in the picker, and let `/name` resolve either.

One namespace means one collision rule: names are unique across skills and agents
together, skills win (they are the incumbent surface, so no existing `/name` changes
meaning), and the shadowed agent is listed in Settings with the reason. Do not invent
`/agent-<name>` disambiguation — a user who hits this renames one file.

The merge point is the **resolver**, not just the picker: `parseSkillInvocation` accepts
any leading `/name` without consulting known names, and `input-bar.ts` then toasts
"Unknown skill: /x" — so without changing that seam, `/reviewer` dead-ends as an unknown
skill before agent resolution could ever run. `resolveSkillInvocation` becomes
`resolveInvocation` over the merged list (keeping the longest-first scan), the toast copy
becomes invocable-aware, and `invokedSkills` must never silently receive an agent name.
One invocation per message in v1, matching today's single-match behaviour; mixing
`/reviewer` with a skill in one message stays undefined until someone needs it.

Two ways to make invocation actually delegate, in preference order:

1. **Turn-withheld tool + directive.** `task` is registered **once** with a static
   schema (`subagent_type: string`, `prompt: string`) — the registry is a process-wide
   singleton created at boot (`src/main/index.ts`), shared across concurrent threads, so
   a per-turn registration or a per-turn schema enum would race between threads. Instead,
   `parentTools` withholds it except on a turn that invoked an agent — the exact
   precedent is `read_terminal`, registered always but filtered out while the chat has no
   open shell (`agent-service.ts`) — and the runner validates `subagent_type` against the
   turn's invoked agent (ALS context) at execute time. A turn directive tells the model:
   the user invoked this agent, delegate to it before answering. The parent still
   integrates the result, which is what makes the summary useful, and the whole
   streaming/card path is the existing one.
2. **Pre-invoke deterministically.** If evals show the model skipping the directive, run
   the subagent before the parent's first LLM call with the remainder of the line as its
   prompt, and hand the parent the summary. Slower to build, guarantees the run.

Start with (1); (2) is the fallback, not a v2 feature.

**Eval result (2026-08-21): (1) did not hold; (2) is implemented and verified.** Three runs of
`tests/e2e/scenarios/custom-subagent-invocation.json` on a GUI machine against
`lmstudio:qwen/qwen3.5-9b`, driving the real Electron app with a definition seeded at
`~/.claude/agents/`. Every run failed the same way — `missing required tool: task` — with
the model answering directly (observed instead: `explore`, `read_file`,
`read_staged_thread`, `run_shell`, `git_status`). A temporary main-process probe confirmed
the wiring was not at fault:

```
optionAgent=copse-eval-reviewer resolved=copse-eval-reviewer
discovered=["copse-eval-reviewer"] taskOffered=true
```

Discovery, the renderer's `invokedAgent`, main's re-resolution, and the offered toolset
were all correct; the model simply declined to delegate. Disabling the built-in `explore`
subagent (`COPSE_EVAL_SUBAGENTS=0`) did not help — the model used `read_file` and answered
itself instead. A directive is a request, and an explicit invocation must not be one:
when the user names an agent, the run has to be deterministic. Caveat on scope: this is
one 9B local model, and a frontier model may well comply — but a feature whose contract is
"this runs when you ask for it" cannot depend on which model is selected.

**Verification of the deterministic path.** The same scenario passes on the same machine
and model, and the run is now asserted rather than eyeballed: `assertSubagents.require`
(added to the eval scenario contract) matches on `kind`, `agentName`, `status` and summary
text, so a run that fires the wrong definition — or fires one that dies — fails. It was
checked against the two captured artifacts before being trusted: it fails the
pre-change run (`explore` only) and passes the deterministic one
(`custom:copse-eval-reviewer`).

The final run shows the whole path working end to end:

- the card is `task / kind=custom / agentName=copse-eval-reviewer`, fired by the turn
  rather than chosen by the model;
- the agent used `read_file`, so its `tools: Read, Grep` survived translation;
- its report opens with the marker line the definition's body demands, which is direct
  evidence the Markdown body became the system prompt; and
- the report correctly names the seeded off-by-one bug in the format the body specified.

**The eval earned its keep by finding a real bug.** An earlier run passed the identity
assertion while the agent reported that "no file content was provided" — it had run with
_no tools at all_. Its candidates were being intersected with the parent turn's offered
set, which sounds like a safety property but is not one: with subagents enabled the parent
has no `read_file`/`search_*`, because it delegates reads to `explore`. Candidates now
come from the registry, as `explore`'s already did, with read-only still filtering them.
See the regression test in `custom-agent-strategy.test.ts`.

Remaining caveat: this is one 9B local model on one small scenario. It demonstrates the
contract holds and the pieces connect, not that agents produce good reviews in general.

### 3. Default on, with a disable switch later

No feature-pack gate. With discovery-driven delegation out of scope (decision 1), what
ships is: files the user wrote appear in a picker and run when the user picks them. That
is the same bar as skills, which are discovered and usable by default.

If a kill switch is wanted later it is a one-line setting mirroring `skillsEnabled`
(`agentsEnabled`), read at the top of `discoverAgentsRegistry()`. Do not build it
speculatively.

### 4. Read every Markdown container; treat Codex TOML as separate work

Roots, highest priority first:

| Priority | Root                            | Source tag |
| -------- | ------------------------------- | ---------- |
| 1        | `<workspace>/.copse/agents/**`  | `project`  |
| 2        | `<workspace>/.cursor/agents/**` | `project`  |
| 3        | `<workspace>/.claude/agents/**` | `project`  |
| 4        | `~/.copse/agents/**`            | `user`     |
| 5        | `~/.cursor/agents/**`           | `user`     |
| 6        | `~/.claude/agents/**`           | `user`     |
| 7        | plugin `agents/` (P5)           | `plugin`   |

Scanned recursively, so `agents/review/security.md` works. On a duplicate `name` the
highest-priority definition wins and the loser is logged and shown in Settings — the
first-writer-wins mechanic the skills registry already uses. Project-beats-user and
own-container-first both match what Cursor and Claude Code do; the **root order is
reversed relative to skills**, which put user roots first. Comment the divergence at the
ordering site so the next reader does not "fix" it into consistency.

`.copse/agents` is the native path, consistent with `.copse/hooks.json`, and it is the
same file format — nothing about the parser branches on which container a file came from.

`.codex/agents/*.toml` is a **different format** (TOML, with `developer_instructions`
rather than a Markdown body). It is a self-contained follow-up: one more parser feeding
the same registry, no change to anything downstream. Out of v1.

Reuse the skills scan's hard-won guards by extracting them rather than copying:
`SKIP_DIRS`, `MAX_SKILL_ROOT_DEPTH`, and the nested-`.git` bail (which is what stops a
`.claude/worktrees/*` checkout — including this very worktree — from re-reporting every
definition as a duplicate). See "Known traps" below.

### 5. Parse a subset; never silently drop a field that narrows capability

Supported in P2: `name`, `description`, `tools`, `disallowedTools`, `model`, `readonly`,
`maxTurns`, `color`.

`name` defaults from the filename **only in `.cursor`/`.copse` containers** (Cursor's
rule). In `.claude/agents`, a file without `name` is documentation and is skipped
silently (Claude Code's rule) — applying the filename default there would turn a stray
`README.md` into an agent named `readme` that Claude Code itself correctly ignores. Each
container keeps its own format's convention.

Mapped rather than honoured literally:

- Cursor's `readonly: true` and Claude's `permissionMode: plan` both → run the subagent
  under `runWithAgentRunReadonly(true, …)`
  (`src/main/services/agent-run-readonly.ts`), Copse's existing "no mutations this run"
  scope. The two ecosystems converge here, which is a good sign the mapping is right.
- `permissionMode: acceptEdits | dontAsk | auto | bypassPermissions | manual` →
  **ignored, always**. A file on disk does not get to relax Copse's permission gate,
  staged-edit review, or the sandbox. This is the security stance for the whole feature: a
  definition's tool list can only ever _narrow_ what the parent turn could already do.
- `isolation: worktree` → not supported yet (Copse's worktree work is
  [thread-worktrees.md](thread-worktrees.md)). Register the agent, but stamp "runs without
  worktree isolation" on the Settings row and the subagent card, because an agent written
  to expect a throwaway checkout will edit the real tree.
- `is_background` / `background` → ignored in v1; Copse's equivalent is the background
  task supervisor, not a subagent flag.

Ignored with a visible note in the Settings row (never silently): `mcpServers`, `hooks`,
`memory`, `effort`, `model_reasoning_effort`, `initialPrompt`, `skills`. Each is a
plausible follow-up; none is needed to close #1819.

Skip rules follow Claude Code so the same file stays valid in both: `name` starting with
`-` or containing `:` → skipped with a warning (`:` stays reserved for plugin scoping);
unparseable frontmatter → skipped with a warning; no `description` → registered but
flagged, since Cursor treats `description` as optional and v1 does not need it for
delegation anyway. Skipped files and their reasons are listed in Settings, because a
silently missing agent is the worst outcome for the user who filed this issue.

The parser is a new `parse-agent-frontmatter.ts` reusing `splitSkillMarkdown()` and the
YAML scalar/list helpers from
[`parse-skill-frontmatter.ts`](../../src/main/services/skills/parse-skill-frontmatter.ts)
(extract the shared half; do not add a YAML dependency for this).

### 6. Tool names are translated, and the result is a filter, never a grant

Claude Code tool names map to Copse native names:

| Claude                       | Copse                                                 |
| ---------------------------- | ----------------------------------------------------- |
| `Read`                       | `read_file`                                           |
| `Write`                      | `write_file`                                          |
| `Edit` / `MultiEdit`         | `str_replace`                                         |
| `Glob`                       | `find_files`                                          |
| `Grep`                       | `search_code`, `search_codebase`                      |
| `Bash`                       | `run_shell`                                           |
| `WebFetch`                   | `fetch_url`                                           |
| `WebSearch`                  | `web_search`                                          |
| `TodoWrite`                  | `update_todos`                                        |
| `NotebookEdit`               | — (dropped with a note)                               |
| `mcp__srv`, `mcp__srv__tool` | pass through — Copse already names MCP tools `mcp__…` |

Unknown names are dropped with a note on the row, not treated as an error.
`disallowedTools` is applied first, then `tools`, matching the documented order. Cursor
definitions carry no tool list at all, so they always take the inherit path below.

With `tools` omitted, the agent inherits the parent turn's tool set **minus**: the
subagent entry points (`task`, `explore`, `investigate_ci`, `delegate_step`, `advisor`,
`compare_models` — no nesting, depth stays 1), `ask_user` (a subagent reports back instead
of interrogating the user, as the orchestration worker already does), and `git_commit`
(integration stays with the parent, same rationale as `delegate_step`).

Whatever survives, every inner call still goes through `ToolRegistry.execute` — permission
gate, read-only enforcement, staged-edit approval, sandbox — exactly as `explore` and
`delegate_step` do today.

### 7. Model resolution defaults to inherit, and every fallback is visible

`model` defaults to `inherit` → the parent turn's provider and model, which is what
`explore` does when no subagent route is configured. An alias (`sonnet`, `opus`, `haiku`,
`fable`) or a full model id resolves through the existing catalog and `buildProvider`; if
it cannot be resolved with the user's configured providers, the run falls back to the
parent model and stamps the card — the `localFallback` precedent on `SubagentSession`
exists precisely because a silent downgrade is indistinguishable from an intentional
route. Cursor's `id[fast,effort,context]` parameter suffix is parsed off and dropped in
v1 (noted on the row); a Cursor-only model id will simply not resolve and fall back.

Local subagent routing (`buildSubagentRoute`, `localSubagentsEnabled`) applies only to
`inherit`; an explicit `model` in the file is the user's choice and wins.

`maxTurns` clamps the loop's `maxSteps`, itself capped by the existing
`defaultMaxLlmCallsForSteps` ceiling so a definition cannot buy unbounded spend. Usage
folds into `addSubagentUsage` like every other subagent.

### 8. Untrusted at project scope

An agent definition is a system prompt plus a tool list; a cloned repo shipping
`.claude/agents/helpful.md` is prompt-injection material. Explicit-only invocation
(decision 1) removes the worst case — the model never reads an attacker's `description`
unprompted — but the body still becomes a system prompt when the user picks the agent, so
apply the skills trust model (`isTrustedSource` in `skill-prompt.ts`):

- `user` source → trusted; `project` and `plugin` → untrusted.
- An untrusted agent's body is wrapped in the untrusted-content preamble
  (`UNTRUSTED_SKILL_GUIDANCE`'s wording) before it becomes the subagent's system prompt.
- The picker row shows the source, so `/reviewer` from a clone is visibly not the user's
  own `/reviewer`.
- Project-scoped agents additionally require `isWorkspaceTrusted()`, matching project
  hooks and project MCP servers. Opening an untrusted clone must not arm its agents.

Note that `.claude/agents` is already in `DANGEROUS_CONFIG_DIR_NAMES`
(`src/main/project-sandbox/config.ts`), so the agent cannot write its own definitions —
add `.copse/agents` and `.cursor/agents` there for parity. Any future "create an agent for
me" flow goes through IPC and the user, not through `write_file`.

### 9. One new session kind, and the card names the agent

`SubagentSession['kind']` (`packages/agent/src/wire-types.ts`) gains `'custom'`, plus an
optional `agentName` and `color`. Both the streamed chunk and the persisted
`SpineSubagentRef` (`src/shared/threads/spine-schema.ts`) carry them; the fields are
optional, so threads written before this change decode unchanged. `NO_SUMMARY_FALLBACK`
gains a `custom` entry. `tool-display.ts` labels `task` from its `subagent_type` argument
("Running the code-reviewer agent" / "Ran the code-reviewer agent") rather than a static
string.

## Phases

Each phase is independently shippable and independently useful.

**P1 — Discovery and visibility (no behaviour change). Landed.**
`src/main/services/agents/agents-registry.ts` + `parse-agent-frontmatter.ts`, an
`agents:list` IPC handler beside `skills:list`, and an **Agents** section in Settings →
Sources listing name, description, source tag, path on hover, ignored/unsupported fields,
shadowed duplicates, and skipped files with reasons. Nothing reaches the model. This alone
answers "does Copse see my agents?" and is the smallest thing that can land.

Shipped as: `src/main/services/agents/{agents-registry,parse-agent-frontmatter,translate-tool-names}.ts`,
`src/shared/types/agents.ts`, the `agents:list` IPC + preload bridge, and the Settings →
Sources **Agents** section. The scan guards and the YAML reader were **extracted**, not
copied, into `src/main/services/discovery/{container-scan,yaml-frontmatter}.ts`; the skills
registry now uses the same code, and its existing tests held green through the move.
`discoverAgentsFromRoots()` takes its roots as a parameter so both halves are testable at a
real boundary rather than through a test-only escape hatch.

**P2 — Explicit invocation (the feature). Landed.** Generalise the slash picker and
`resolveSkillInvocation` to invocables; `invokedAgent` through the run payload; the `task`
tool (registered once, withheld in `parentTools` except on invoking turns — see
decision 2); `custom-agent-runner.ts`
(ALS-scoped context, like `explore-subagent-runner.ts`, so fanned-out calls do not cross
wires); tool translation + filtering; model resolution; session kind + card. Hook parity
comes free — `runSubagent` already fires `subagentStart` / `subagentStop` with the
subagent type as the matcher, so a user's hooks can gate a custom agent by name on day
one.

Shipped as: `src/shared/invocation/parse-invocation.ts` (the merged `/` namespace),
`src/main/services/agents/custom-agent-{strategy,runner}.ts`, `src/main/tools/task-tool.ts`,
`invokedAgent` through the run payload, `kind: 'custom'` + `agentName` on `SubagentSession`
(both optional, so older threads decode unchanged), and a dynamic `task` card label.
Read-only mode **allows** `task`: the read-only scope is ALS-based and covers everything
the run awaits, so a subagent's own calls are gated by the same allow-list — withholding
the entry point would only block a read-only reviewer agent for no safety gain, unlike
`delegate_step`, whose purpose is to write.

**P3 — Codex TOML.** One extra parser feeding the same registry
(`.codex/agents/*.toml`, `~/.codex/agents/`), mapping `developer_instructions` to the
body and `model_reasoning_effort` to the ignored-with-a-note list.

**P4 — Automatic delegation (gated).** The `<available_agents>` catalog block with trust
attributes, its `context-estimate.ts` accounting, an always-registered `task` tool, and a
setting to turn it off. This is the part that gets an eval pass before it defaults on.

**P5 — Plugin-supplied agents.** An `agents/` slot for Agent Plugins packages under the
`dev.copse` extension namespace, with `plugin:agent` scoped names, per
[agent-plugins-migration.md](agent-plugins-migration.md).

**P6 — Deferred fields.** `skills` preloading (Copse has `buildInvokedSkillsBlock`, so
this is cheap), per-agent `mcpServers`, `memory`, `isolation: worktree` once thread
worktrees land, and injecting definitions into non-Claude ACP agents the way invoked
skills are injected today.

## Known implementation traps

Two of these were found by implementing P1; the rest are still predictions.

- **(Found in P1) A README in an agents folder is documentation, not an error.** The first
  cut reported every file without valid frontmatter as "skipped", which put a red row
  against a perfectly normal `README.md`. The rule that survives: a file that never opens a
  `---` block is documentation and is silent; a block that opens and never closes is a real
  mistake and is reported. Only the second reaches a Settings row.
- **(Found in P2) The submit path is microtask-counted by tests.** `input-bar.test.ts`
  advances exactly two microtask ticks via `settle()`; resolving the agent catalog
  alongside the skill catalog added a tick and stranded one assertion. The re-fetch is
  correct — a stale cache would false-reject a newly added agent, which is why skills
  already re-fetch on submit — so the fix was to await a macrotask in that test.
- **(Found in P1) `createPendingApi` never settles unless overridden.** Three renderer
  tests stub the Sources endpoints one by one over a never-settling API double, so adding a
  sixth endpoint to `refreshSources` hung `Promise.all` and failed 26 assertions in files
  that had nothing to do with agents. Any future Sources endpoint must be added to
  `settings-sources-hooks`, `settings-plugins`, and `settings-cursor-plugins` in the same
  commit.

- **The worktree duplicate trap.** A recursive project scan for `.claude/agents` finds
  `.claude/worktrees/<branch>/.claude/agents` — the same files on another branch. The
  skills scan already bails on a nested `.git` (file _or_ directory, because a worktree's
  is a file); reuse that bail, do not re-derive it.
- **Six roots, one name.** With `.copse` / `.cursor` / `.claude` at two scopes, a user who
  keeps their agents in sync across tools will hit duplicates constantly. Resolution must
  be silent-but-visible: no console spam per file, one Settings row per shadowed
  definition.
- **The slash namespace is now shared.** `resolveSkillInvocation` scans known names
  longest-first to avoid false positives on paths; the merged list must preserve that
  ordering property, and `invokedSkills` must not silently receive an agent name. The
  leading-slash path (`parseSkillInvocation`) matches _any_ `/name` and currently toasts
  "Unknown skill" — the merge has to happen before that toast, not after.
- **One registry, many threads.** The tool registry is a boot-time singleton shared by
  every concurrent thread. Nothing about `task` may be turn-specific at the registry
  level — not registration, not schema. Turn scoping lives in `parentTools` (offering)
  and the ALS runner context (validation), the same split `read_terminal` and `explore`
  already use.
- **`task` does not join `SUBAGENT_ENTRY_TOOLS`.** That set hides tools when
  `subagentsEnabled` is off, but custom agents are deliberately independent of that
  setting (decision 3's gating stance) — adding `task` there would silently disable the
  feature for the default configuration. Its withholding rule is its own.
- **Registry refresh.** The registry refreshes on workspace change; a turn that captured a
  name must validate it at execute time and return a clear "unknown agent" string rather
  than throwing.
- **Frontmatter parsing is hand-rolled on purpose.** `splitSkillMarkdown` scans line by
  line because a `---` inside a fenced code block used to terminate the frontmatter early.
  Reuse it; a naive `split('---')` reintroduces the bug.
- **Read-only mode.** `task` itself must be classified in `readonly-tools.ts`; a custom
  agent with edit tools is not read-only, but one resolved from `readonly: true` /
  `permissionMode: plan` is.

## Validation

Per [AGENTS.md](../../AGENTS.md) and [testing-strategy.md](../testing-strategy.md):

- Unit: frontmatter parsing (valid, each skip rule, CRLF, quoted scalars, filename-derived
  `name`), precedence and duplicate resolution across all six roots, the
  worktree/`SKIP_DIRS` bail, tool-name translation including `disallowedTools`-before-
  `tools` and `mcp__*` patterns, model resolution and fallback, trust tagging, skill/agent
  name-collision resolution, and a test for any exported type predicate.
- Component/visual: a focused WebdriverIO spec for the Settings → Sources → Agents list
  (including a skipped-file row and a shadowed duplicate), one for the picker showing
  skill and agent rows together, and one for the `task` subagent card showing the agent's
  name — user-visible changes need visual evidence, and all three are DOM-only.
- Agent-loop: one `agent-run-eval` scenario where `/reviewer …` against a seeded
  `~/.claude/agents` definition delegates and returns its summary to the parent.
- `pnpm run check` before commit; `pnpm run oracle` to pick the tier.

## Resolved questions

- **Default on?** Yes (decision 3). The risk that would have justified a pack gate lives
  entirely in automatic delegation, which v1 does not do.
- **`.copse/agents`?** Yes, plus `.cursor/agents` (decision 4) — same format, different
  import path. Codex is TOML and is its own phase.
- **`@` or `/`?** `/`, matching Cursor and Copse's existing skill picker (decision 2).
- **Automatic delegation in v1?** No (decision 1); it is P4, behind its own eval pass.
