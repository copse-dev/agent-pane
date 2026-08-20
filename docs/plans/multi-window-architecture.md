# Multiple main windows

Status: **Active.** The multiple-window registry and New Window foundation have landed. Per-window navigation and restoration are in progress; concurrent agent routing remains gated. Profile and account picking are explicitly deferred to follow-up work.

## Outcome

A user can open two or more complete Copse windows, move each window to a different physical display, and work in a different project or thread in each window. The windows can run agents concurrently without commands, events, prompts, or persisted navigation leaking to whichever window was opened or focused most recently.

This is not a plan for splitting one renderer into several chat panels. Each surface is a full `BrowserWindow` with the ordinary titlebar, project list, conversation, composer, and right panel.

## Why this exists

The project began with one full main window and these singleton assumptions:

- `src/main/windows/create-main-window.ts` exposed one `getMainWindow()` compatibility target.
- `src/main/index.ts` created one window and several process services sent renderer events through that target.
- `src/main/ipc/register-handlers.ts` registered against that window, while `assertMainFrameSender` in `src/main/ipc/ipc-guards.ts` validated against it.
- `src/main/windows/app-menu.ts` captured one window for native-menu commands.
- renderer stores were naturally separate per renderer, but `activeProjectId`, workspace helpers, and persistence contained single-active-context assumptions.
- `windowBounds` recorded one geometry in settings.

PR 1 replaced the window and menu singletons with a registry and focused-window dispatch. The remaining compatibility target, process-global workspace services, event sinks, and legacy navigation keys are now migration scaffolding rather than the intended final authority.

Pane popouts are not the desired feature. `src/main/windows/create-popout-window.ts` creates a restricted secondary window and `src/renderer/main.ts` deliberately omits ordinary main-window ownership in popout mode. Existing popouts remain secondary views owned by a main window.

## Scope

The first project delivers:

1. A **File → New Window** command that creates another complete main window in the current app process.
2. Independent project, thread, renderer layout, and navigation state in each window.
3. Correct routing of IPC requests and asynchronous events to the originating or owning window.
4. Concurrent agent runs in different windows.
5. Per-window bounds, display, maximized state, and fullscreen restoration.
6. Safe behavior when a saved or connected display is unavailable.
7. Independent close confirmation and cleanup, plus aggregate application quit behavior.
8. Focused multi-window tests and visual evidence.

## Explicitly deferred

The following are separate follow-up projects:

- profile or account definitions;
- profile pickers in the titlebar, launch flow, or Settings;
- per-window provider credentials or account-specific models;
- isolated browser cookie jars or MCP registries per account;
- separate Electron processes or separate `userData` directories;
- arbitrary renderer splits within one OS window;
- converting a pane popout into a full main window;
- multiple simultaneous popouts per main window;
- collaboration or cross-device synchronization.

All windows in this project use the same current settings, provider credentials, projects, thread store, and application process.

## Binding decisions

### 1. One process, many main windows

Keep `app.requestSingleInstanceLock()`. New windows are created inside the existing Electron main process. A second OS launch focuses the most recently focused main window; it does not create a second process.

This preserves process-global services and avoids treating `COPSE_PANEL_USER_DATA` as a per-window mechanism. Electron's `userData` path is process-wide.

### 2. Stable window identity

Every full main window receives an opaque, stable `windowId`. The ID is persisted with its restoration record and is not derived from project ID: two windows may show the same project, and a window may switch projects.

The main process derives the authoritative window from `event.sender` or `event.senderFrame`. Renderer-supplied window IDs are routing hints only and cannot establish IPC authority.

### 3. Window-local navigation, shared durable work

These values are window-local:

- active project and thread;
- right-panel mode and visibility;
- renderer layout and transient navigation;
- bounds, display, maximized, and fullscreen state;
- focused/last-used ordering;
- child popout ownership.

These remain shared:

- projects list;
- thread directories and messages;
- provider and application settings;
- MCP configuration;
- application update and global service state.

A window changing its active project must not change another window's active project. A project being added or removed is shared and should be broadcast to every window.

### 4. Register IPC handlers once

Named `ipcMain.handle` handlers are process-global and must be registered once. They resolve a registered main-window context from the sender for every request rather than being registered again for each window.

The trusted-frame mechanism continues to distinguish app-created frames. Main windows and pane popouts must remain distinguishable because a popout does not own a complete renderer context.

### 5. Every event has an explicit routing policy

Every main-to-renderer event is classified as one of:

- **owner-routed** — sent to the window that owns the operation;
- **broadcast** — sent to all full main windows because the state is shared;
- **focused-window** — sent to the currently focused full main window for a user action with no prior owner.

Using `getMainWindow()` without such a policy is not acceptable in the completed architecture.

Owner-routed operations capture immutable identity when they begin:

```ts
interface OperationOwner {
  windowId: string
  projectId: string
  threadId: string
  runId?: string
}
```

The code must not look up the focused window after an `await` to decide where output or a prompt belongs.

### 6. Popouts belong to a main window

The existing pane-popout behavior remains restricted and secondary. A popout records its `ownerWindowId`; closing its owner closes the popout. Popout requests and seed state resolve against the owner window, not a process-global active project.

`src/main/services/popout-seed-store.ts` currently keys transient seeds only by pane mode. Its key must include the owner window so two main windows cannot overwrite one another's seed before a popout consumes it.

Supporting more than one popout per owner or moving popouts between owners is deferred.

### 7. Restore only windows that were intentionally open

Persist a restoration record for each full main window after it is created. On an ordinary app launch, restore the previously open set. Closing a window removes its record; quitting the app preserves records for the windows that were open when quit began.

The implementation must distinguish "close this window" from "quit Copse" so application quit does not accidentally erase the restoration set one window at a time.

## Minimum data contract

The persisted schema should be versioned and decoded at the main-process storage boundary. Exact naming may follow existing settings conventions, but the minimum record is:

```ts
interface MainWindowRecord {
  id: string
  activeProjectId: string | null
  activeThreadId: string | null
  bounds: {
    x?: number
    y?: number
    width: number
    height: number
  }
  displayId?: string
  maximized: boolean
  fullscreen: boolean
  lastFocusedAt: number
}

interface MainWindowState {
  version: 1
  windows: MainWindowRecord[]
}
```

Do not persist renderer secrets or duplicate thread data in this record. Additional renderer layout fields should be added only when their current persistence cannot remain naturally window-local.

### Migration

An installation with only the legacy `windowBounds`, `activeProjectId`, and `activeThreadId` starts with one generated window record. Existing values seed that record. The migration is idempotent, retains valid legacy data until the new record is durably written, and does not move projects or thread directories.

## Main-process architecture

### Window registry

Replace the singleton with a registry, for example:

```ts
interface MainWindowContext {
  id: string
  window: BrowserWindow
}

interface MainWindowRegistry {
  create(record?: MainWindowRecord): MainWindowContext
  get(windowId: string): MainWindowContext | undefined
  fromWebContents(contents: WebContents): MainWindowContext | undefined
  getFocused(): MainWindowContext | undefined
  list(): MainWindowContext[]
  send(windowId: string, channel: string, ...args: unknown[]): boolean
  broadcast(channel: string, ...args: unknown[]): void
}
```

The registry owns:

- creation and registration;
- typed frame metadata that distinguishes a full main window from a popout and records a popout's owner;
- trusted-frame registration and removal;
- current focus and most-recently-focused ordering;
- window-record updates;
- removal after close;
- association between main windows and child popouts.

`src/main/windows/app-frames.ts` currently records only a boolean trusted-frame membership. Its contract must grow to return the typed frame metadata above, and the `assertMainFrameSender` signature and callers must migrate accordingly.

Keep a short-lived compatibility helper only while callers are migrated. It must not silently choose a window when ownership is ambiguous. The terminal state has no ambiguous `getMainWindow()` event routing.

### IPC guards and handler registration

`registerAllHandlers` is invoked once. Guards resolve the sender to either:

- a registered full main-window frame;
- a registered popout frame with an owning main window; or
- an untrusted frame, which is rejected.

Handlers that need project or thread identity continue validating explicit IDs and execution roots. Sender-derived window identity does not replace project/thread authorization; it adds the missing UI owner.

### Service routing audit

The implementation PRs must inventory all current singleton sends, including at least:

- agent chunks and hook queue messages;
- shell output;
- context-estimate refreshes;
- canvas artefacts;
- approvals, ask-user requests, user alerts, and SSH prompts;
- diff queue and filesystem watcher events;
- terminal commands and output;
- browser events;
- automation and supervisor events;
- MCP status changes.

For each channel, tests or code structure must make the owner/broadcast/focused policy visible. Getter-based sinks that currently call `getMainWindow()` at emission time must accept owner identity or be invoked inside an owner-preserving context; sender-derived IPC context alone does not fix delayed service callbacks.

### Native menus and shortcuts

The application menu does not capture the first-created window. Menu callbacks resolve `BrowserWindow.getFocusedWindow()`, verify that it is a registered full main window, and send the command there. Electron-provided window roles such as minimize and bring-to-front must be verified against two real main windows in PR 1.

Add **File → New Window** with the platform-appropriate shortcut. Existing project, thread, Settings, and panel commands target the focused main window.

`registerDevtoolsShortcut` currently installs a process-global shortcut that closes over one window. It must either resolve the focused registered main window when invoked or be replaced with a focused-window menu accelerator; registering the same `globalShortcut` once per window is invalid.

### Close and quit

Each full main window has its own close gate. Closing one window asks only about work that window owns and does not terminate unrelated windows or process-global services.

Application quit:

1. marks the registry as quitting;
2. requests confirmation for every window that needs it;
3. aborts quit if any confirmation is declined;
4. durably saves the intended restoration records and final window state;
5. runs process-global cleanup once;
6. allows all windows to close.

The save in step 4 must complete before `cleanupBeforeQuit()` tears down services or the updater/process exits. Quit-time close events must not delete records that were deliberately preserved.

`src/main/services/close-confirm.ts` currently binds one module-level gate to one window. Multi-window support requires independent pending state and timeouts per window, plus an aggregate quit coordinator. The UI may ask windows in parallel, but a response or timeout for one window must never release another window's gate.

If an owner window closes while its agent run remains active, the first implementation may cancel that run as part of confirmed close. Silently rerouting approvals or output to another window is not allowed. Keeping orphaned runs alive is a follow-up unless existing run semantics already make it safe.

## Renderer architecture

Each full `BrowserWindow` loads the normal renderer and creates its own `AppStore`. A bootstrap IPC call supplies the window record before project/thread hydration.

Renderer persistence must stop writing process-global active-project or active-thread keys as the authority. This migration includes `src/main/services/workspace.ts`, the renderer persistence controller, storage-key guards, and startup hydration—not just the in-memory `AppStore`. Navigation updates are written through window-scoped IPC using the sender-derived context.

Shared mutations, such as adding a project, emit a broadcast so every renderer refreshes or applies the change. Window-local mutations do not broadcast.

Thread execution and cancellation remain thread-scoped. Existing running-thread and abort coordination must enforce one active run per thread across every window; a second renderer must not bypass that guard by presenting a separate UI owner.

The plan does not introduce a cross-window renderer bus. Main-process IPC remains the coordination boundary.

## Display and bounds behavior

Extend the existing `sanitizeBounds` behavior rather than replacing it.

For every window:

1. Persist normal bounds separately from maximized/fullscreen state.
2. Record the display ID containing the largest part of the window.
3. On restore, use the saved display when it still exists.
4. Clamp width and height to the selected display's work area and keep a reachable portion of the titlebar visible.
5. If the display is gone, place the window on the primary display at a reasonable size.
6. Apply maximized or fullscreen state after the window is ready.
7. Debounce move/resize persistence; also make a final synchronous or awaited save during controlled close.
8. Re-sanitize stranded windows after display removal or work-area changes.

A newly requested window uses the focused window's display and cascades from its bounds. If no main window is focused, it uses the display nearest the cursor or the primary display.

## Delivery plan

The implementation should be a short PR series rather than one large PR.

### PR 1 — Registry and second full window ✅

Landed. The temporary primary-window agent gate remains intentionally in place until owner-routed execution is complete.

Deliver:

- main-window registry and stable IDs;
- **File → New Window**;
- focused-window native-menu dispatch;
- full renderer startup in each window;
- registry lifecycle and trusted-frame tests;
- temporary compatibility routing where necessary, clearly marked for removal.

Acceptance:

- two complete main windows can be opened in one app process;
- either can be moved or fullscreened on another display;
- menu commands act on the focused window;
- closing the second window leaves the first usable;
- no duplicate IPC handler registration occurs.

This PR does not claim concurrent agent correctness yet. If unsafe actions remain singleton-routed, gate or disable starting an agent in secondary windows until PR 3 rather than risk cross-window leakage.

### PR 2 — Window-local state and restoration (in progress)

The first slice introduces versioned window records, sender-derived project/thread navigation, per-window geometry, startup restoration, and close-versus-quit record preservation. Shared-project broadcasts, per-window popout ownership, aggregate close handling, and live display-change recovery remain before this phase is complete.

Deliver:

- versioned `MainWindowRecord` persistence and migration;
- per-window project and thread navigation;
- shared-project broadcasts;
- normal bounds, display, maximized, and fullscreen restoration;
- disconnected-display sanitization;
- close-versus-quit restoration semantics;
- per-window popout ownership.

Acceptance:

- two windows retain different active projects and threads;
- changing navigation in one does not alter the other;
- app restart restores the intended window set and locations;
- removing a monitor never leaves a restored window unreachable;
- the legacy single-window configuration migrates without losing projects or threads.

### PR 3 — Concurrent operation and event routing

Deliver:

- sender-derived window context throughout IPC;
- explicit operation ownership;
- owner routing for agent, shell, approval, ask-user, terminal, diff, canvas, browser, and watcher events;
- explicit broadcast policies for shared status;
- removal of ambiguous singleton window sends;
- per-window close behavior for active runs.

Acceptance:

- agents can run concurrently in two windows on different threads;
- streaming, prompts, approvals, tool output, cancellation, and completion appear only in the owning window;
- focusing another window during a run does not change routing;
- closing one window does not terminate or corrupt work owned by another;
- the same thread cannot start conflicting concurrent runs merely because it is visible in two windows.

### PR 4 — UX and final validation

Deliver:

- polished New Window affordances and empty-window behavior;
- keyboard and accessibility review;
- display placement refinements;
- focused WebdriverIO multi-window coverage and screenshots;
- documentation updates and removal of migration scaffolding that is no longer needed.

Acceptance:

- multi-window creation and navigation work from keyboard and native menus;
- screenshots demonstrate two complete Copse windows and independent context;
- `npm run check`, `npm run build`, and the focused Electron e2e suite pass;
- the test oracle is reviewed and any low-confidence blind spots receive targeted tests.

PR 4 may be folded into the earlier PRs if each visible slice already carries its required focused visual eval.

## Test strategy

Prefer unit tests for deterministic routing and persistence, reserving Electron e2e for real window behavior.

### Unit and component tests

- registry create, focus, lookup, and removal;
- sender-frame resolution and rejection of unknown frames;
- channel routing policy;
- migration from legacy singleton settings;
- bounds sanitization across disconnected and resized displays;
- restoration-set behavior for close versus quit;
- window-local persistence serialization;
- shared project update propagation;
- close gates for multiple windows;
- operation owner surviving focus changes.

### Electron e2e

A focused spec must:

1. launch one main window;
2. create a second via the product command;
3. assign different projects or threads;
4. verify independent visible state;
5. start controlled mock runs in both windows;
6. verify each receives only its own stream and tool UI;
7. close one window and prove the other remains interactive;
8. capture reviewable screenshots.

Display restoration should use unit-tested geometry plus the real Electron window APIs. The focused e2e must pass in a single-display environment and assert window/state independence without requiring a second monitor. CI cannot reliably emulate every physical-monitor arrangement; on-machine evaluation should separately cover placement/fullscreen behavior on multiple displays before the final PR merges.

## Risks and mitigations

### Last-writer-wins navigation

The existing global active-project/thread persistence can make one renderer overwrite another. Mitigation: migrate authority to window records before claiming independent navigation.

### Event leakage

A singleton `getMainWindow()` send can place credentials, prompts, shell output, or agent output in the wrong window. Mitigation: secondary-window agent starts remain gated until the routing audit is complete.

### Duplicate IPC registration

Registering named handlers once per window can throw or create inconsistent behavior. Mitigation: process-global registration with sender-derived context.

### Same thread in two windows

Two renderers may display the same thread and attempt conflicting writes or runs. Initial policy: both may view it, but the existing run coordinator must enforce at most one active run per thread. Shared thread updates are broadcast so the other view can refresh. Simultaneous draft editing semantics are not part of this project.

### Closing an owner window

Prompts and output have nowhere safe to go after the owner disappears. Initial policy: confirmed close cancels window-owned active runs unless the operation has already completed. Never silently transfer ownership.

### Process-global services

MCP servers, browser sessions, terminals, watchers, and caches may hold singleton UI callbacks. Mitigation: keep service instances global where appropriate, but make every UI subscription and operation carry explicit ownership.

### Physical display variance

Display IDs and work areas change across docks, remote desktops, and operating systems. Mitigation: treat display ID as a preference, always sanitize against current work areas, and preserve a reachable fallback.

## Success criteria

The project is complete when:

- a user can keep at least two full Copse windows on separate monitors;
- each window retains independent project, thread, layout, and geometry;
- both windows can run work concurrently without cross-routed output or prompts;
- closing, quitting, restarting, or disconnecting a display does not lose durable work or strand windows;
- no production event path depends on an ambiguous singleton main window;
- the legacy one-window experience remains unchanged for users who never choose New Window;
- profile/account behavior remains unchanged and is clearly tracked as follow-up rather than partially implemented here.

## Follow-up: profiles and account picking

A later plan should define named execution profiles, encrypted per-profile credentials, provider/model discovery isolation, externally authenticated ACP agents, browser/MCP session boundaries, and a per-window picker. The multi-window work prepares for that follow-up by using stable window IDs and explicit operation ownership, but this project must not add placeholder profile fields or migrate credentials speculatively.

## What would make this plan wrong

Revisit this plan if Electron requires materially separate processes to provide the needed display behavior, if shared thread-store semantics cannot safely support concurrent renderer readers, or if the product requirement changes from independent full windows to split panels inside one window. Profile requirements alone do not invalidate this plan; they extend the window context in follow-up work.
