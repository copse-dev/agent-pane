# Agent loop efficiency guards

Tracking: [#1433](https://github.com/copse-dev/agent-pane/issues/1433). Motivating run:
thread `178909d1` ("Cmd+L Select Browser URL") — 43 minutes and 3.38M input tokens to
produce a 7-line change that did not work ([#1427](https://github.com/copse-dev/agent-pane/pull/1427),
fixed in [#1432](https://github.com/copse-dev/agent-pane/pull/1432)).

Status: **proposed.** No code landed yet.

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

### Fix 0 — give explore mode a verbatim read path

Options, roughly in order of preference:

1. **Un-delegate `read_file` and re-scope it as the exact-bytes tool.** Drop `read_file`
   from `PARENT_DELEGATED_TOOLS`, keep the other four delegated. Describe it in
   `EXPLORE_MODE_VARS.tools` as narrowly as possible so it does not become a general
   browsing tool and undo the context savings explore mode exists for:
   `read_file: Read exact file text — required before str_replace. Use explore for
understanding; use this only to copy the literal snippet you are about to replace.`
   Adjust `understand` and `toolChoice` to match: explore to find and understand, read_file
   to quote.

   Cost: some context regression in explore mode. This is measurable —
   `maxInputTokens` already exists as a scenario guard in
   `scripts/analyze-thread-jsonl.mts`.

2. **Add a verbatim mode to `explore`.** An `exact: true` / `quote_lines` parameter that
   bypasses the summarising subagent and returns raw text for a path and line range.
   Keeps one tool in the prompt, but overloads a tool whose whole identity is "returns a
   summary", and gives the model a decision it will get wrong.

3. **Make `str_replace` tolerant of approximate input** — whitespace-insensitive matching,
   or accept a line range plus a fuzzy anchor. Reduces the blast radius but does not fix
   the wrong line numbers, and silent fuzzy matching on edits is its own hazard.

Recommend (1), with (3) as a later independent hardening. Whichever we pick, the
`str_replace` failure message must name a tool the agent actually has.

**Tests.** Pin the explore-mode tool list in the existing prompt-ablation tests
(`src/main/services/agent-prompt-ablation.test.ts`). Add a `parentTools` unit test
asserting `read_file` survives in both modes and the other four stay delegated. Add a
scenario to the eval corpus: a small edit in explore mode must reach a successful
`str_replace` with `maxExplore: 3`.

**Effort.** Small diff, moderate blast radius — it changes what every explore-mode run is
offered. Land behind the eval harness, not on vibes.

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

**Change.** Add `'explore'` (and `'semantic_search'`, likewise missing). Rename to
`CONTEXT_GATHERING_TOOL_NAMES` if the vestigial framing is worth fixing at the same time.

**Tests.** `agent-loop-guards` unit test: two identical `explore` calls, second is flagged.

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

1. **Fixes 1 + 2** — smallest diff, largest effect, entirely inside `agent-loop-guards.ts`
   plus tests. No behaviour change beyond "the guard that was supposed to fire, fires".
2. **Fix 0** — the root cause, but it changes every explore-mode run's tool set. Land it
   behind an eval scenario with a `maxInputTokens` guard so the context cost is measured
   rather than assumed.
3. **Fix 3** — trivial once Fix 0 settles which tool to name.
4. **Fixes 4 + 5** — land together; check-resolution is only trustworthy if checks are
   actually executed.
5. **Fix 7** — doctrine rule and fixtures, independent of the loop work.
6. **Fix 6** — separate concern; split into its own issue if that schedules better.

## Out of scope

- Model selection. A stronger model would have papered over Fix 0, but the gap is real in
  explore mode for every model and should be fixed rather than out-run.
- Prompt-engineering advice to users. Every item above is harness-side by construction.
- The `read_skill` errors in this run (2 of 4 calls failed: unknown skill `pstack`, missing
  `references/patterns.md`). Real, but unrelated to the loop, and low impact here.
