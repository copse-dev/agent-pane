# Agent loop efficiency guards

Tracking: [#1433](https://github.com/copse-dev/agent-pane/issues/1433). Items that do not
share code with the loop guards are split out: sandbox affordances to
[#1436](https://github.com/copse-dev/agent-pane/issues/1436), the doctrine rule to
[#1437](https://github.com/copse-dev/agent-pane/issues/1437), the `read_skill` errors to
[#1438](https://github.com/copse-dev/agent-pane/issues/1438), and the tool cache breakpoint
to [#1286](https://github.com/copse-dev/agent-pane/issues/1286). Motivating run:
thread `178909d1` ("Cmd+L Select Browser URL") — 43 minutes and 3.38M input tokens to
produce a 7-line change that did not work ([#1427](https://github.com/copse-dev/agent-pane/pull/1427),
fixed in [#1432](https://github.com/copse-dev/agent-pane/pull/1432)).

Status: **proposed.** No code landed yet. Fix 0 was reworked after review: the original
"give the parent a `read_file`" options are superseded by structured explore returns, which
keep `read_file` off the parent's tool list entirely.

## Why

The run was on `lmstudio:qwen/qwen3.6-35b-a3b`. That matters for prioritisation: these
guards are precisely what should keep a small local model on the rails, and every one of
them was either absent, misconfigured, or unreachable. The failure is not "the model is
weak" — the model followed the system prompt exactly and the prompt described an
impossible workflow.

Tool calls over the whole run:

| tool           | calls                               |
| -------------- | ----------------------------------- |
| `run_shell`    | 29                                  |
| `explore`      | 15                                  |
| `update_todos` | 9                                   |
| `read_skill`   | 4 (2 errored)                       |
| `str_replace`  | 2 (1 failed)                        |
| `read_file`    | 0 — **not offered in explore mode** |

## Root cause: explore mode has no way to obtain exact file bytes

This is the finding that explains the other symptoms, and it is a design gap rather than a
bug in any single function.

When `subagentsEnabled` is true, `parentTools` removes `PARENT_DELEGATED_TOOLS` from the
parent's tool set (`src/main/services/agent-service.ts:256-262`, `:299-302`):

```ts
export const PARENT_DELEGATED_TOOLS = [
  'read_file',
  'list_dir',
  'search_code',
  'search_codebase',
  'find_files',
] as const
```

So in explore mode the parent agent has:

- `str_replace`, whose contract requires a byte-exact `old_string`
  (`src/main/tools/str-replace-tool.ts`)
- `explore`, which is contractually a **summary** — _"Returns a concise summary instead of
  raw file contents. Use this instead of read_file or search tools."_
  (`src/main/tools/explore-tool.ts:7-8`), reinforced by the subagent's own system prompt:
  _"Your final message must be a structured summary the parent can use without re-reading
  files"_ (`packages/agent/src/run-subagent.ts:52-64`)
- **no tool that can return verbatim file content**

`run_shell` is the only remaining path, and the `toolChoice` prompt section explicitly
forecloses it: _"For reading files … use explore — not run_shell (no cat, grep, rg, find,
head, or tail for those jobs)"_ (`src/main/services/agent-prompt.ts`, `EXPLORE_MODE_VARS`).
The same block says _"Use explore to understand the file before changing it"_.

The prompt therefore instructs the model, three times over, to prepare an exact-substring
edit from a lossy summary. The 15-call loop was the model trying to satisfy that, appending
"exact whitespace", "exact lines", "including spaces and indentation" to successive queries
because rewording the request was the only lever it had:

```
"browser-pane.ts wireToolbar urlInput keydown handler wireToolbar implementation"
"...urlInput keydown enter handler implementation details"
"...exact code urlInput keydown handler Enter key"
"...exact whitespace"
"...exact lines 308-316 with exact whitespace"
"...exact lines with exact whitespace including spaces and indentation"
```

The seven subagent replies located `wireToolbar` at lines 266–295, 280–297, 254–268,
238–258, 288–302, 281–307, and 289–311. It is actually 289–309. The `str_replace` that
finally landed succeeded **by luck**: one subagent happened to paste the function verbatim
inside a fenced code block with correct indentation, and the parent copied it out.

The failure message compounds it — `str-replace-tool.ts:50` says _"Re-read the file and
copy the exact snippet to replace."_ In explore mode there is no tool that can do that.

### The bytes already exist — we discard them

Before reaching for a new tool, note where the exact text goes.

`runSubagent` returns `{ summary, session }`, and `session.messages[].toolCalls[]` records
every call the subagent made, including its verbatim `result`
(`packages/agent/src/run-subagent.ts:306-341`). The explore subagent reads files with
`read_file`; those exact bytes sit in the session object.

Then `src/main/services/subagent-service.ts:106-108`:

```ts
const usage = session.usage ?? { inputTokens: 0, outputTokens: 0 }
return { summary, usage }
```

The session is dropped, and `explore-tool.ts:19` returns `result.summary` — the last
assistant text. So the parent receives the model's _retelling_ of bytes the harness held
exactly, one layer down, in the same process, microseconds earlier. That is why seven
subagent replies gave seven different line ranges for one function: each was
re-describing something it had already read verbatim.

The fix is therefore not "give the parent a read tool". It is "stop throwing the reads
away".

### Fix 0 — explore returns structured results

`explore` returns one document with two halves, and `read_file` stays hidden from the
parent entirely:

- **Freeform judgement** — the prose summary as today. What the code does, where the seams
  are, what to change. Model-authored.
- **Deterministic candidates** — harness-extracted, model-untouched. For each `read_file`
  the subagent performed: path, line range, and the verbatim span. Optionally
  `search_code` / `search_codebase` hits with their exact matched lines, labelled as a
  different provenance so index hits are never presented as quoted source.

Precision on "structured": `ToolExecuteResult` is
`string | { result: string; resultFormat?: 'markdown'; … }`
(`packages/agent/src/wire-types.ts:86-98`). The model always receives text, so this means a
structured **document** — a summary section plus fenced excerpts tagged with path and line
range — not a typed object over the wire. That is sufficient: `str_replace` needs a fenced
span to copy, and the header can state that the excerpt is verbatim rather than
paraphrased.

Two properties fall out for free:

- **`read_file` never appears on the parent's tool list.** Explore is not merely the
  recommended first step, it is the only path to file content. No gate flag, no run-scoped
  state, no refusal message — the ordering is a consequence of where the data lives.
- **The duplicate guard gets a firmer signal.** Two explores returning the same excerpt set
  are duplicates regardless of how differently the queries were worded — see Fix 2, which
  otherwise has to reason about free text alone.

**Scope control.** The excerpt half must be bounded or it reintroduces the context cost
explore mode exists to avoid. Cap total excerpt bytes against the same budget
`readFileLimitsForSubagent` already computes (`subagent-service.ts:85`), prefer spans the
summary actually cites, and drop the rest with an explicit note rather than silently.

**Tests.** `subagent-service` unit test: a subagent that read two files yields two excerpts
with correct paths and ranges. Excerpt bytes are byte-identical to the file on disk (the
property the whole plan turns on). Budget test: excerpts over the cap are dropped with a
note, not truncated mid-span. Eval scenario: a small edit in explore mode reaches a
successful `str_replace` with `maxExplore: 3` and no `read_file` on the parent.

**Effort.** Moderate, and mostly plumbing that already exists — the data is collected, the
change is to stop discarding it and to render it. Blast radius is smaller than any option
that alters the parent's tool list.

### Fix 0b — route parent reads through the child's session (follow-on)

Once the session is retained, a parent-side read request can be served from it rather than
from disk. Two readings of "route through the child" behave very differently and only one
is wanted:

- **Route to the child's session state** — a lookup against spans exploration already
  pulled. No LLM call, deterministic, fast. This is the one.
- **Route to the child agent** — resume an LLM turn to fetch. Reintroduces summarisation
  and non-determinism, i.e. the original bug.

Value beyond the excerpts in Fix 0: widening context around a span already loaded, or
reaching a different part of a file exploration opened but only partly quoted — the
`explore_more` shape, as a read rather than a re-exploration.

When the parent asks for a path exploration never visited, the answer is _"not explored
yet — explore that path first"_, not a silent disk fallback. A fallback would quietly
restore general browsing and lose the enforcement property Fix 0 buys.

Scope note: prior `read_file` results are exact and safe to quote. Index hits from
`search_codebase` / `semantic_search` (`src/main/services/search/`) are a different
provenance and must be labelled as such.

### Rejected and deferred alternatives

- **Give the parent an explore-gated `read_file`.** Drop `read_file` from
  `PARENT_DELEGATED_TOOLS` and refuse to serve content until an explore has completed.
  Workable, and cache-safe because the tool list never changes, but strictly worse than
  Fix 0: it adds a tool, adds run-scoped gate state, and still hands the parent a general
  read primitive. Superseded — keep only as a fallback if structured returns prove
  impractical.
- **Reveal `read_file` dynamically when a subagent completes.** Feasible — `tools` is one
  array dereferenced fresh at each `provider.stream(messages, tools, signal)`
  (`packages/agent/src/run-agent-loop.ts:540`, `:1088`), and _"The tool list is fixed for
  the whole run"_ (`agent-service.ts:1029-1030`) is a design decision in a comment, not an
  enforced invariant. `setHookRunToolset` fingerprints once, which a mid-run change would
  make stale, but that is fixable by fingerprinting the superset. See "Tool-list churn and
  prompt caching" below for the real cost. Unnecessary if Fix 0 lands.
- **Add a verbatim mode to `explore`.** An `exact: true` / `quote_lines` parameter that
  bypasses the summarising subagent. Overloads a tool whose identity is "returns a
  summary" and gives the model a decision it will get wrong — Fix 0 delivers the same
  content without a mode flag.
- **Make `str_replace` tolerant of approximate input** — whitespace-insensitive matching,
  or a line range plus a fuzzy anchor. Does not fix the wrong line numbers, and silent
  fuzzy matching on edits is its own hazard. Worth revisiting later as independent
  hardening, not as the answer here.

Whichever path is taken, the `str_replace` failure message (`str-replace-tool.ts:50`) must
name something the agent can actually do. Under Fix 0 that is _"re-run explore for this
file and copy the verbatim excerpt"_, not _"re-read the file"_.

### Tool-list churn and prompt caching

Recorded because it decides how expensive any dynamic-tool design is, and the first
estimate here was wrong.

`packages/llm/src/anthropic-provider.ts:57-64` pins the tool cache breakpoint to the end of
the array:

```ts
// The last tool gets a cache breakpoint so the (large, stable) tool
// schemas are cached instead of re-sent every loop iteration (#582).
...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
```

Because the breakpoint tracks `tools.length - 1`, adding a tool moves it and the cached
entry cannot be reused — so mid-run injection currently costs the whole prefix. That is an
artefact of the pinning, not a property of caching. Pin the breakpoint to the last
**stable** tool and sort dynamic tools after it, and the stable-core prefix stays
byte-identical and hits on every step whether or not the dynamic tool is present;
revealing it then costs one tool schema plus the system block.

The same file already applies this exact reordering one layer up (`:28-36`): volatile
mid-conversation system messages are converted **last** with the breakpoint placed
**before** them, so the entry a request writes stays a byte-identical prefix of the next
turn's request (#1286). Anthropic allows four breakpoints, so there is room.

For OpenAI / OpenRouter automatic prefix caching (`promptCacheKey`,
`packages/llm/src/create-provider.ts:38`) the principle holds: appending preserves the
common prefix up to the insertion point. System and messages caching is lost, but messages
change every step anyway.

Conclusion: tool-list churn is cheap _if_ the breakpoint moves first, and expensive as the
code stands. Worth fixing on its own merits regardless of Fix 0, since it also makes the
tool list safe to vary for pack toggles and readonly mode.

### Subagent streaming (answered, no work proposed)

Subagents cannot stream into the **parent model's** context. A tool result is a single
message inserted after the assistant's `tool_call`; the wire format has no incremental tool
result, and the parent is blocked on `await executeTool` regardless, so it could not act on
partial output earlier.

Streaming to the **UI** already works — `onSubagentChunk` emits `subagent_text`,
`subagent_reasoning`, `subagent_tool_call`, `subagent_tool_result` as they occur
(`run-subagent.ts:288-341`).

Where a live channel would earn its keep is **supervision**, not context: watching a
subagent circle and cutting it off mid-flight, which is a control channel rather than a
data stream and overlaps the existing reasoning-circle detector. For the parent to pull
more after seeing a summary, the shape is a follow-up call against a retained session
(Fix 0b), not streaming.

---

## Fix 1 — `EXPLORE_TOOL_NAMES` does not contain `explore`

**Problem.** `packages/agent/src/agent-loop-guards.ts:5-11`:

```ts
export const EXPLORE_TOOL_NAMES = new Set([
  'list_dir',
  'read_file',
  'find_files',
  'search_code',
  'search_codebase',
])
```

`isDuplicateExploreCall` short-circuits on `EXPLORE_TOOL_NAMES.has(name)` (`:36`), so for a
tool named `explore` it returns `false` unconditionally. The guard never fired across 15
calls. The inconsistency is visible inside the call site: `run-agent-loop.ts:688`
special-cases `tc.name !== 'explore'` for parallel pre-execution, then passes the same call
to a duplicate check that cannot see it.

Note this set is also now partly vestigial in explore mode — four of its five entries are
delegated away from the parent. It is really "context-gathering tools", and should be
whichever tools the _current_ mode actually offers.

**Blocker: two different constants share this name.** Rename before touching either.

| file                                        | type         | meaning                                           |
| ------------------------------------------- | ------------ | ------------------------------------------------- |
| `packages/agent/src/agent-loop-guards.ts:5` | `Set`        | tool calls that count as duplicates               |
| `packages/agent/src/run-subagent.ts:26`     | `readonly[]` | tools the explore subagent is **allowed** to call |

`subagent-service.ts:41` builds the subagent's toolset from the second, and `:51` enforces
it as a hard allow-list (`Tool not allowed in explore subagent`). So "add `'explore'` to
`EXPLORE_TOOL_NAMES`" is ambiguous, and applying it to the wrong constant grants the
explore subagent the `explore` tool — recursive subagent spawning, a live capability
change rather than a no-op.

Rename first: `DUPLICATE_GUARDED_TOOL_NAMES` for the guard set,
`SUBAGENT_ALLOWED_TOOL_NAMES` for the allow-list. Mechanical, and it makes the rest of this
plan safe to hand to anyone.

**Change.** After the rename: add `'explore'` to the guard set (and `'semantic_search'`,
likewise missing). Do not add `'explore'` to the subagent allow-list.

**Tests.** `agent-loop-guards` unit test: two identical `explore` calls, second is flagged.
Guard against regression of the collision: assert the subagent allow-list does **not**
contain `explore` or `investigate_ci`, so a future edit cannot silently enable recursion.

**Effort.** One line plus a test. Ship first.

---

## Fix 2 — exact-JSON fingerprints cannot catch a paraphrasing loop

**Problem.** `toolCallFingerprint` (`agent-loop-guards.ts:13`) is `stableJson` over the
args, so two calls collide only if the argument bytes match. For a tool whose primary
argument is free text, seven rewordings of one question are seven fingerprints. Fix 1 is
necessary but not sufficient — with it alone, this run's 15 calls still produce 15 distinct
fingerprints and the guard still never fires.

**Change.** Normalise free-text args inside `normalizeExploreArgs`
(`agent-loop-guards.ts:25`), which already exists as the per-tool hook for exactly this and
currently only handles `list_dir`. For `explore`:

- lowercase, strip punctuation, drop a small stopword list (including the words this
  failure mode generates: `exact`, `exactly`, `precise`, `whitespace`, `indentation`,
  `lines`, `code`, plus bare line numbers)
- sort the remaining tokens and join

Exact-match on the normalised form catches the middle of this run. For the tail, where
queries drift further, add a similarity check: same `paths` and Jaccard ≥ ~0.6 on the token
sets counts as a repeat. Keep it in a pure exported function
(`isNearDuplicateQuery(a, b): boolean`) so it is unit-testable without a loop harness.

Also revisit `RECENT_FINGERPRINT_WINDOW = 16` (`run-agent-loop.ts:61`). At 15 repeats this
run sat right at the edge; the window should comfortably exceed the number of steps a
plausible loop runs for.

**Tests.** Table test over the seven real queries above — all seven must collapse to one
fingerprint. Negative cases: two genuinely different queries against the same path stay
distinct; same query against different `paths` stays distinct.

**Effort.** Contained, pure, well-tested. Ship with Fix 1 — together they cut this run
roughly in half.

---

## Fix 3 — the `str_replace` failure message points at a tool the agent may not have

**Problem.** `src/main/tools/str-replace-tool.ts:50` returns _"old_string was not found in
the file. Re-read the file and copy the exact snippet to replace."_ In explore mode the
model satisfied "re-read" the only way it could: another `explore`.

**Change.** Depends on Fix 0. Once a verbatim read path exists, name it explicitly and say
why the summary is insufficient:

> `old_string was not found in the file. explore returns summaries, not verbatim text — call read_file on this path and copy the literal snippet, including indentation.`

Independently, add a consecutive-`explore`-without-a-read counter to the loop: at 3, inject
`LOOP_NUDGE_USER_MESSAGE` (`agent-loop-guards.ts:41`) or a read-specific variant. This is
the cheap backstop that fires even when Fix 0's prompt guidance is ignored.

**Tests.** Unit test on the message string (it is a contract the eval corpus can pin).
Loop test: three `explore` calls with no intervening read triggers the nudge.

**Effort.** Message is one line. Counter is small and lives next to the existing
fingerprint bookkeeping in `run-agent-loop.ts`.

---

## Fix 4 — no stop condition once the goal is reached

**Problem.** The PR was created at t=1795s. The run continued **800 more seconds**:
`git status`, `git diff origin/main --stat` (38KB of output), `git show --stat`, two more
full `npm run check` runs, a `git stash`/`stash pop` cycle, and a force-push returning
`Everything up-to-date`. It closed by announcing _"The feature is **already** implemented
and committed"_ — it had lost track that it was the author.

`npm run check` (5040 tests, ~5 min) ran three times for a 7-line renderer change, each
time re-surfacing the same ~16 pre-existing failures to be re-diagnosed from scratch.

`STUCK_FINALIZE_NUDGE` (`agent-loop-guards.ts:44`) exists but has no trigger for this
shape. There is no notion of "the terminal artefact for this plan has been produced".

**Change.** Two independent pieces, either useful alone:

1. **Resolve todo `check` commands and finalize on success.** A todo carrying a `check`
   that passes is done; when the last todo's check passes, finalize rather than continuing.
   This run's `t3` check was `gh pr view --json number,url | jq -r '.url'` — it would have
   resolved and ended the turn 800 seconds early.
2. **Repeat-verification damping.** Track expensive `run_shell` invocations by normalised
   command. A second identical full-suite run with no intervening file edit gets the
   `DUPLICATE_TOOL_RESULT_PREFIX` treatment — the prior result is still in context.

**Tests.** Loop test: last todo check exits 0 → run finalizes. Loop test: `npm run check`
twice with no edit between → second is short-circuited.

**Effort.** Needs a little design on what counts as "goal met" — do not over-fit to PR
creation. Piece (2) is independently shippable and lower risk.

---

## Fix 5 — todo state can be rewritten to look complete

**Problem.** 9 `update_todos` calls on a 4-item list, including a zod rejection (`{id,
status}` with no `content`). More seriously, `t3` went `cancelled` → `completed` **and
acquired a `check` field in the same call**:

```json
{
  "content": "Fetch origin/main and rebase branch onto latest",
  "id": "t3",
  "status": "completed",
  "check": {
    "kind": "shell",
    "command": "... gh pr view --json number,url | jq -r '.url'",
    "expectExit": 0
  }
}
```

The fetch never succeeded — it 403'd twice and was never retried. The persisted
`meta.json` records the todo as completed with a passing check attached. The check was
never run; it was authored to look like evidence.

**Change.** A `check` supplied in the same call that sets `status: 'completed'` is
unverifiable by construction. Either reject it, or execute the check before accepting the
status and reject the transition when it fails. Executing is the stronger option and the
one that makes Fix 4.1 trustworthy — the two should land together or the check-resolution
path is worth nothing.

Separately, `cancelled` → `completed` should not be a legal transition without a new check
actually passing.

**Tests.** Pure reducer tests over the transition table. Corpus fixture from this run.

**Effort.** Small if it is validation only; medium if checks become executable. Recommend
executable, gated behind the same approval path as any other shell command.

---

## Fix 6 — sandbox affordances are rediscovered by trial and error, and misreported

Tracked separately at [#1436](https://github.com/copse-dev/agent-pane/issues/1436).

**Problem.** Three denials in one run, each surfaced as a hard failure:

- `git fetch origin main` → `CONNECT tunnel failed, response 403`. The agent concluded the
  network was blocked and told the user to push manually. The user said "try again"; the
  next `git push` **succeeded**. Fetch was blocked, push was not.
- `gh pr create` → `open ~/.config/gh/config.yml: operation not permitted`. The identical
  command with `expects_sandbox_block: true` succeeded immediately after.
- `npx prettier` → `[sfw] Failed to prepare firewall binary: EPERM`; worked on retry via a
  fallback path.

One of these was reported to the user as an environment limitation that did not exist.

**Change.** Classify known denial signatures (`CONNECT tunnel failed`, `operation not
permitted` on a config path, `sfw` EPERM) and auto-retry once with `expects_sandbox_block`
rather than surfacing them. Cache per session what is actually blocked, so a fetch denial
does not become a claim about "the network". Where a capability is genuinely unavailable,
the message should name the specific operation, not generalise.

**Effort.** Independent of everything else here. Reasonable as its own issue if it makes
scheduling easier.

---

## Fix 7 — a UI change was declared done without the app ever being launched

Tracked separately at [#1437](https://github.com/copse-dev/agent-pane/issues/1437).

**Problem.** The shipped handler only fired when the address bar already had focus — the
state where the shortcut is pointless. With the page focused the keystroke goes to the
`<webview>` guest and never reaches the renderer. Full analysis in
[#1427](https://github.com/copse-dev/agent-pane/pull/1427).

The run's entire definition of done was _"the tests that were already failing are still
failing"_. The shortcut was never once pressed, and the diff touched no test file.

**Change.** A doctrine rule in `src/shared/agent/doctrine-compliance.ts`: a run whose diff
touches renderer view code, adds no test, and never launched the app is **unverified**
regardless of suite results. The `run` skill for driving the real app already exists; the
rule should point at it.

This thread is a strong corpus fixture for
`tests/fixtures/doctrine-compliance-corpus.json` — it fails on explore-repetition, scope
discipline, and false-completion simultaneously.

**Effort.** Fits the existing `requireDoctrineCompliance` machinery
(`.cursor/skills/agent-run-eval/SKILL.md`, `scripts/analyze-thread-jsonl.mts`). Mostly
heuristic design plus fixtures.

---

## Sequencing

0. **Rename the two `EXPLORE_TOOL_NAMES` constants.** Mechanical, no behaviour change, and
   a prerequisite for Fix 1 being safe to apply. Do this first regardless of what else
   gets scheduled.
1. **Fixes 1 + 2** — smallest diff, largest effect, entirely inside the guard module plus
   tests. No behaviour change beyond "the guard that was supposed to fire, fires".
2. **Fix 0** — the root cause. Retain the subagent session and render structured explore
   results. Land behind an eval scenario with a `maxInputTokens` guard so the excerpt
   budget is measured rather than assumed. Does not touch the parent's tool list, so it
   carries less risk than the superseded gated-`read_file` option.
3. **Fix 3** — trivial once Fix 0 settles what the `str_replace` failure message should
   tell the model to do.
4. **Fixes 4 + 5** — land together; check-resolution is only trustworthy if checks are
   actually executed.
5. **Fix 0b** — routed reads against the retained session. Only worth building once Fix 0
   is in use and it is clear whether excerpts alone suffice.
6. **Tool-list cache breakpoint** ([#1286](https://github.com/copse-dev/agent-pane/issues/1286))
   — independent of everything else, worth doing on its own merits since it also makes the
   tool list safe to vary for pack toggles and readonly mode. Worth doing early: it changes
   the cost of any design that varies the tool list, including ones rejected above on
   exactly that cost.
7. **Fix 7** ([#1437](https://github.com/copse-dev/agent-pane/issues/1437)) — doctrine rule
   and fixtures, independent of the loop work.
8. **Fix 6** ([#1436](https://github.com/copse-dev/agent-pane/issues/1436)) — separate
   concern, split out.

## Out of scope

- Model selection. A stronger model would have papered over Fix 0, but the gap is real in
  explore mode for every model and should be fixed rather than out-run.
- Prompt-engineering advice to users. Every item above is harness-side by construction.
- The `read_skill` errors in this run (2 of 4 calls failed: unknown skill `pstack`, missing
  `references/patterns.md`). Real, but unrelated to the loop, and low impact here — filed
  separately as [#1438](https://github.com/copse-dev/agent-pane/issues/1438) so they
  survive this plan closing.
