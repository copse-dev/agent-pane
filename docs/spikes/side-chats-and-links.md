# Side chats and thread links spike (design prototype #3538)

> Draft spike, stacked on [#3502](https://github.com/copse-dev/agent-pane/pull/3502) (thread/PR
> provenance and the SQLite projection). Not for merge as-is. It answers "what do we need to build
> for the #3538 design", proves the two data-heavy pieces on the real store, and records what is
> still open.

## Task brief

Design source: [#3538](https://github.com/copse-dev/agent-pane/pull/3538) (static prototypes
`side-chats.html`, `side-chats-instances.html`, `new-thread-activity.html`), part of milestone 5
(New-thread Activity screen, plan in [`docs/plans/new-thread-activity-screen.md`](../plans/new-thread-activity-screen.md)).

Acceptance criteria for this spike:

- Inventory the design against the app and say what must be built, in PR-sized slices.
- Decide whether the work builds on the SQLite projection.
- Spike side chats (hidden by default, archived rather than deleted, own model, unread dot) and
  links (repos, links and references, subagents, "mentioned in") end to end on the real thread store.
- Show it working in the browser demo with reviewed screenshots, and record exact validation.

## What the design asks for, against the app today

| Design element (#3538)                                                                                            | The app today                                                           | In this spike                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Side chat as a thread branched from a message, own model                                                          | Forks copy the transcript; nothing anchored, hidden or child            | **Yes.** `sideChat: {parentThreadId, anchorMessageId}`; agent history seeded once through the existing `threads:fork` path; model stored and inherited          |
| Side chat shown **beside** the main thread, with its own composer                                                 | One conversation view bound to the active thread                        | **Yes**, as a `side-chat` right-panel mode: chips list, read-only context line, transcript with streaming, composer, suggestions. The main thread stays active  |
| Hidden by default, archived rather than deleted, unread dot                                                       | Archive exists; no hidden threads                                       | **Yes.** Hidden from the sidebar and Activity; archive and delete cascade from the parent; restore; unread rolls up to the parent row                           |
| Hover "Side chat" on a message, anchor chip under the branched message                                            | No message action                                                       | **Yes** on prompts and replies, plus a chip (with an unread dot) that reopens the chat. **`⌘/` is not bound**: the app already uses it for the shortcuts dialog |
| Promote to thread                                                                                                 | None                                                                    | **Yes.** A new thread of the parent slice plus the side chat's turns, history copied, the side chat archived                                                    |
| Send summary to main                                                                                              | None                                                                    | **No.** The parent's agent history is rebuilt from run payloads, so a posted note would not reach the agent; this needs a design decision                       |
| Per-thread Context panel: repos, links and references, subagents                                                  | Seven right-panel modes, none per-thread                                | **Yes** as a `context` mode; not yet the default opener                                                                                                         |
| "Mentioned in" and thread-to-thread references                                                                    | `@`-thread chips record only a label; PRs have the #3502 model          | **Yes** for `copse://thread/<id>` and `copse.dev/open` links in message text, plus web URLs, indexed in SQLite                                                  |
| Titlebar entry with a count badge                                                                                 | Text-button cluster                                                     | **Yes**: Context and Side chat controls; Side chat shows the live count and highlights while one is unread                                                      |
| Per-thread panel instances (several browsers/terminals/side chats, at most two slots, pinning, reuse rules, rail) | One `rightPanelMode`; instances exist only inside a mode                | **No.** The biggest remaining piece (`side-chats-instances.html`); it supersedes mode-per-button                                                                |
| Panel switcher variants (top bar, right rail, C/n strips) and the gutter for thread actions                       | Titlebar cluster with portrait overflow                                 | **No.** The prototype notes the C-shape panel was not working at last review                                                                                    |
| Side chat identity colour (the prototype's purple)                                                                | No such token; `ui-taste.md` forbids new colour tokens without a reason | **No.** The accent is used                                                                                                                                      |
| Narrow and portrait layouts, sidebar dot instead of bell                                                          | Portrait chrome exists                                                  | **Partly.** The roll-up dot exists; the bell swap does not                                                                                                      |
| Activity screen: wide multi-repo PR list, full PR mode hiding menu and gutter                                     | Milestone 5 stack is merged on main                                     | **No**                                                                                                                                                          |

## Should this build on the SQLite change?

**Yes for links, mostly no for side chats.**

- **Links need an index.** "Which threads link to this thread or URL" is a cross-thread question that
  today requires reading every transcript. The projection answers it with one indexed read, and the
  design (backlinks, "mentioned in") depends on it. This is the same shape as the PR relationships the
  projection already serves, and it reuses the projection's rebuild, repair and corruption handling.
- **Side chats do not need one today.** The renderer already holds the metadata of every thread in the
  active project (including archived ones), so listing a thread's side chats is a filter over the live
  store, which is also reactive for unread and archive state. The `side_chats` table and
  `lookupSideChats` are kept because they cost almost nothing and answer the same question for a
  client that does not hold the list (popout, mobile, the client/server split). **Decision for the
  reviewer:** drop them if no such client is planned.
- **Schema.** Index schema v1 to v2 adds two tables. An older index is incompatible, so the store
  discards and rebuilds it from the authoritative files, exactly as it does for a corrupt one.
  Covered by a test that opens a v1 file.
- **Ordering.** The PR is stacked on #3502's branch. #3502 says it must be reworked after the redesign;
  the additions here are independent tables and one meta field, so they should rebase with it.
- **Conflicts to expect with milestone 5.** `getSidebarThreads` (`controller/projects.ts`),
  `projects-pane.ts` and `activity-model.ts` are also touched by #3467, #3484, #3488 and #3489.

## What the spike builds

Data layer (`packages/thread-store`):

- `Thread.sideChat` and `Thread.links` (`thread-types.ts`); pure `side-chat.ts` and `thread-links.ts`.
- `SqliteThreadIndex` schema v2: `side_chats` and `links` tables, `sideChatsOf`, `linksOf`, `backlinks`.
  A full rebuild skips clearing those tables per thread (they were just emptied), guarded for a
  repeated id.
- `thread-store.ts`: links are recorded in the same meta write that records PR refs (one write per
  message). Renderer metadata patches union with recorded links instead of replacing them, because the
  renderer's copy can lag. New `lookupSideChats` and `lookupThreadBacklinks`.

App:

- `threads:backlinks` IPC (`API_PROTOCOL_VERSION` 44, manifest regenerated).
- `controller/side-chat.ts`: `startSideChat` (opens beside the thread by default, or as the thread),
  `sendSideChatMessage` (drives the side chat through its own id, queueing behind a running turn),
  `promoteSideChat`. Store helpers for archive and delete cascade and `restoreThread`.
- **`side-chat` right-panel mode** (`side-chat-panel.ts`): the thread's side chats as a list, one chat
  with its read-only context line, a transcript rendered through the app's markdown pipeline and
  redrawn once per frame while streaming, suggestions for an empty chat, a composer, Archive/Restore and
  Promote. Showing a chat counts as reading it.
- **`context` right-panel mode** (`thread-context-model.ts`, `thread-context-panel.ts`): repos, side
  chats, links and references, subagents, "mentioned in". Side chat rows open the Side chat panel.
- Conversation: a hover "Side chat" action on prompts and replies, and a chip under a branched message
  that reopens the chat. Titlebar controls for both modes, Side chat with a count badge.
- Sidebar and Activity hide side chats; unread rolls up to the parent row.
- Pop-out plumbing for both modes (window title and IPC allow-list; not exercised in a real pop-out).
- Demo scenario `side-chats-context` and the spec `tests/demo/side-chats-context.demo.ts`.
- `scripts/prototypes/side-chats-links/bench-links.mts`, the synthetic benchmark behind the numbers below.

## Decisions made without you, so they can be reversed

1. **A side chat is an ordinary thread** with a link, not a new store. It reuses persistence, models,
   usage, archive and the index. Cost: every thread consumer must know to treat them specially.
2. **No nesting.** A side chat cannot start a side chat (the builder returns null).
3. **Context is a snapshot.** History is seeded once from the parent through the anchor, via
   `threads:fork`. Later parent edits are not seen. This matches the prototype's "reads up to here".
4. **The side chat panel drives its thread directly.** It is a small view, not the conversation view:
   plain text for the user's turns, the app's markdown for replies, tool calls as names only. No
   attachments, slash commands, approvals UI or model picker. Reusing the full conversation view for a
   second thread is the larger refactor the placement decision needs.
5. **Archive and delete cascade from the parent.** Archiving a side chat alone leaves the parent alone.
   Without the delete cascade a hidden side chat would be unreachable once its parent was gone.
6. **Orphans stay visible.** A side chat whose parent is not in the list is shown like any thread.
7. **An empty side chat is never "blank".** The store prunes blank threads and the autosave reconciler
   then deletes them from disk, which would delete a fresh side chat on the first switch away.
8. **Promote builds a new thread and archives the side chat**, rather than detaching it in place,
   because persistence writes new messages only as they are appended.
9. **Links are recorded, append-only and capped** (200 per thread). PR URLs are excluded because the PR
   model owns them. Only message text is read; `@`-thread chips cannot be indexed because they store
   only a label.
10. **`⌘/` is not bound.** The prototype uses it to branch from the last reply, but the app already
    binds it to the keyboard-shortcuts dialog. Pick another binding or a command-palette entry.
11. **The accent colour marks side chats**, not the prototype's purple.
12. **The Context and Side chat buttons are always visible and Context is not the default opener**, so
    existing panel e2e specs are unchanged. The titlebar reference screenshot changes by design (two
    more icons) and needs a CI re-render.

## Findings from reviewing the screenshots

The assertions passed before the screenshots were viewed. Viewing them found real defects: the context
banner and its button clipped at the right edge (a `nowrap` class widening a grid track), a side chat row
overflowing the panel horizontally, and a spec that archived the wrong side chat. Two style tests also
caught an accent rail on a non-nesting element and a hard-coded line-height. A conversation test
asserted "replies have no `.msg-actions`", which the new hover action intentionally changes, and was
rewritten to say what it meant (no fork or resend on replies).

## Validation

Code head `5d844f4`; later changes are this report and the deletion of one obsolete reference
screenshot (the `screenshot-producers` test caught it and passes afterwards). Linux sandbox, Node
24.20.0, Chromium 141 with a matching chromedriver (the repo's default driver download is blocked here).
**Not validated on macOS, and no real Electron run:** the Electron native rebuild needs headers the
sandbox proxy blocks, so there is no native e2e and no real main-process IPC test of `threads:backlinks`
beyond the handler's typecheck and the store-level tests.

Both branches were rebased onto main (`26f9cf4`, which now contains the whole milestone 5 stack).
Conflicts were in the API protocol version, `demo-scenarios.ts`, the PR pane (main's new list and
overflow-menu layout), the archive path (main now persists a worktree retirement) and some tests. The
SQLite branch needed v43 and this one v44.

- **52 new tests, all passing.** `side-chat` (7), `thread-links` (6), store and index integration (7),
  the side chat controller (10: start, send, queue, promote), the Side chat panel (5), the Context
  model (5) and panel (4), store helpers for archive, delete, restore and blank-prune (6), sidebar and
  Activity hiding (1), conversation action and chip (1 new, 1 rewritten). Renderer, shared and
  thread-store: 3,918 passed, 0 failed.
- **Browser demo `tests/demo/side-chats-context.demo.ts`: 7 passed.** It covers the anchor chip and
  roll-up dot; the Context sections; opening a side chat beside the main thread; asking in it and
  getting the reply there; the hover action and suggestions; promote; and archive and restore, with a
  horizontal-overflow guard. The titlebar and VNC demo specs still pass (5). On the SQLite branch both
  PR relationship demo specs pass (4) after the rebase.
- **`pnpm run check:local`: exit 0** on both branches (e2e syntax, typecheck, type coverage, lint in
  all four shards, format, demo-site sync, dead code, oracle, e2e exclusions).
- **Full unit tier (`pnpm test`) on this branch: 13,411 tests, 13,368 passed, 12 failed, 9 cancelled,
  22 skipped. The full gate is not green.** Eleven of the failures are sandbox or toolchain tests
  (bubblewrap and socat missing, uv/pip/Go/Cargo preparation, SSH transport, commit signing,
  semantic-index quit timing), the same files as before the rebase. The twelfth was
  `screenshot-producers`, which I fixed. The earlier comparison of those files against the then-#3502
  head (155 passed, 9 failed, 9 cancelled there, 156 / 8 / 9 here) was not repeated after the rebase.
- **API protocol: v43 to v44.** `gen-api-protocol --compare-ref` against the rebased SQLite branch
  exits 0 and classifies 2 additive and 16 changes as breaking, caused by widening `RightPanelMode`
  and the optional `sideChat` and `links` fields on `Thread`. The manifest is current.
- **Oracle:** `HIGH` is not claimed. It reported broad coverage (shared types, IPC, persisted data), so
  the full-check rule applies and the fast path was not used.

### Measurements

Synthetic and single-run, taken before the rebase on the then-current index code, which the rebase
did not change. They exclude IPC and rendering. Treat them as orders of magnitude.

- **Cost when the features are unused**, #3502's profiler, schema v1 against v2, 1,000 / 10,000 threads:
  full rebuild 502 / 4,104 ms against 512 / 4,339 ms (+2% / +6%), reopen 37 / 223 ms against 45 / 254 ms,
  index size 3.09 / 59.72 MB against 3.14 / 59.78 MB (+0.1%). Before skipping the redundant per-thread
  deletes on a fresh rebuild the 10,000-thread overhead was about +10%.
- **Cost when used**, `bench-links.mts`, 10,000 threads, 1,000 side chats, 50,000 link rows over 2,000
  URLs: rebuild 795 ms, index 11.2 MiB, backlink lookup 0.45 ms median and 0.76 ms p95, side chats of a
  thread 0.02 ms, links of a thread 0.02 ms. This fixture carries no PR refs, so its rebuild time is not
  comparable to the profiler's.

### Visual evidence

Reviewed after capture.

- `tests/e2e/screenshots/side-chat-beside-main-thread.png`: a side chat open beside the main thread,
  with the chips list, read-only context line, transcript and composer.
- `tests/e2e/screenshots/side-chat-anchor-chip.png`: the chip under the branched message, with an
  unread dot.
- `tests/e2e/screenshots/side-chat-new-with-suggestions.png`: a new side chat from the hover action.
- `tests/e2e/screenshots/side-chat-promoted-to-thread.png`: after Promote to thread.
- `tests/e2e/screenshots/side-chats-context-panel.png`: the Context panel.
- `tests/e2e/screenshots/side-chat-unread-rollup-sidebar.png`: the unread dot on the parent row.
- `tests/e2e/screenshots/side-chats-archive-restore.png`: archive and restore in the Context panel.

## Remaining work

- **Per-thread panel instance registry and slot layout** (design first); the panel switcher variant and
  gutter. These decide how side chats, browsers and terminals share the right panel.
- A hidden side chat can need approval or ask a question and nothing surfaces it today. Decide whether
  Activity's "Needs you" lists them. A side chat also runs tools in the same checkout as its parent.
- "Send summary to main" (needs a way for the note to reach the parent's agent), a per-side-chat model
  picker, re-sync, `⌘/` or another binding.
- Reuse the full conversation view (attachments, approvals, tool cards) in the side chat panel.
- Usage attribution: side chat spend is on its own thread, not the parent's footer.
- Legacy threads have no recorded links, so backlinks are incomplete until they are backfilled. #3502
  measured 1.5 s per 1,000 unscanned chats for the PR equivalent; the same cost applies here.
- Unread roll-up covers the active project only.
- Make the Context panel the default right-panel opener and gate it appropriately.
- The `lookupSideChats` decision above.
- Validate on macOS and in real Electron.

## Suggested slices for the milestone

1. Land #3502 (or its rework), then this data layer: `sideChat`, `links`, index v2, cascade and
   blank-prune guard. Low UI risk, high persistence risk.
2. Side chat creation and the hidden, unread and archive behaviour in the sidebar and Activity.
3. The Side chat panel and the message action and chip (this spike's panel), then reuse of the full
   conversation view.
4. Context panel as a mode, then as the default opener.
5. Per-thread instance registry and slot layout, then the switcher variant and gutter.
6. Summary, the narrow-layout dot, then the Activity PR list and PR mode.

## How to run it

```bash
pnpm run build:demo
pnpm exec wdio run wdio.demo.conf.ts --spec tests/demo/side-chats-context.demo.ts
node scripts/prototypes/side-chats-links/bench-links.mts 10000
```

If the default chromedriver download is blocked, point `COPSE_DEMO_CHROME_BINARY` and
`COPSE_DEMO_CHROMEDRIVER_BINARY` at a matching pair.

Or open the demo with `?scenario=side-chats-context` and click the Context button.
