**Mock conversation and screenshot audit**

Audited 21 September 2026 against checkout `a5c52dac6` (25 July 2026).
The assessment below records the original checkout before the approved migration.
Counts describe that checkout, not a freshly fetched main branch. The recommendation
has since been implemented; see the implementation record at the end.

**Finding**

Yes, we already started this. [PR #338](https://github.com/copse-dev/agent-pane/pull/338),
merged on 28 June, introduced an ordered mock script and described it as
“cucumber-ish.” Its commit message explicitly left migration of existing specs
out of scope and kept the inline directives. The ancestor in this checkout is
`7e874a850`.

Only **one WebdriverIO spec** adopted that API:
[mock-script-multiturn.e2e.ts](../tests/e2e/mock-script-multiturn.e2e.ts).
It demonstrates natural user prompts, but its first assistant answer and sidebar
title still expose mock internals in the
[committed screenshot](../tests/e2e/screenshots/mock-script-multiturn.png).
The migration was left incomplete, and the replacement also lacks capabilities
needed to finish it.

My recommendation is to finish the existing TypeScript scenario approach, with
complete scripted conversations, realistic assistant prose, and control data
outside the transcript. Keep ordinary user actions in the test: type a request,
send it, answer a question, approve or reject a command, inspect the result.

**How much remains**

| Area                             | Inventory                                           | Implication                                                                                                             |
| -------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Inline directives in WebdriverIO | **12 specs**: six steer tools, six introduce delays | These are the direct migration set; two are excluded by the CI config                                                   |
| Legacy Playwright                | **1 spec, 2 directive-bearing prompts**             | `mcp-validate.spec.ts` is outside the current WDIO glob; the declared dependencies do not include its Playwright runner |
| Headless benchmark               | **1 task**                                          | `smoke-write-file.json` embeds a tool directive; deleting the parser alone breaks the benchmark self-test               |
| Directive grammar                | **3 forms**                                         | Tool call, delay, and reasoning; the reasoning form has no current fixture consumer                                     |
| Existing scenario adoption       | **1 WDIO spec**, plus provider/script unit coverage | Available infrastructure was never rolled out across the suite                                                          |
| Literal source references        | **34 mentions across 23 tracked text files**        | Includes comments, docs, unit tests, and one negative assertion, not 34 independent scenarios                           |
| Screenshot corpus                | **271 committed PNGs**                              | At least **26** show directive syntax or artificial assistant/title text                                                |
| Directive-bearing images         | **20**                                              | Some survive only as old image files, with no remaining screenshot-producing spec                                       |
| Echo text in images              | **16**                                              | Includes partial streamed “Mock respons” and generated titles                                                           |
| Other artificial reply           | **1**                                               | The checkup screenshot shows a partial “mock health check” reply                                                        |

The image categories overlap: 20 directive images plus 17 images with artificial
replies/titles have 11 images in common, giving 26 distinct images (about 10% of
the corpus). This is a lower bound from OCR plus visual spot checks, not a claim
that every remaining pixel or every fixture sentence is realistic.

The 12 directive-using WDIO specs declare **20 screenshot targets**, of which
**19 are committed**. `queued-pinned-scrolled-top.png` is absent. This is a
different count from the 20 images visibly containing directives: cropped or
covered screenshots may hide the prompt, and old images can outlive their tests.
The Playwright file declares four images; two of its scenarios use directives.

**Direct migration inventory**

All files below are under `tests/e2e/`. Screenshot counts are targets declared in
the file, not counts of images with visible syntax.

| Spec                          | Current control                                     | Screenshot targets | Required replacement                                                                                                   |
| ----------------------------- | --------------------------------------------------- | -----------------: | ---------------------------------------------------------------------------------------------------------------------- |
| agent-tasks-terminal.e2e.ts   | Shell tool directive                                |                  1 | Natural request to run a command; real terminal output; scripted completion                                            |
| ask-user-dialog.e2e.ts        | Question tool directive                             |                  1 | Natural implementation request; assistant asks about the HTTP client; answer affects the continuation                  |
| install-approval.e2e.ts       | Package-install directive                           |                  1 | “Install the project dependencies”; preserve the real approval and rejection path                                      |
| model-compare-approval.e2e.ts | Model-comparison directive                          |                  1 | Natural model-comparison request; preserve the real approval path                                                      |
| npx-approval.e2e.ts           | Package-command directive                           |                  1 | “Run the TypeScript checks”; preserve the real approval path                                                           |
| staged-diff-ui.e2e.ts         | One write-file directive helper, called three times |                  5 | Natural file-edit requests and complete post-tool replies; retain Monaco and diff IPC coverage                         |
| double-submit.e2e.ts          | Delay directive                                     |                  2 | Natural request and follow-up; hold/release the first response outside the prompt                                      |
| queued-message-delete.e2e.ts  | Delay directive, also asserted verbatim             |                  2 | Hold a normal request while its queued follow-up is deleted                                                            |
| queued-pinned.e2e.ts          | Delay directive                                     |     1, uncommitted | Hold a normal request while checking queue pinning; currently excluded from CI                                         |
| thread-running-status.e2e.ts  | Delay directive                                     |                  1 | Controlled in-progress turn; screenshot is cropped to the sidebar                                                      |
| two-step-stop.e2e.ts          | Delay directive                                     |                  1 | Controlled in-progress turn; retain two-Escape cancellation                                                            |
| ui-polish.e2e.ts              | Delay directive                                     |                  3 | Controlled activity state with natural chat text behind subsequent panels                                              |
| mcp-validate.spec.ts          | Two external-tool directives                        |                  4 | Port the affected MCP flows to WDIO, or consolidate into verified equivalent coverage before retiring this legacy file |

`staged-diff-ui.e2e.ts` is also excluded by `wdio.ci.conf.ts`. A green default
CI selection therefore does not establish that all migrated cases work.

**Why replacing the prompt strings is insufficient**

1. **The current script cannot finish a tool turn.**
   [mock-script.ts](../packages/llm/src/mock-script.ts) supports a regex `when`
   and either one tool or one text response.
   [mock-provider.ts](../packages/llm/src/mock-provider.ts) consults it only before
   an assistant message exists after the latest user message. After a tool result,
   it falls through to the generic echo. Adding another step matching the same
   prompt does not fix this. A direct runtime probe confirmed that the script
   cursor remains at 1 and the reply is “Mock response to: List src.”
   Supplying both `tool` and `text` is accepted by the IPC schema, but the tool
   branch returns before the text can be emitted.
2. **Timing and reasoning still require the old parser.**
   The script has no delay, hold/release, or reasoning support. Existing delay
   requests of 6–8 seconds are actually capped at 5 seconds per provider call.
   The delay is applied again on a continuation seeing the same user text.
   Explicit test-controlled holds would make running/queue/cancel assertions
   easier to synchronize than these sleeps.
3. **Matching failures silently use generic behavior.**
   A nonmatching regex, invalid regex, unavailable tool, or exhausted script can
   return `null` and allow the default mock behavior. There is no assertion that
   all expected steps ran. That can make a screenshot look successful without
   exercising the intended conversation.
4. **The script is process-global.**
   Its steps and cursor are shared across provider instances. Background title
   generation, other threads, and subagents are not isolated from the scenario.
   A broad text matcher can match a title-generation prompt containing the user's
   request. Scope scripted conversations and auxiliary model work separately.
5. **Generated labels leak too.**
   [title-generator.ts](../src/main/services/title-generator.ts) uses the
   [small-tasks provider](../src/main/services/providers/small-tasks-provider.ts),
   which reaches the generic mock under the e2e environment. This produces
   sidebar titles such as “Mock response to: Reply with…”. Natural chat text alone
   leaves those labels unchanged.
6. **There are additional response dependencies.**
   `scroll-to-bottom.e2e.ts` waits twice for “Mock response”; the legacy MCP test
   asserts it too. Five more WDIO specs produce affected images without embedding
   directives: `mock-script-multiturn`, `tool-display-live-mock`,
   `follow-up-suggestions`, `paste-attachment`, and `checkup-skill`.
   The browser demo API also emits “Demo response to…” with an implementation
   explanation, and `markdown-list-indent.demo.ts` asserts it.
   `skills.e2e.ts` asserts a special demo-skill confirmation. These should receive
   explicit, appropriate fixture replies where the goal is realistic conversations.
7. **The existing example has a stale import.**
   Its `MockScriptStep` type still points to the removed
   `src/shared/llm/mock-script.ts`. The implementation now lives under
   `packages/llm/src/`. The node TypeScript config does not include e2e specs,
   so the regular typecheck does not cover this stale reference.

**Alternatives**

| Approach                                         | What the test author writes                                                                                       | Benefits                                                                                                          | Costs / limits                                                                                                                                                     | Assessment                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Extend the current TypeScript scenario API       | Normal prompts and exact replies alongside typed provider actions; ordinary WDIO user interactions and assertions | Reuses the installed runner, IPC seam, and real agent/tool loop; no new text grammar or dependency                | Needs complete turn sequences, lifecycle controls, strict validation, and isolation                                                                                | **Recommended for live interaction tests**                                   |
| Actual Cucumber/Gherkin                          | Feature scenarios with Given/When/Then, backed by reusable step definitions                                       | Standard behavioral language, readable by non-TypeScript contributors                                             | Adds an adapter, feature files and step definitions; still needs the same provider scripting; oracle and screenshot ownership discovery currently assume `.e2e.ts` | Choose if maintaining readable feature files is itself a product requirement |
| Seed realistic finished conversations            | Ordinary user/assistant messages and tool results in existing state fixtures                                      | Smallest and fastest option for static presentation; already supported by thread seeds and browser demo scenarios | Does not test submission, live tools, approvals, cancellation, or queue draining                                                                                   | **Recommended companion for static screenshots**                             |
| Real-model scenarios, or recorded real responses | Normal prompts against the existing agent-eval runner; optionally replay reviewed recordings                      | Can evaluate actual model/tool behavior; recordings can provide realistic source material                         | Live runs vary and require a model; replay still needs a deterministic provider seam and curated fixtures                                                          | Keep for model evals, not the main reference-image generator                 |

WebdriverIO officially supports Cucumber through `@wdio/cucumber-framework`
and a `framework: 'cucumber'` configuration.
[WebdriverIO framework documentation](https://webdriver.io/docs/frameworks/#using-cucumber)
Gherkin maps Given/When/Then steps to implementation code; it does not itself
supply model replies or tool behavior.
[Cucumber Gherkin reference](https://cucumber.io/docs/gherkin/reference/)
The cost and suitability judgments above are based on this repository's existing
Mocha runner, test oracle, and fixtures.

The existing [testing strategy](testing-strategy.md) already supports the mixed
approach: use seeded/component/browser tests for presentation and keep Electron
for real IPC, Monaco, terminal, and live interaction coverage.

**What a replacement scenario should express**

An illustrative behavioral scenario, with all control metadata stored in test
setup:

> Given a project whose HTTP client has not been chosen
>
> When I send “Add a client for the project API”
>
> Then the assistant asks “Which HTTP client should we use?”
>
> When I choose “fetch” and submit the answer
>
> Then the assistant replies “I'll use fetch for the API client.”

Behind that scenario, a typed fixture selects the real `ask_user` tool and its
arguments. The response is emitted after the real tool result returns, and the
test verifies the selected answer reached the continuation. No control tokens
are typed into the composer. The same approach covers tool errors and rejected
approvals, with replies consistent with what actually happened.

The minimal API should support exact expected user text; an ordered sequence of
provider responses within each user turn; text, tool calls and reasoning chunks;
and a test-side hold/release mechanism that responds to cancellation. Setup and
teardown should check for unexpected requests and unconsumed steps. Titles and
other auxiliary model calls need their own deterministic fixture behavior.
Prefer ordinary typed objects and helper functions over inventing another
string-based scenario language.

**Suggested handoff to a cheaper implementation agent**

This is a moderate test-infrastructure change followed by a mechanical fixture
migration. Agree on the small API first; then a cheaper agent can execute these
bounded work packages:

1. **Complete the scenario engine.** Update the two mock modules and their unit
   tests, the IPC schema, preload bridge, and a shared WDIO helper. Cover
   tool → real result → final answer in one user turn, multiple tool rounds,
   follow-ups, invalid/unexpected requests, cancellation, and thread/auxiliary
   isolation. Preserve real tool execution for runtime tests. Keep the
   Electron-free package usable by the benchmark.
2. **Convert the direct consumers.** Migrate all 12 WDIO specs, the two legacy
   MCP scenarios, and the benchmark task. Give both sides of each conversation
   intentional prose. Preserve each assertion's behavioral purpose and the
   existing approval/rejection decisions. Replace delays with controlled holds.
   Prove the API with ask-user, a delayed queue, and staged diffs before doing
   the rest.
3. **Finish the response and title cleanup.** Cover the five additional
   screenshot-producing specs listed above, scroll-to-bottom's reply waits, and
   the demo/skill response fixtures. Pin meaningful titles. Scope this to fixture
   behavior; do not hide user text in the renderer or substitute fabricated
   success messages for real tool outcomes. Keep truthful checkup diagnostics
   about running under the mock provider.
4. **Remove the old facility.** Delete all three directive parsers and their
   obsolete positive unit tests. Update AGENTS.md, the on-machine eval skill,
   the thread-referencing plan, and benchmark comments. Replace or retire the
   old build constant and marker checks consistently across the app/dev/test
   and benchmark build entrypoints. Retain the release boundary for any
   replacement test-only controls. Historical audit quotations can remain;
   executable fixtures and current how-to instructions must not use the grammar.
5. **Regenerate and review the images.** Use the 26-image manifest below as the
   minimum inspection list, then inspect other images produced by touched specs.
   Regenerate through tests. For the three orphaned queue images, verify current
   component coverage and either retire the references or add a focused seeded
   visual fixture if the visual coverage is still useful.
6. **Prevent recurrence and verify.** Add a focused fixture/transcript check for
   directive leakage and generic echo replies, including sidebar titles.
   Assert scenario exhaustion. Check the benchmark self-test and release build.
   Run `npm run check`, build and the required Electron e2e coverage; prefer
   the documented remote runner during iteration when configured. Explicitly
   cover migrated CI-excluded specs. Run the browser tier if its fixtures change.
   Follow the screenshot/agent-eval skills required by AGENTS.md and inspect the
   rendered images rather than relying on a green build.

Completion means no inline control grammar remains in executable scenarios,
scripts do not silently fall back, normal requests have appropriate replies,
titles read normally, and affected reference images have been regenerated or
deliberately retired. Renaming the directives or stripping them only at display
time would not meet the request.

**Affected screenshot manifest**

All names below are committed files under `tests/e2e/screenshots/`.
“Echo” includes assistant text or generated sidebar titles.

| Screenshot                            | Observed issue            | Producer / disposition             |
| ------------------------------------- | ------------------------- | ---------------------------------- |
| agent-tasks-terminal.png              | Directive + echo title    | agent-tasks-terminal.e2e.ts        |
| ask-user-dialog.png                   | Directive                 | ask-user-dialog.e2e.ts             |
| chat-activity-in-composer.png         | Directive                 | ui-polish.e2e.ts                   |
| checkup-skill-picked.png              | Partial mock-health reply | checkup-skill.e2e.ts               |
| double-submit-drained.png             | Directive + echo          | double-submit.e2e.ts               |
| double-submit-single-queued.png       | Directive                 | double-submit.e2e.ts               |
| follow-up-suggestions-demo.png        | Echo                      | follow-up-suggestions.e2e.ts       |
| follow-up-suggestions-git-changes.png | Echo                      | follow-up-suggestions.e2e.ts       |
| install-approval-dialog.png           | Directive + echo title    | install-approval.e2e.ts            |
| mcp-approval-dialog.png               | Directive                 | Legacy mcp-validate.spec.ts        |
| mcp-chat-toolcall.png                 | Directive + echo          | Legacy mcp-validate.spec.ts        |
| message-queue-drained.png             | Directive + echo          | Orphaned after component migration |
| message-queue-queued.png              | Directive                 | Orphaned after component migration |
| mock-script-multiturn.png             | Echo + echo title         | mock-script-multiturn.e2e.ts       |
| model-compare-approval-dialog.png     | Directive                 | model-compare-approval.e2e.ts      |
| npx-approval-dialog.png               | Directive + echo title    | npx-approval.e2e.ts                |
| pane-rules-and-roadmap-spacing.png    | Directive                 | ui-polish.e2e.ts                   |
| paste-attachment-transcript.png       | Echo                      | paste-attachment.e2e.ts            |
| queued-message-delete-after.png       | Directive                 | queued-message-delete.e2e.ts       |
| queued-message-delete-before.png      | Directive                 | queued-message-delete.e2e.ts       |
| queued-message-send-now.png           | Directive + echo          | Orphaned after component migration |
| staged-diff-css-accept-no-error.png   | Directive + echo          | staged-diff-ui.e2e.ts              |
| staged-diff-multi.png                 | Directive + echo          | staged-diff-ui.e2e.ts              |
| staged-diff-rapid-selection.png       | Directive + echo          | staged-diff-ui.e2e.ts              |
| staged-diff-single.png                | Directive + echo          | staged-diff-ui.e2e.ts              |
| tool-display-live-mock.png            | Partial echo              | tool-display-live-mock.e2e.ts      |

The three orphaned images have no current producer reference in tracked text.
Commit `c0766bef3` ([PR #377](https://github.com/copse-dev/agent-pane/pull/377))
removed their Electron specs after porting behavior into component tests, but
left the PNGs behind.

**Evidence and limitations**

The audit used tracked-file searches including hidden skill files, local Git
history, source inspection, text recognition across all 271 committed PNGs, and
visual inspection of representative/ambiguous images. OCR completed without
per-file errors; one image had no recognized text. Three tool-directive matches
needed correction for OCR reading the colon as “i”; partial reply text was
checked visually. Ordinary references to mock providers inside documentation or
real checkup diagnostics were not counted as artificial conversation replies.

A standalone Node probe exercised the original provider and verified its
post-tool scripting limitation. The assessment itself was read-only. The user
subsequently approved the recommendation, leading to the implementation below.

**Implementation record — integration with current main, 22 September 2026**

The migration replaces inline prompt directives and regex scripts with typed,
thread-scoped conversations. User turns contain ordinary requests; provider
responses describe tools, reasoning, and final prose separately. Real tools,
approval dialogs, question answers, file changes, and MCP transports still run
through the app. Tests verify the actual tool result before emitting the next
fixture reply.

Scenarios survive provider recreation, reject unexpected turns or unavailable
tools, and require every expected response to be consumed. Explicit holds
support cancellation and deterministic screenshots. Machine-generated turns
can match a stable substring; recovery scenarios can deliberately continue after
an empty or malformed provider response. Auxiliary title generation cannot
consume a conversation scenario. Release builds remove the scenario runner and
test bridges.

The rebased migration covers 64 Electron spec files, browser demo fixtures, ACP
integration tests, and benchmark, doctrine, and steering smoke tasks. Current
provider, profile, IPC, MCP, and build behavior is preserved. The old Playwright
MCP spec is now an executable WDIO spec with stdio, approval, and authenticated
HTTP coverage. Screenshot capture rejects directive syntax, generic echo replies,
and fallback text in conversation messages and sidebar titles. A recursive
source guard checks executable fixtures, including nested helpers and packs.

MCP tests exposed fixture lifecycle problems: environment patches discarded the
isolated profile paths, and a running app could overwrite the next seed during
shutdown. Patches now retain isolation settings; the MCP fixture stops the old
session and clears its isolated thread store before reseeding. Reconnecting HTTP
clients receive independent MCP sessions. Real approval remains required.

Scenario registration now waits for the selected thread to finish restoring.
Tests that restart Electron assert completion before reloading. Staged-diff
fixtures use a disposable non-Git workspace, matching the current supported
staging behavior without modifying the source checkout. Retired screenshot files
without a producing spec are removed instead of retaining obsolete mock text.

**Validation on the rebased implementation**

- `pnpm run check` passed on Node 24.20.0: typecheck, lint, formatting, dead-code
  and oracle guards, and the complete unit test suite.
- All **64 changed Electron spec files passed** across focused local runs. The
  MCP spec passed all five stdio, approval, and HTTP-auth cases together. This
  includes the changed cases normally excluded from the CI suite.
- All **25 browser demo specs passed**. Benchmark smoke passed 1/1, doctrine
  self-tests passed 2/2, and steering self-tests passed 6/6.
- Normal and release builds passed, including verification that scenario and
  MCP-fixture controls are absent from the shipped bundles.
- Current screenshots were regenerated by their real test producers. Visual
  inspection covers conversation, approval, MCP, reasoning, attachment, queue,
  and staged-diff states. OCR covered all **643 current reference images** with
  no recognition errors and no matches for the old directives, generic mock/demo
  replies, mock-health reply text, or missing-scenario diagnostics. OCR supports
  the source and DOM guards; it is not proof of every pixel.

The full Electron CI tier also found two fixtures whose settings and terminal
crops hid an unconfigured fallback reply in the transcript. Those fixtures now
read real router and README files through registered scenarios and assert the
resulting replies before capture. Both focused specs pass.

The scheduled-run fixture also holds its reply while opening the new run. This
keeps streaming store updates from replacing the sidebar row between WebDriver
locating and clicking it. The test releases the response after verifying that
the real scheduled prompt opened, then checks the completed conversation.

The broad provider and fixture changes require the full Electron CI tier before
merge. The focused runs above supplement that gate rather than replacing it.
