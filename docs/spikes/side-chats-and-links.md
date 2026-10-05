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

| Design element (#3538)                                                                                           | The app today                                                                      | Needs building                                                                                                           | In this spike                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Side chat as a thread branched from a message, own model                                                         | Forks copy the transcript; no anchored, hidden, child thread                       | `sideChat` link on thread metadata, creation, history seeding                                                            | **Yes.** `sideChat: {parentThreadId, anchorMessageId}`; history seeded once through the existing `threads:fork` path           |
| Hidden by default, archived rather than deleted, unread dot                                                      | Archive exists; no hidden threads; unread dot per row                              | Browser filters, archive/delete cascade, roll-up dot                                                                     | **Yes.** Hidden from sidebar and Activity; archive and delete cascade; unread rolls up to the parent row; orphans stay visible |
| Per-thread Context panel: repos, links and references, subagents                                                 | Seven right-panel modes, none per-thread context                                   | A `context` mode, a thread-context model, link recording                                                                 | **Yes** as a new mode (not yet the default opener)                                                                             |
| "Mentioned in" and other thread-to-thread references                                                             | `@`-thread chips record only a label; PRs have the #3502 relation model            | Recorded links, a backlink index                                                                                         | **Yes** for `copse://thread/<id>` and `copse.dev/open` links in message text, plus web URLs, indexed in SQLite                 |
| Side chat shown beside the main thread (drawer, margin, tray, or rail slot)                                      | One conversation view bound to the active thread                                   | A second conversation host, or a panel slot that can host a chat. Placement is undecided (`side-chats.html` avenues A-E) | **No.** A side chat opens as the main thread; the Context panel banner links back                                              |
| Hover "Side chat" on a message, `⌘/`                                                                             | No message action                                                                  | Message action and shortcut calling `startSideChat(anchor)`                                                              | **Partly.** `startSideChat` takes an anchor; the only trigger is the Context panel button (latest settled message)             |
| "Send summary to main", "Promote to thread", re-sync                                                             | None                                                                               | Summary generation (model call), a promote transform, re-seed                                                            | **No**                                                                                                                         |
| Per-thread panel instances: several browsers/terminals/side chats, at most two slots, pinning, reuse rules, rail | One `rightPanelMode`; instances exist only inside a mode (browser tabs, terminals) | A thread-scoped instance registry and slot layout (`side-chats-instances.html`), replacing mode-per-button               | **No.** The biggest piece; see slices below                                                                                    |
| Panel switcher variants (top bar, right rail, C/n strips) with a gutter for thread actions                       | Titlebar text-button cluster with portrait overflow                                | Chosen variant, rail component, gutter                                                                                   | **No.** The prototype notes the C-shape side panel was not working at last review                                              |
| Narrow and portrait layouts, sidebar dot instead of bell                                                         | Portrait chrome exists                                                             | Dot-for-bell in narrow mode                                                                                              | **Partly.** The roll-up dot exists; the bell swap does not                                                                     |
| Activity screen: wide multi-repo PR list, full PR mode hiding menu and gutter                                    | Activity stack is open as #3467, #3475, #3484, #3488, #3489 (milestone 5)          | Multi-repo PR list, PR mode                                                                                              | **No.** Depends on the milestone 5 stack                                                                                       |

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

- `threads:backlinks` IPC (`API_PROTOCOL_VERSION` 42 to 43, manifest regenerated).
- `controller/side-chat.ts` `startSideChat`; store helpers for archive/delete cascade and `restoreThread`.
- `context` right-panel mode: `thread-context-model.ts` (pure), `thread-context-panel.ts` (DOM and
  mount), `thread-context.css`, titlebar control, pop-out plumbing (window title and IPC allow-list; not exercised in a real pop-out).
- Sidebar and Activity hide side chats; unread rolls up to the parent row.
- Demo scenario `side-chats-context` and the spec `tests/demo/side-chats-context.demo.ts`.
- `scripts/prototypes/side-chats-links/bench-links.mts`, the synthetic benchmark behind the numbers below.

## Decisions made without you, so they can be reversed

1. **A side chat is an ordinary thread** with a link, not a new store. It reuses persistence, models,
   usage, archive and the index. Cost: every thread consumer must know to treat them specially.
2. **No nesting.** A side chat cannot start a side chat (the builder returns null).
3. **Context is a snapshot.** History is seeded once from the parent through the anchor, via
   `threads:fork`. Later parent edits are not seen. This matches the prototype's "reads up to here".
4. **Archive and delete cascade from the parent.** Archiving a side chat alone returns focus to the
   parent. Without the delete cascade a hidden side chat would be unreachable once its parent was gone.
5. **Orphans stay visible.** A side chat whose parent is not in the list is shown like any thread.
6. **An empty side chat is never "blank".** The store prunes blank threads and the autosave reconciler
   then deletes them from disk, which would delete a fresh side chat on the first switch away. A test
   guards this.
7. **Links are recorded, append-only and capped** (200 per thread). PR URLs are excluded because the PR
   model owns them. Only message text is read; `@`-thread chips cannot be indexed because they store
   only a label.
8. **The Context button is always visible and the mode is not the default opener.** Making it the
   default opener changes what the existing panel button does and would churn existing e2e specs.

## Findings from reviewing the screenshots

The assertions passed before the screenshots were viewed. Viewing them found a real defect: the
side-chat banner and the disabled "New side chat" button were clipped at the right edge because the
banner reused a `nowrap` class and widened its grid track. Fixed with `minmax(0, 1fr)` and a wrapping
note class, then re-captured. Two further observations remain open: while a side chat is the open
thread, no sidebar row is highlighted (the prototype shows it as a sub-row of its parent), and the
side chat's own conversation area is empty because it opens in the main view.

## Validation

Code head `e11c8a7` (this report and the benchmark script are the only later changes). Linux sandbox,
Node 24.20.0, Chromium 141 with a matching chromedriver (the repo's default driver download is blocked
here). **Not validated on macOS, and no real Electron run:** the Electron native rebuild needs headers the
sandbox proxy blocks, so there is no native e2e and no real main-process IPC test of `threads:backlinks`
beyond the handler's typecheck and the store-level tests.

- **New and changed focused tests: 41 added, all passing.** `side-chat` (7), `thread-links` (6),
  store and index integration (7), `startSideChat` (5), Context model (5), Context panel DOM and mount (4),
  store helpers for archive/delete/restore/blank-prune (6), sidebar and Activity hiding (1). The focused
  run over every touched test file: 145 passed, 0 failed.
- **Browser demo, `tests/demo/side-chats-context.demo.ts`: 4 passed.** Steps: hidden side chats and the
  parent roll-up dot; every Context section with its counts; opening a side chat and returning;
  create, archive and restore, including a horizontal-overflow guard. The existing
  `pr-thread-relationships` demo spec still passes (2). One cold-start hook timeout (90 s) occurred right
  after a demo rebuild and the retry passed; later runs of the finished spec passed on the first attempt.
- **`pnpm run check:local`: exit 0** (e2e syntax, typecheck, type coverage, lint in all four shards,
  format, demo-site sync, dead code, oracle, e2e exclusions).
- **Full unit tier (`pnpm test`): 13,043 tests, 13,000 passed, 12 failed, 9 cancelled, 22 skipped.**
  Every failure is a sandbox or toolchain test (bubblewrap and socat missing, uv/pip/Go/Cargo
  preparation, SSH transport, commit signing, semantic-index quit timing). The Python preparation file
  hangs in this sandbox, so its worker was terminated to let the run finish; its cancelled tests are
  counted above. None are in thread storage, the renderer, shared code or IPC. **The full gate is not
  green.**
- **Same failures on the untouched #3502 head.** Re-running the 173 tests in the failing files on that
  head (in an isolated worktree, so it ran its own `@copse` packages): 155 passed, 9 failed, 9 cancelled,
  against 156 passed, 8 failed, 9 cancelled here.
- **API protocol: v42 to v43.** `gen-api-protocol --compare-ref` exits 0 and classifies 2 additive and 16
  changes as breaking, caused by widening `RightPanelMode` and the optional `sideChat` and `links` fields on
  `Thread`. The manifest is current.
- **Oracle:** `HIGH` is not claimed. It reported broad coverage (shared types, IPC, persisted data), so
  the full-check rule applies and the fast path was not used.

### Measurements

Synthetic and single-run; they exclude IPC and rendering. Treat them as orders of magnitude.

- **Cost when the features are unused**, #3502's profiler, schema v1 against v2, 1,000 / 10,000 threads:
  full rebuild 502 / 4,104 ms against 512 / 4,339 ms (+2% / +6%), reopen 37 / 223 ms against 45 / 254 ms,
  index size 3.09 / 59.72 MB against 3.14 / 59.78 MB (+0.1%). Before skipping the redundant per-thread
  deletes on a fresh rebuild the 10,000-thread overhead was about +10%.
- **Cost when used**, `bench-links.mts`, 10,000 threads, 1,000 side chats, 50,000 link rows over 2,000
  URLs: rebuild 795 ms, index 11.2 MiB, backlink lookup 0.45 ms median and 0.76 ms p95, side chats of a
  thread 0.02 ms, links of a thread 0.02 ms. This fixture carries no PR refs, so its rebuild time is not
  comparable to the profiler's.

### Visual evidence

Reviewed after capture. Reviewing them found and fixed three defects the assertions had missed: the
clipped banner and button, a horizontally overflowing side chat row, and a spec that archived the wrong
side chat. Two style tests also caught an accent rail on a non-nesting element and a hard-coded
line-height, both fixed.

- `tests/e2e/screenshots/side-chats-context-panel.png`: the Context panel for a thread with side chats,
  links and a subagent.
- `tests/e2e/screenshots/side-chat-open-with-context.png`: an open side chat and its banner.
- `tests/e2e/screenshots/side-chat-unread-rollup-sidebar.png`: the unread dot on the parent row.
- `tests/e2e/screenshots/side-chats-archive-restore.png`: after archiving the new side chat and
  restoring an old one.

## Remaining work

- Decide the side chat placement (drawer, margin, tray or rail slot) and build the host. This is the
  main blocker to the design and needs the instance registry below.
- Per-thread panel instance registry and slot layout; the panel switcher variant; gutter.
- Message hover action and `⌘/`; per-side-chat model picker in the UI (the field is stored and
  inherited, but nothing lets the user choose it).
- "Send summary to main", "Promote to thread".
- A hidden side chat can need approval or ask a question. Today nothing surfaces it. Decide whether
  Activity's "Needs you" lists hidden side chats.
- Usage attribution: side chat spend is on its own thread, not the parent's footer.
- Legacy threads have no recorded links, so backlinks are incomplete until they are backfilled. #3502
  measured 1.5 s per 1,000 unscanned chats for the PR equivalent; the same cost applies here.
- Unread roll-up covers the active project only; other projects' rows are compacted.
- Make the Context panel the default right-panel opener and gate it appropriately.
- The `lookupSideChats` decision above.

## Suggested slices for the milestone

1. Land #3502 (or its rework), then this data layer: `sideChat`, `links`, index v2, cascade and
   blank-prune guard. Low UI risk, high persistence risk.
2. Side chat creation and the hidden/unread/archive behaviour in the sidebar and Activity.
3. Context panel as a mode (this spike's panel), then as the default opener.
4. Per-thread instance registry and slot layout. Design first: it supersedes mode-per-button.
5. Side chat host in a slot, then summary and promote.
6. Switcher variant, gutter, narrow-layout dot, then the Activity PR list and PR mode.

## How to run it

```bash
pnpm run build:demo
pnpm exec wdio run wdio.demo.conf.ts --spec tests/demo/side-chats-context.demo.ts
node scripts/prototypes/side-chats-links/bench-links.mts 10000
```

If the default chromedriver download is blocked, point `COPSE_DEMO_CHROME_BINARY` and
`COPSE_DEMO_CHROMEDRIVER_BINARY` at a matching pair.

Or open the demo with `?scenario=side-chats-context` and click the Context button.
