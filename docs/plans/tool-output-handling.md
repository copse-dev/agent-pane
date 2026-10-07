# Tool-output handling: evidence-preserving caps, spill, and stubbing

Status: PRs A and B implemented on `claude/tool-output-evidence-cap`; C–F are designs.
Inspired by the SoL-Pi paper's _ObservationPack_ and evidence-preserving reducer: a
tool observation the model sees should be bounded, should say exactly what was left
out, and should keep the lines most likely to matter.

## Measurements (2026-10-02, real store, aggregates only)

Surveyed `~/.copse/workspace`: 97 real threads (excluding `e2e-*` and
`headless-project-*` fixtures). Parent spines held 3,289 tool results (6.3 MB);
counting subagent spines too, 5,246 results (11.7 MB). Sizes are of the persisted
result blobs, so they are post-cap.

| Tool                       | Results |     p50 |     p90 |     p99 |      Max |   Hit cap |
| -------------------------- | ------: | ------: | ------: | ------: | -------: | --------: |
| run_shell                  |   1,310 |  1.0 KB |  4.5 KB | 28.0 KB | 100.0 KB |         2 |
| read_file                  |     135 |  1.7 KB |  6.3 KB | 12.0 KB |  12.1 KB |     paged |
| explore (subagent summary) |     103 |  3.8 KB |  6.3 KB | 10.1 KB |  11.8 KB |    no cap |
| fetch_url                  |      32 |  0.1 KB | 22.7 KB | 42.5 KB |  42.5 KB |    no cap |
| list_dir                   |      30 |  0.2 KB |  2.3 KB | 96.9 KB |  96.9 KB | entry cap |
| git_show                   |       7 | 31.4 KB |  100 KB |  100 KB |   100 KB |         2 |

What dominates is how often old results get sent again, not the size of any single result.
An earlier replay of 35 native `agent-history.json` files (489 LLM calls; not re-run here)
found:

- Tool results older than three rounds are about 62% of re-sent input bytes.
- Old results of 8 KB or more are about 35% of re-sent input bytes.
- Stubbing those large old results to ~400 B would save about 34% at most. After the
  system prompt and tool schemas, the net saving is about 22% (inferred).
- History trimming fired in only 3 of 61 native threads.

Evidence density in the 85 run_shell results of 8 KB or more:

- Failure-class lines (`error`, `fail`, `panic`, `Traceback`, `*Error`, …): p50 0.2 KB,
  p90 15 KB, max 42.9 KB. 87% of results have ≤ 4 KB of them; 89% have ≤ 8 KB.
- Warning lines: max 0.8 KB.
- Location-only lines: max 16.7 KB.

This sized the evidence budget of PR A at one eighth of the cap (12.5 KiB at 100 KiB).

## Cap table (verified on `origin/main` at ad9594e99)

| Tool                                     | Cap                                          | Strategy                          | Note                                                                                  |
| ---------------------------------------- | -------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- |
| run_shell                                | 100 KiB, UTF-8 bytes                         | head + tail, streaming            | Exit code is a prefix, so it survives truncation. **A:** evidence + summary.          |
| run_background logs                      | 50 KiB                                       | head + tail                       | **A:** evidence.                                                                      |
| read_terminal                            | 100 KiB buffer, then the last 200–2000 lines | head + tail, then line tail       | **A:** evidence.                                                                      |
| read_file                                | 150 lines / 12,000 chars                     | paging                            | Already a handle-style tool.                                                          |
| list_dir                                 | 1,000 entries                                | head                              | No byte cap.                                                                          |
| search_code                              | 50–500 matches                               | head                              | Unbounded line width (minified files).                                                |
| git_show / git_diff / gh_*               | runCommand 100 KiB per process               | head only (see gap 1)             | git_diff appends one runCommand result per untracked file, so its total is unbounded. |
| gh_run_view                              | last 20,000 chars                            | tail, of head-capped input        | Tail is not the real end of the log (gap 1).                                          |
| get_ci_failure_logs                      | 100 KiB                                      | head + tail, of head-capped input | Same gap.                                                                             |
| parallel_search                          | 25,000 bytes                                 | head + tail                       |                                                                                       |
| fetch_url                                | none (2 MiB download limit, which errors)    | —                                 | **B:** 100 KiB head + tail, no evidence.                                              |
| MCP tools                                | none                                         | —                                 | **B:** 100 KiB head + tail with evidence.                                             |
| explore / delegate_step / investigate_ci | none                                         | —                                 | Bounded only by the model's output tokens.                                            |
| afterToolUse hook copy                   | 16,000 chars, head                           | —                                 | Caps only what the hook sees, not the model.                                          |

There is no generic cap in `ToolRegistry.execute` or the agent loop.

**Gap 1:** `runCommand` (`src/main/services/exec/command-runner.ts`) stops appending once
its raw byte count reaches the cap. That guard was added to avoid quadratic re-truncation.
The side effect is that everything after about 100 KiB is silently dropped, and the
"tail" any caller later keeps is really text from around the 100 KiB mark.

## PR plan (smallest first, each independently shippable)

### A. Evidence-preserving truncation (done)

`CappedOutputAccumulator(maxBytes, { evidence, hint })` and the one-shot
`truncateToolOutput` in `src/main/services/exec/subprocess-output-cap.ts`.

- Output that fits in `maxBytes` is returned verbatim. This also fixes a bug: the old
  accumulator added a false `[output truncated]` marker once output passed half the cap,
  even though nothing had been dropped.
- Past the cap, the result is head, then `\n[output truncated]\n` (the legacy marker, kept
  as an exact substring), then
  `[dropped N bytes (~M lines) from the middle; K error/warning/location lines from that span kept below. <hint>]`,
  then the kept lines in their original order, then `[end of kept lines]`, then the tail.
- Evidence lines are ranked: failures, then warnings, then locations (`file:line[:col]`,
  JS `at …`, and Python `File "…", line N`). Matching runs on ANSI-stripped text, and
  tallies such as `0 errors` are ignored.
- The evidence pool is bounded. When it is full, the lowest-ranked, latest line is evicted.
  Each kept line is cut to 512 bytes.
- Head, tail, and dropped span are cut on code-point boundaries. The result depends only on
  the full text, never on chunking. Tests cover per-character chunking and `toString()`
  called mid-stream.
- Budget: head + marker + 256 B summary reserve + hint + evidence budget + tail ≤ `maxBytes`.
- Caps below 2 KiB keep the bare marker with no summary.
- Wired into run_shell (with a re-run hint), read_terminal, and run_background.
  `appendFlatCapped` / `truncateCommandOutput` keep the legacy behaviour, because their
  callers parse git and rg output.

Visible change: for output over 100 KiB, the Agent tasks panel now streams the first part
verbatim and ends at the marker. Covered by `tests/e2e/agent-tasks-terminal.e2e.ts`
("caps over-limit output") and the screenshot `agent-tasks-over-cap-output.png`.

Risk:

- For over-cap output, head + tail shrink from ~100 KiB to ~87 KiB, to make room for the
  evidence budget and summary.
- Evidence regexes can admit noise, such as a log full of `error` words, but the budget
  bounds it.

### B. Uniform caps for fetch_url and MCP (done)

- `fetchUrlMarkdown` caps the converted Markdown at `FETCH_URL_OUTPUT_MAX_BYTES` (100 KiB),
  with no evidence, since pages are prose.
- MCP results go through `mcpToolResultText`: flatten, then cap at 100 KiB with evidence,
  because many MCP servers wrap build and test tools. The cap is applied before the
  `isError` throw, so error results are capped too.
- Custom tools (`custom-tools-config.ts`) are not capped. They are local, user-authored
  code; cap them in a follow-up if wanted.

Risk: low. The largest real result seen for either tool is 43 KB.

### A2. runCommand keeps the real tail (small, recommended next)

Replace `appendFlatCapped` in `runCommand` with `CappedOutputAccumulator`, evidence off.
Appends are O(chunk) amortised, so the GC-thrash guard is no longer needed. Then:

- `get_ci_failure_logs` passes `{ evidence: true }` through `truncateToolOutput`.
- `gh_run_view` either uses the same call, or raises `stdoutMaxBytes` for `--log-failed`
  so its tail is real.

Risk: medium. Many internal callers parse runCommand stdout. The marker position and text
are unchanged (no summary below 2 KiB; summary lines only at large caps). A summary line
inside capped git output is new, though, so audit the parsers that tolerate the marker
today. Needs a full `pnpm run check`.

### C. Spill full run_shell output to the thread store (design)

Goal: when run_shell drops a middle, keep the full output on disk and give the model a
handle in place of the bare summary, for example
`[full output: 2,345,678 bytes, 41,200 lines — read_file <abs path> start_line=…]`.

- **Where.** `<thread>/spill/<safe-id>.out`, outside the pruned `CONTENT_DIRS` (`messages`,
  `blobs`, `subagents`). This avoids teaching `pruneStaleFiles` about a new ref kind.
  - The alternative is `blobs/` plus a spine ref (`toolCalls[].spill`). It is cleaner for
    export, but it needs a `spine-schema.ts` change, round-trip tests, and a `writeThread`
    full-save case. That is exactly the "spine line vanishes on full save" trap in
    `hooks-and-feature-packs.md`.
  - Prefer `spill/` for v1 and add it to the export and deletion walkers explicitly.
- **Path safety.** Build the path only through the safe id/path helper being introduced by
  the in-flight thread-store path-traversal fix. No `${toolCallId}` interpolation. Assert
  containment in the thread dir after `realpath`.
- **Capture.** Tee raw chunks to a write stream as soon as the accumulator first truncates.
  Bytes before that point are held in the accumulator's head and tail, so write those first.
  Abort the tee and note "spill incomplete" past a per-call ceiling (64 MiB) or a per-thread
  quota (256 MiB, oldest-first eviction).
- **Reading.**
  - read_file and search_code must resolve chat-store paths through
    `resolveLocalChatStorePath` before the active backend, as read_archive and video frames
    already do (`resolveReadableFileWithinRoot`). Otherwise an SSH workspace looks for the
    path on the remote host.
  - read_file paging already bounds reads.
  - Thread containers (`docs/plans/thread-in-container.md`) run their own store, so the
    handle must name a path that the container's read tools resolve. Gate the spill off in
    containers for v1.
- **Retention and privacy.**
  - Spills are raw command output above 100 KiB, which Copse never writes today.
  - PII redaction (`docs/pii-redaction.md`) covers prompts, not tool results, so spills
    inherit the same exposure as `blobs/*.result.txt`, only larger.
  - Document spills in `docs/privacy-data-flow.md` and `docs/thread-store-format.md`.
  - Delete spills with the thread.
  - Exclude them from ZIP export by default, because of the 512 MiB export refusal.
  - Add a setting to turn spilling off.
- **Tests.**
  - Spill created only on truncation.
  - Path built via the helper; traversal ids rejected.
  - Quota eviction.
  - Survives a full save (not pruned).
  - SSH-backend read resolves locally.
  - Handle text is stable.
  - Visual: the Agent tasks panel and tool card are unchanged apart from the handle line.

### D. Stub-before-drop in trimming (design; measure first)

In `trimMessagesInPlace` (`packages/agent/src/trim-history.ts`), after
`repairToolUseToolResultPairing` and estimate seeding, and before the drop loop: replace the
content of the oldest tool results of 8 KB or more with a stub. The stub keeps the
tool-result block, its `tool_use_id`, and the message count, so pairing is untouched. Stop
once the running estimate is under budget, and only then fall through to dropping whole
messages.

- **Stub text.** `[tool result elided to save context: <tool> · N bytes · first line … · <handle if C landed>]`.
  Keep the first and last few lines (or the evidence lines from A) so the stub is still
  evidence.
- **Same pass in `compactAtTodoBoundary`.** Run it on the older span before that function
  drops pairs.
- **Cache.** Both call sites already rewrite history, so the prompt-cache prefix is already
  cold there. Stubbing adds no extra cache break.
  - Trimming is rare (3 of 61 threads), so this is a quality win (keeps the conversation
    skeleton instead of deleting it), not a cost win.
- **Proactive stubbing** (the ~22% net saving) needs a cold-cache trigger: after a cache TTL
  expiry, a model or tool-list change, or a todo boundary. Each one rewrites the prefix.
  - Do not add one until the in-flight prompt-cache-break measurement work reports how often
    the prefix is already cold. Reuse its instrumentation; don't add a second one.
- **Hooks plan.** The `compaction` canonical event (`canonical-events.ts`) is declared but has
  no fire site. D should not start firing it.
  - If it does later, adding a trigger such as `'tool-result-stub'` changes the event payload,
    and under execution-guidance rule 1 that needs a decisions-log edit in the same PR.
  - It must also stay `async` observation (no decisions), per decision 11.
- **Tests.**
  - Pairing invariant (ids and count unchanged).
  - Stubbed results come first, before any drop.
  - Determinism.
  - The measured-token seeding path (#52) still shrinks.
  - The todo-boundary pass.

### E. Cap subagent summaries and git_diff totals (small)

- explore, delegate_step, and investigate_ci return the subagent's last text uncapped.
- git_diff concatenates one capped diff per untracked file.

Both should go through `truncateToolOutput` (evidence on for git_diff).

### F. Spill other evidence-heavy tools (after C)

Extend C's handle to `get_ci_failure_logs`, MCP results, and fetch_url once A2 makes their
inputs whole.

## Open questions

- Should the evidence budget adapt? For example, give unused evidence budget back to the
  tail. The fixed split keeps streaming and determinism simple; the cost is about 13 KiB of
  head + tail when there is no evidence.
- Should kept evidence lines carry their original line numbers (`L41203: …`) so the model
  can `sed -n` around them once C lands?
