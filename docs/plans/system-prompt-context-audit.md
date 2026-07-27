# System-prompt audit: the Claude 5 context-engineering rules

Status: **Proposed** — findings only. No prompt text changes in this pass; every recommendation
below is a proposal awaiting its own issue or PR.

## What this is

Anthropic's [_The new rules of context engineering for Claude 5 generation models_](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
(Thariq Shihipar, July 2026) lists six context-engineering practices that became myths with the
Claude 5 generation. The argument is that scaffolding written for weaker models is now a liability:
it costs tokens, constrains exploration, and crowds out judgment the model already has.

This document audits Copse's prompt surface against that post and records what a future
per-provider prompt split would need. It changes nothing.

One framing note before the findings, because it shapes every recommendation here. The post is
explicit that harness builders are not the audience for wholesale deletion:

> A system prompt is heavily tied to the product context. It tells Claude what product it's
> operating in and what it's doing. For Claude Code, you will likely never modify this, but **if you
> are building your own agent harness, this is where you should spend a lot of time.**

Copse is an agent harness. So the goal below is not "make the system prompt as short as possible" —
it is to remove text that is _duplicated_, _stale_, or _substituting for interface design_, and to
keep the text that establishes product context.

## The six shifts, and how Copse measures up

| Then → Now (the post's own framing)                 | Verdict for Copse                                                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Give Claude rules → **Let Claude use judgement**    | **Mixed.** An 8-step file-modification procedure and several absolute bans encode taste the model already has. |
| Give Claude examples → **Design interfaces**        | **Good.** No few-shot examples anywhere; tool schemas already use enums and discriminated unions.              |
| Put it all upfront → **Use progressive disclosure** | **Good for skills and packs, weak for tools.** Skills load on invoke; all tools ship their full definitions.   |
| Repeat yourself → **Simple tool descriptions**      | **Poor — the main finding.** A hand-written tool roster duplicates every tool description, and has drifted.    |
| Memory in CLAUDE.md → **Auto-memory**               | **Partial.** `copse.okf-memories` exists but ships off by default.                                             |
| Simple specs → **Rich references**                  | **Already aligned.** Copse prefers code, diffs and test output as references over prose specs.                 |

The fourth is worth quoting, because it describes Copse's current prompt almost exactly:

> …our system prompt would sometimes have references to tools in the main system prompt as well as
> instructions in the tool description. We found we could delete these repeat examples and put
> instructions on how to use tools in the tool descriptions rather than the system prompt.

## Where the prompt text lives

`buildSystemPrompt()` (`src/main/services/agent-system-prompt.ts:37-88`) concatenates, in order:

| #   | Source                                                       | Gate                                      |
| --- | ------------------------------------------------------------ | ----------------------------------------- |
| 1   | `BASE_SYSTEM_PROMPT` / `BASE_SYSTEM_PROMPT_DIRECT_READS`     | `subagentsEnabled`                        |
| 2   | `EXTERNAL_API_SAFETY_BLOCK`                                  | `externalApiSafety` setting (default off) |
| 3   | `BROWSER_TOOLS_BLOCK`                                        | `browserToolsEnabled` (default on)        |
| 4   | `READ_TERMINAL_BLOCK`                                        | setting on **and** thread has open shells |
| 5   | `MEMORY_TOOLS_BLOCK`                                         | `copse.okf-memories` pack (default off)   |
| 6   | `PII_REDACTION_BLOCK`                                        | `copse.pii-redaction` pack (default off)  |
| 7   | `buildSkillsCatalogBlock()`                                  | any model-invocable skills discovered     |
| 8   | `buildInvokedSkillsBlock()`                                  | `/skill` invoked this turn                |
| 9   | `loadAgentRequestedRulesCatalog()`                           | `.cursor/rules/**` present                |
| 10  | `buildSemanticSearchPromptBlock()`                           | always                                    |
| 11  | Custom instructions                                          | user setting                              |
| 12  | Project instructions (`AGENTS.md` / `CLAUDE.md` / `.cursor`) | workspace                                 |

Beyond this there are roughly 45 other prompt sites: subagent prompts (`run-subagent.ts`,
`review-subagent.ts`, `orchestration-strategy.ts`, `advisor-runner.ts`, `model-comparison.ts`),
mid-turn steering (`agent-loop-guards.ts`, `hooks/step-boundary-hooks.ts`, `forced-planning.ts`,
`todo-steering.ts`, `search-routing.ts`, `commit-steering.ts`), pack blocks, the skills prompt
builder, and the managed-agent / ACP prompts.

## Measured size

Reproduce with the method in [Appendix: measurement](#appendix-measurement). Token figures are
estimates at ~3.8 chars/token, not tokenizer output.

| Section of `BASE_SYSTEM_PROMPT`    |     chars |    ~tokens |   share |
| ---------------------------------- | --------: | ---------: | ------: |
| Tool roster (`Available tools:` …) |     2,160 |       ~568 | **37%** |
| `When modifying files:` (8 steps)  |     1,144 |       ~301 |     20% |
| `SHARED_WORKING_STYLE`             |     1,284 |       ~338 |     22% |
| `GIT_BRANCH_SAFETY`                |       478 |       ~126 |      8% |
| `Tool choice:`                     |       362 |        ~95 |      6% |
| **Total**                          | **5,839** | **~1,537** |         |

`BASE_SYSTEM_PROMPT_DIRECT_READS` is 5,957c / ~1,568t with the same proportions.

Conditional blocks: `BROWSER_TOOLS_BLOCK` 859c (~226t), `READ_TERMINAL_BLOCK` 563c (~148t),
`EXTERNAL_API_SAFETY_BLOCK` 329c (~87t), `buildSemanticSearchPromptBlock()` 441–466c (~116–123t).

On a default profile — browser tools on, all prompt-bearing packs off — the fixed floor is roughly
**7,140 chars / ~1,880 tokens**, before any skill catalog, cursor rules, custom instructions, or
project instructions.

**Tool definitions cost more than the prompt does.** The 57 registered tools carry 14,358 chars
(~3,778 tokens) of `description:` text alone, before JSON schemas. A default profile ships 42 of
them — ~7,588 chars / ~1,997 tokens — so gating already withholds ~1,782 tokens. That means the
fixed per-turn context is roughly **half system prompt, half tool descriptions**, and any audit
that looks only at the prompt is looking at half the problem. See F11.

## Findings

### F1 — The tool roster duplicates every tool description, and has drifted (high)

**Shift: repeat yourself → simple tool descriptions.** `SHARED_TOOL_TAIL` plus the per-variant
`tools` slot (`src/main/services/agent-prompt.ts:25-41`, `90-94`, `107-115`) hand-write a prose
roster. Tool `description:` fields already go over the wire in the `tools` array
(`packages/llm/src/anthropic-provider.ts:52`, `openai-provider.ts:77`), so this is a second copy of
what the model already receives — the exact pattern the post describes deleting.

| Measure                                                | Count |
| ------------------------------------------------------ | ----: |
| Roster entries across both variants                    |    29 |
| Roster entries that duplicate a registered description |    29 |
| Registered tool descriptions                           |    57 |
| Registered but absent from the roster                  |    28 |

Every roster line is a duplicate, and the roster covers barely half the registry. The duplication is
often near-verbatim — the prompt's `run_shell: Run a shell command for tests, builds, installs, and
other tasks not covered by a dedicated tool (may prompt for approval; do not use for reading files
or searching code)` against `src/main/tools/shell-tool.ts:275`, which says the same and more.

Of the 28 unlisted tools, 11 are described by conditional blocks instead (`browser_*`,
`read_terminal`, `remember`, `recall`, `reveal_pii`, `read_skill`). The remaining 17 are advertised
nowhere, including four registered unconditionally at
`src/main/services/registry-bootstrap.ts:80-82,171` — `delete_file`, `rename_file`,
`make_directory`, `video_frames` — plus `gh_pr_files`, registered in the same `gh`-gated batch as
`gh_pr_list` and `gh_pr_view` (`registry-bootstrap.ts:299`), both of which _are_ listed.

**The drift runs the other way too, and that side is worse.** `BASE_SYSTEM_PROMPT` advertises
`investigate_ci` unconditionally (`agent-prompt.ts:91`), but the tool registers only when the
`copse.ci-investigator` pack is enabled _and_ `gh` is present (`registry-bootstrap.ts:339-342`) —
and that pack is default-off (`src/main/services/packs/pack-service.ts:83-95`). On a default install
the prompt names a tool the model does not have. The `gh_*` and `get_ci_*` lines have the same
shape: listed unconditionally, registered only when `gh` is on `PATH`.

A prose list headed `Available tools:` that is wrong in both directions is worse than no list. This
is a correctness issue, not only a token issue.

**Recommendation.** Delete the roster. Move the genuinely additive lines — the direct-apply versus
staged-for-approval semantics on `write_file` / `str_replace` — into those tools' descriptions.
Saves ~568 tokens per turn and removes the drift class entirely, because the registry becomes the
only source.

### F2 — `Tool choice:` is a third copy of the same steering (high)

**Same shift.** "Use `explore` / `read_file` — not `run_shell` (no `cat`, `grep`, `rg`, `find`,
`head`, or `tail`)" appears three times: in the roster line for `run_shell`, in `Tool choice:`
(`agent-prompt.ts:101-103`, `121-123`), and already in `shell-tool.ts:275`. Two of the three are
redundant. ~95 tokens.

### F3 — The 8-step file-modification procedure encodes judgment and restates tool output (medium)

**Shift: rules → judgement.** `agent-prompt.ts:71-79`. Step 6 opens "Read the tool result carefully:
if it says applied directly… If it says staged/pending…" — the tool result already says this, at the
moment it matters. Steps 2 and 7 narrate the staging model that `staged_diffs` reports directly.
Steps 3 ("Do not assume file content") and 4 ("Generated code must be runnable") are the kind of
taste the post reports Claude 5 no longer needs told. ~301 tokens.

Step 8 ("If a retry would not be informed by new information, stop and present your diagnosis") is
worth keeping — `agent-prompt.test.ts:62` shows it deliberately replaced an older two-strike rule,
so it encodes a decision, not a default.

### F4 — The two base variants are near-identical (medium)

`buildBasePrompt()` generates two prompts differing only in which read tools exist and whether
context comes from `explore` or direct reads. With the roster gone (F1) they collapse to nearly the
same text, and the distinction is already carried by which tools are in the array.

### F5 — Absolute and ALL-CAPS directives in the subagent and steering prompts (medium)

**Shift: rules → judgement.** Occurrences of `NEVER` / `ALWAYS` / `MUST` / `DO NOT` and lowercase
forms:

| File                                          | Hits |
| --------------------------------------------- | ---: |
| `packages/agent/src/run-subagent.ts`          |   13 |
| `src/main/services/skills/skill-prompt.ts`    |    8 |
| `src/main/services/agent-prompt.ts`           |    8 |
| `src/main/services/orchestration-strategy.ts` |    4 |
| `packages/agent/src/agent-loop-guards.ts`     |    4 |
| `packages/agent/src/review-subagent.ts`       |    3 |

The sharpest case is `OPEN_TODOS_FINALIZE_NUDGE_STRICT` (`agent-loop-guards.ts:67`): "You MUST
call update_todos now… Plain-text claims that work is done are not accepted." That one encodes a
real contract — the plan genuinely only mutates through the tool — so it stays. The filter is
whether the ban encodes a hard product, security, or protocol constraint. Most of
`run-subagent.ts`'s 13 are read-only reminders the filtered tool array already enforces.

### F6 — `TODO_STEERING_PROMPT` duplicates the todo tool's description (medium)

`packages/agent/src/todo-steering.ts:34-38` is a four-step numbered recipe;
`src/main/tools/todo-tool.ts:74-75` already says "Use for multi-step work only; mark one item
in_progress at a time." Steps 1, 2 and 4 restate it.

Note the opposite lesson in the same file. `todoInputSchema` (`todo-tool.ts:23-28`) uses
`z.enum(['pending','in_progress','completed','cancelled'])` and a discriminated union for `check` —
precisely the interface-design pattern the post recommends, using the same Todo-tool example it
gives. Copse already got this right; the prompt-side recipe is the redundant part.

### F7 — The search-routing block restates what the tools encode (low–medium)

`buildSemanticSearchPromptBlock()` — a thin wrapper (`src/main/services/search/semantic-search.ts:13-15`)
over `buildSearchRoutingPromptBlock()` (`packages/agent/src/search-routing.ts:54-69`) — hard-codes a
routing table: "exact symbol → `search_code`, concept → `search_codebase`". The tool descriptions
already state this, and `search_codebase`'s auto mode implements the same routing in code
(`search-routing.ts:45-51`), so the prompt is explaining a decision the tool makes for itself.
~116 tokens every turn.

### F8 — Subagent prompts re-list their allowed tools (low)

`SUBAGENT_SYSTEM_PROMPT` and `CI_INVESTIGATOR_SYSTEM_PROMPT` (`run-subagent.ts:52-75`),
`ORCHESTRATION_WORKER_SYSTEM_PROMPT` (`orchestration-strategy.ts:63-73`) and `REVIEW_SYSTEM_PROMPT`
(`review-subagent.ts:40-63`) each enumerate their permitted tools in prose and each say "do not
write files or run shell commands" — when the tool array handed to the subagent is already filtered
to read-only. The boundary is enforced by construction; the prose is belt-and-braces.

### F11 — Tool definitions are unconditionally loaded (medium–high, largest remaining upside)

**Shift: upfront → progressive disclosure.** The post applies this to tools, not just skills:

> …we also use it for tools. Some of our tools are 'deferred loading,' which means the agent must
> search for their full definitions using ToolSearch before using them. This allows us to have more
> tools (such as our Task tools) that don't take up context until they're needed.

Copse has no equivalent. Every registered tool ships its full description and schema on every turn.
Pack gating and per-turn withholding already do real work — ~1,782 tokens withheld on a default
profile — but the remaining 42 tools still cost ~1,997 tokens of description text before schemas,
which is more than the base system prompt.

The heaviest descriptions are `run_shell` (1,387c), `video_frames` (844c), `reveal_pii` (668c),
`read_terminal` (556c), `run_checkup` (553c), `delegate_step` (514c), `run_background` (509c). Several
are already conditionally registered; the pattern to consider is a search-then-load tier for the
long tail (`roadmap_plan`, `compare_models`, `suggest_model`, `track_long_task`, `advisor`) so
enabling a pack does not immediately cost its full schema on every turn.

This is the biggest remaining win after F1 and is architecture, not wording — it belongs in its own
issue, not in a prompt-trimming PR.

### F12 — This repository's own `AGENTS.md` is 22 KB (low, but it is our own dogfood)

The post's CLAUDE.md guidance:

> Keep your CLAUDE.md lightweight and briefly describe what your repo is for, but spend most of the
> tokens on gotchas inside of the codebase… Avoid stating 'the obvious' things Claude should know by
> looking at your file system or your repo. Use progressive disclosure heavily.

`AGENTS.md` is loaded into the system prompt by `project-instructions.ts` whenever Copse (or any
other agent) runs on this repo, and at 22 KB it is larger than everything in the table above
combined. Much of it _is_ gotchas, which is what the post asks for. But it also carries setup
narrative that belongs behind progressive disclosure. Out of scope for this audit — noted so it is
not forgotten.

### F9 — What should not be cut

Recorded so a future trim does not over-reach:

- The trust framing and anti-injection guidance in `skill-prompt.ts` (`buildSkillsCatalogBlock`,
  `UNTRUSTED_SKILL_GUIDANCE`, `externalLinkNotice`). A security boundary against
  attacker-controlled `SKILL.md` files from cloned repos and plugins, not model hand-holding.
- `PII_REDACTION_BLOCK` — placeholder semantics are non-obvious runtime state the model cannot
  infer.
- The sandbox-confinement guidance in `buildInvokedSkillsBlock`, which differs by whether seatbelt
  is actually active.
- `GIT_BRANCH_SAFETY` — a product constraint, not taste.
- The `REVIEW_JSON:` contract in `REVIEW_SYSTEM_PROMPT` — parsed by code.
- `SHARED_WORKING_STYLE`. Its comment (`agent-prompt.ts:8-11`) states the intent: "Copse runs many
  providers, and these rules are the lever that pulls all of them toward the same working contract."
  This is product context in the post's sense — the part a harness builder is told to spend time on.
  A candidate for the per-provider split below, not for deletion.

### F10 — Where Copse is already aligned

- **Design interfaces:** no few-shot examples anywhere in the prompt surface; tool schemas carry
  the meaning (F6).
- **Progressive disclosure (skills):** the catalog advertises name, description and trust only,
  with bodies loaded on `/`-invoke (`skill-prompt.ts:46-72`, `96-184`). Pack `promptBlocks` are
  enablement-gated, so a default profile pays for none of the memory, PII, roadmap or advisor text.
- **Rich references:** the agent works from diffs, test output and CI logs rather than prose specs.

## Prior evidence from this repository

`docs/spikes/terminal-bench-2.1-profile-ablation.md` already ran a version of this experiment on the
benchmark harness's own prompts. Across 534 scheduled trials the short `product-aligned@1` profile
used **37% fewer median total tokens and 25% fewer median tool calls** than the long
`main-legacy@1`, for a solve-rate difference of −1.12 points, 95% CI `[−6.74, +5.06]` — cheaper, no
measurable difference in outcome.

Two caveats before it is used as support. `main-legacy@1` remains the default because the short
profile did not _beat_ it on the precommitted held-out cohort. And those are benchmark prompts
(`scripts/lib/terminal-bench-profiles.mts`), not the product prompt audited here. The result
motivates the cuts; it does not pre-validate them.

## Recommended cuts, ranked

| ID  | Change                                                                | ~tokens/turn | Risk   | Validation                                                                |
| --- | --------------------------------------------------------------------- | -----------: | ------ | ------------------------------------------------------------------------- |
| F1  | Delete the tool roster; fold staging semantics into tool descriptions |         ~568 | Medium | Update `agent-prompt.test.ts` "includes … tool tail"; profile screen      |
| F3  | Cut steps 2, 3, 4, 6, 7 of the modify procedure                       |         ~180 | Medium | New assertions; profile screen                                            |
| F7  | Delete the search-routing block                                       |         ~116 | Low    | `search-routing` unit tests; confirm auto-mode routing still selects well |
| F2  | Delete `Tool choice:`                                                 |          ~95 | Low    | Update `agent-prompt.test.ts` "steers away from run_shell"                |
| F5  | Triage absolute bans in subagent prompts                              |         ~120 | Low    | Subagent behaviour spot-checks                                            |
| F8  | Drop prose tool lists from subagent prompts                           |          ~80 | Low    | Subagent behaviour spot-checks                                            |
| F6  | Trim `TODO_STEERING_PROMPT` to its non-duplicated line                |          ~60 | Low    | `todo-steering-prompts.test.ts` + fixtures                                |
| F4  | Collapse the two base variants                                        |            — | Low    | Falls out of F1                                                           |
| F11 | Deferred tool loading                                                 | up to ~1,000 | High   | Own design issue — architecture, not wording                              |

Excluding F11, that is roughly **1,100 of ~1,880** default-profile prompt tokens. F11 is separately
worth as much again on the tool side.

Two guardrails for whoever executes this. The post's results are reported for Claude 5 models;
Copse's supported floor includes local 7B-class models, so a cut validated only on a frontier model
is not validated for Copse (see below). And F1 should land with the drift check from the appendix
promoted to a unit test, or the same class of bug returns in whatever replaces the roster.

## Provider-specific notes for a later split

Recorded now, not acted on.

- **Delivery differs by provider.** Anthropic receives the system prompt as a top-level `system`
  array with `cache_control` breakpoints (`packages/llm/src/anthropic-provider.ts:25-45`,
  `150-170`); OpenAI-family providers inline it as `messages[0]` (`openai-provider.ts:197`,
  `responses-provider.ts:152-154`). Shortening the prompt shifts where cache breakpoints fall, so
  cache-hit behaviour should be re-checked alongside any cut, not after.
- **The floor is not Claude 5.** Copse routes to LM Studio, Ollama, llama.cpp, Jan and vLLM, plus
  small hosted models. The scaffolding being cut here is plausibly still load-bearing for those; a
  global cut justified by Claude 5 evidence would regress the low end silently.
- **A capability seam already exists.** `packages/llm/src/model-intellect*.ts` and
  `src/main/services/providers/model-classifier.ts` produce a capability signal, and
  `packages/agent/src/packs/forced-planning-pack.ts` already varies prompt behaviour below an
  intellect threshold. That is the natural place to hang a "verbose scaffold for weak models, lean
  prompt for strong ones" split — an intellect threshold rather than a provider check, since the
  axis is capability, not vendor.
- **`docs/plans/model-roles-and-defaults.md`** is the design doc such a split should extend.

## Appendix: measurement

Section sizes were measured by importing the prompt module directly. `agent-prompt.ts` re-exports
two pack constants through the `@copse/agent` path alias, which bare Node cannot resolve, so the
copy strips those two lines:

```bash
grep -v "^export { MEMORY_TOOLS_BLOCK" src/main/services/agent-prompt.ts \
  | grep -v "^export { PII_REDACTION_BLOCK" > /tmp/agent-prompt.mts
# then import /tmp/agent-prompt.mts under `node --experimental-strip-types`,
# slicing each exported prompt on its section headings and reporting `.length`
```

Tool-description totals come from parsing `name:` / `description:` pairs out of
`src/main/tools/*.ts`; the F1 duplication counts join those against the `- <name>: <text>` lines
parsed out of the roster. The default-profile subset excludes tools gated by a default-off pack or
withheld per turn.

**That join should become a unit test.** It is a pure comparison of two in-repo sources with no
network or model call, and it is what would have caught the `investigate_ci` and `gh_pr_files`
drift. Whether the roster survives F1 or not, an assertion that every tool named in the prompt is
registered under the same conditions is worth having.

Token counts throughout are estimates at ~3.8 chars/token, not tokenizer output. They are used to
compare sections against each other; treat absolute values as indicative.
