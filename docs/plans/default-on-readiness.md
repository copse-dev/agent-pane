# Default-on readiness of opt-in features

Status: **Reference** (audit compiled from `main` at `edb1f4419` on 2026-09-25; pull-request,
issue and test-inventory status refreshed at `c4304b6ec`; no defaults changed).

Many features shipped since August are off by default, so the marketing site cannot advertise
them. This audit asks, for each one, whether it is mature enough to turn on for new users. It
covers every experimental first-party plugin and every checkbox under Settings → Experimental
(plus the experimental ACP-over-SSH toggle under Settings → SSH).

Each item was judged on the same criteria: who it is for; test coverage in the enabled state;
open bugs and recent fix churn; per-turn cost and external dependencies; security and
permission scope; failure behaviour; UX polish; and rollout to existing profiles.

**No item is ready to enable today.** Seven are close, and each has a follow-up issue listing the
remaining work. The rest should stay opt-in for the reasons given below. The line numbers cited
are from the audited commit.

## Summary

| Feature                                              | Where gated                                                  | Recommendation                | Key evidence                                                                                                       | Blockers                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| MCP-UI canvas (`copse.mcp-ui-canvas`)                | Plugin manifest; `mcp-registry.ts:466-496`                   | **Enable after X** — sign-off | Enabled-state e2e (`canvas-artefact-refresh`, `browser-session-restore`); layered CSP/opaque-origin/network policy | Plugin toggle does not reload MCP servers; ACP inline path ungated; CSP unit test; migration                       |
| Apple Development (`copse.apple-development`)        | Plugin manifest; `xcodebuildmcp.ts:110-120`                  | **Enable after X** — sign-off | Inert until a project is enrolled; good unit coverage; demo scenario exists                                        | No recorded macOS e2e run (#2719); tool offered on every OS; preview depends on `vncEnabled`; migration            |
| Copse Reviewer (`copse.review`)                      | Plugin manifest; `registry-bootstrap.ts:291-296`             | **Enable after X** — sign-off | Fails closed to read-only review; anchored multi-report history (#2826); seeded-report e2e specs                   | Very new and high-churn; #2519 model visibility; no pipeline e2e; no cost estimate; model-comparison carry-over    |
| Automations (`copse.automations`)                    | Plugin manifest; `automation-service.ts:149,324,351`         | **Enable after X** — sign-off | Inert until a schedule is saved; real cron-boundary e2e (`automation-trigger.e2e.ts`)                              | Unattended runs absent from `shell-permissions.md`; no spend budget; approvals stall runs; dead event-inbox path   |
| Roadmap plans (`copse.roadmap-plans`)                | Plugin manifest; `registry-bootstrap.ts:274-280`             | **Enable after X**            | 17 `roadmap-*.e2e.ts` specs with screenshots, 63-case pane unit suite                                              | `roadmap_plan` writes to the _active_ project, not the thread's; #2510; migration                                  |
| CI investigator (`copse.ci-investigator`)            | Plugin manifest; `registry-bootstrap.ts:396-406`             | **Enable after X**            | Read-only `gh`; unregistered when `gh` is absent or unauthenticated                                                | Follow-up points at `investigate_ci` while `subagentsEnabled` is off; no sync/service tests; migration             |
| Forced planning (`copse.forced-planning`)            | Plugin manifest; `turn-start-hooks.ts:138-158`               | **Enable after X**            | Pure, byte-identical when off, conforms to hooks plan P12                                                          | No recorded steer-eval lift; overlaps todo steering; e2e seed list omits it; doc edits (P12)                       |
| OKF memories (`copse.okf-memories`)                  | Plugin manifest; `registry-bootstrap.ts:254-262`             | Keep opt-in — sign-off        | Pane e2e only; nothing drives `remember`/`recall` in a turn                                                        | Store keyed by the active project; provenance gaps (reported privately); uncapped `recall`                         |
| Long-horizon tasks (`copse.long-horizon-tasks`)      | Plugin manifest; `registry-bootstrap.ts:308-314`             | Keep opt-in — sign-off        | Wakes obey the continuation budget; unit tests only; #558 open                                                     | Store keyed by the active project; no UI; hooks-plan decision 5 omits long-task wakes                              |
| Dark factory (`copse.dark-factory`)                  | Plugin manifest; `dark-factory-sensor.ts:61`                 | Keep opt-in                   | Emits an event nothing subscribes to                                                                               | No consumer; description overstates it; no upgrade seed (see Rollout)                                              |
| Advisor strategy (`copse.advisor-strategy`)          | Plugin manifest; `registry-bootstrap.ts:326-331`             | Keep opt-in — sign-off        | No runner test, no loop e2e                                                                                        | Uncapped transcript; `maxTokens` never applied; Stop does not abort; cross-provider egress without consent         |
| Artifact checkpoint (`copse.artifact-checkpoint`)    | Plugin manifest; `run-agent-loop.ts:1183-1208`               | Keep opt-in                   | Cheap and well-contained; unit tests only                                                                          | Benchmark-shaped steering with no product A/B; wording wrong for research/refactor runs                            |
| PII redaction (`copse.pii-redaction`)                | Plugin manifest; `pii-redactor.ts:91-93`                     | Keep opt-in — sign-off        | Tests use a fake Rampart only                                                                                      | Redacts every URL/IP in coding prompts; fails open silently; placeholder numbering resets on restart               |
| Parallel Search (`copse.parallel-search`)            | Plugin manifest; `registry-bootstrap.ts:460-468`             | Keep opt-in                   | Paid third-party API; enabling _is_ the network consent (`permission-gate.ts:724-735`)                             | By design: needs the user's own key and consent                                                                    |
| DevTools shortcut (`copse.devtools-shortcut`)        | Plugin manifest; `create-main-window.ts:304-336`             | Keep opt-in                   | Developer affordance                                                                                               | `globalShortcut` steals Ctrl+Shift+I system-wide                                                                   |
| Remote desktop viewer (`vncEnabled`)                 | `settings-dialog.ts:300`; `ipc/vnc.ts` (≈11 inline defaults) | Keep opt-in — sign-off        | Good unit and e2e coverage when enabled                                                                            | Discovery (port scan, Bonjour, SSH) runs at every launch; LAN/SSH VNC not separable from local devices; stale copy |
| Next-step tab complete (`nextStepSuggestionEnabled`) | `next-step-service.ts:56`; `next-step-hint.ts:71`            | Keep opt-in                   | Enabled-state e2e with screenshots                                                                                 | Second small-tasks call per turn; can fall back to the chat model; Tab-key accessibility decision                  |
| Unattended container runs (`containerRunsEnabled`)   | `container-run-service.ts:322`; `input-bar.ts:414`           | Keep opt-in — sign-off        | Large unit suite; hardened container design                                                                        | Docker path never run in CI; #2689 draft; security findings reported privately                                     |
| Model classifier (`modelClassifierEnabled`)          | `registry-bootstrap.ts:139-141`                              | Keep opt-in                   | Pure heuristic, 13 unit tests                                                                                      | Advice nothing consumes; toggle needs a restart; no enabled-state test                                             |
| Delegating steps (`orchestrationStrategyEnabled`)    | `registry-bootstrap.ts:155-157`                              | Keep opt-in — sign-off        | Worker goes through the permission gate                                                                            | Runner untested; bypasses afterToolUse hooks; no spend cap; toggle needs a restart                                 |
| ACP over SSH (`acpOverSshEnabled`)                   | `acp-ssh-transport.ts:60-76`                                 | Keep opt-in — sign-off        | Unit tests only                                                                                                    | No e2e/integration; design doc stale; security findings reported privately                                         |
| Developer mode (`developerMode`)                     | `settings-dialog.ts:329`                                     | Keep opt-in                   | Developer affordance                                                                                               | Exposes hook configuration and main-window DevTools                                                                |

"Sign-off" means the item touches sandbox, network, credential or data-egress scope. Changing its
default needs a **named human reviewer** under [`docs/shell-permissions.md`](../shell-permissions.md),
not only an agent's verdict.

### Out of scope

These are security-hardening toggles. Their off default is deliberate policy, not a sign of an
immature feature:

- `cursorHooksEnabled`: runs third-party hook commands from a repository's `.cursor/hooks.json`, so
  it needs explicit opt-in per profile.
- `mcpAutoAllowReadOnly`: would trust an MCP server's own read-only annotation without a prompt.
- `defaultReadonlyMode`: a restrictive mode that users choose on purpose. On by default it would
  block ordinary editing.
- `COPSE_ALLOW_PLAINTEXT_SECRETS`: an escape hatch for machines with no OS keychain. Storing secrets
  unencrypted must never be the default.

## How defaults are persisted (applies to every recommendation)

**Plugins.** `EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS` (`packages/agent/src/plugins/first-party-plugins.ts:158`)
collects every first-party manifest with `stability: 'experimental'`.
`seedDefaultDisabledPlugins()` (`src/main/services/plugins/plugin-service.ts:261-264`) writes that
set into `pluginDisabled` in `config.json`, but only on a profile that has no list yet. From then on
the list belongs to the user.

- Changing a manifest to `stable` therefore turns the plugin on **for new profiles only**. On an
  existing profile the seeded entry looks exactly like a deliberate opt-out.
- To enable a plugin for existing profiles, graduate it with a one-shot migration that has a marker
  key. The precedent is `migrateBackgroundTasksStable()` (`plugin-service.ts:272-278`). The follow-up
  issues ask for one each, together with the product decision on whether existing users should get
  the change.
- Rollout gap: plugins added after a profile already had a list need an upgrade seed to stay off.
  Automations, Parallel Search, artifact checkpoint and Apple Development have one.
  `copse.dark-factory` (added 2026-08-04), and `copse.mcp-ui-canvas`, `copse.devtools-shortcut` and
  `copse.forced-planning` (added 2026-07-26), do not. The first public beta shipped on 2026-08-14,
  after all four were added, so released profiles were seeded correctly. Only older development
  profiles have these plugins on without having opted in. Dark factory is the one to fix before it
  gains a consumer. The comments claiming a migration from the retired `mcpUiArtefactsEnabled`
  (`mcp-ui-canvas-plugin.ts:24-29`, `plugin-service.ts:115-116`) are wrong.
- The e2e fixture list `DEFAULT_DISABLED_PLUGIN_IDS` in `tests/e2e/helpers/seed-config.ts:45-60`
  omits `copse.forced-planning` and `copse.parallel-search`, so seeded e2e profiles run with both
  plugins on.

**Settings.** Since #1469 (2026-08-03), the Settings dialog saves only fields the user changed
(`settings-dialog.ts:394-414`). Before that, every `save: true` field was written on every Save.
Settings added after 2026-08-03 (`vncEnabled`, `nextStepSuggestionEnabled`, `containerRunsEnabled`)
therefore reach every profile when their default changes. Older ones (`modelClassifierEnabled`,
`orchestrationStrategyEnabled`, `acpOverSshEnabled`) may carry a stored `false` from before
2026-08-03, and a default change would need a migration to reach those profiles. `vncEnabled` is
also written `true` by the Run app flow (`app-run-service.ts:84`).

**User and Agent Plugins manifests default to `experimental`**
(`plugin-manifest.ts:298,472-474`, `agent-plugin-manifest.ts:321-323`). This is intended and
recorded as decision 19 in [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md) and in
[`agent-plugins-migration.md`](agent-plugins-migration.md). For third-party plugins, stability is
only a badge. Enablement comes from `pluginsSeen` (every newly discovered plugin is seeded off) or
from the user explicitly adding a source directory. One nit: a third-party manifest can declare
itself `stable` and show "supported as part of the current plugin contract" next to the "User"
trust badge.

## Plugins

### MCP-UI canvas — Enable after X (sign-off)

- **What:** `render_html_artefact` from the bundled in-process `copse-canvas` server
  (`src/main/services/mcp/bundled-mcp-server.ts:74-144`). It renders agent-authored HTML as a
  sandboxed Browser-pane tab and mirrors it into the agent's headless browser so the agent can
  screenshot and annotate it (`canvas-agent-mirror.ts`). A turn-start hook steers prototype requests
  onto the tool. It suits a typical user asking for a prototype, chart or demo.
- **Tests:** unit tests for the plugin, steering, bundled server, canvas store, dispatch and mirror,
  plus `browser-network-policy.test.ts:67-160`. Enabled-state e2e: `canvas-artefact-refresh.e2e.ts`,
  `browser-session-restore.e2e.ts`, `settings-tool-permissions.e2e.ts`, and
  `canvas-background-parity.e2e.ts`. Its rollup-timing race, exposed by #2851, was stabilized in
  #2866. There is no test for `securePreviewHtml`/`PREVIEW_CSP`.
- **Issues/churn:** #611 is open (full MCP Apps spec, an enhancement) and #3003 is open (annotation
  anchoring). There have been about 6 canvas fix commits since 2026-08-01.
- **Cost:** about 1 KB of tool schema per turn. Steering text of about 1.3 KB is added only on
  prototype turns. No external dependencies.
- **Security:** rendering uses an opaque `data:` origin with a leading CSP, blocks network requests
  and page-driven navigation, and confines path reads to the workspace. Turning it on by default makes
  the bundled-tool auto-allow (`permission-policy.ts:651-653`) and UI rendering from external MCP
  servers live for everyone, so a security reviewer should confirm the rendering boundary.
- **Failure:** degrades gracefully. Wiring or mirror failures give no preview; a bad path returns
  `isError`.
- **Bugs:** `plugins:set-enabled` (`register-handlers.ts:2123-2206`) never reloads MCP servers for this
  plugin. Disabling it live leaves the tool registered while the summariser is off, so a render can
  push up to 512 KB of HTML into the model context. Enabling it live shows no tool until restart. The
  ACP inline-visualization path (`agent-service.ts:1038-1050`) is not gated by the capability at all,
  so inline visualizations already render for ACP agents with the plugin off.
- **Remaining:** [#3068](https://github.com/copse-dev/agent-pane/issues/3068).

### Apple Development — Enable after X (sign-off)

- **What:** Build/Test/Run panel, project enrolment, the bundled `xcodebuildmcp` server for enrolled
  projects, and `open_simulator_desktop`. Useful only on macOS with Xcode.
- **Android emulator / Run app is gated separately, and that gate is already on by default:**
  `src/main/ipc/app-run.ts` has no plugin or setting check. `resolveRoot` needs only darwin and a
  non-SSH project (`app-run-service.ts:59-67`). This is by design (PR #2677,
  `docs/plans/unified-app-run.md`).
- **Tests:** unit tests for the service, driver, `xcodebuildmcp`, panel, registry and migration; demo
  specs `tests/demo/apple-development-target.demo.ts` and `app-run.demo.ts`. The enabled-state
  Electron spec `apple-development-panel.e2e.ts` is darwin-only and excluded from CI with no recorded
  macOS run (`tests/e2e/exclusions.json:16-24`, #2719).
- **Cost/deps:** the plugin is inert for a project until it is enrolled. However,
  `open_simulator_desktop` is registered for every thread on every OS (`registry-bootstrap.ts:233-241`).
  Without Xcode the panel explains how to install it (`apple-driver.ts:605-616`). On Linux, Settings
  still offers enrolment before telling the user the platform is unsupported
  (`apple-development-service.ts:135-137`).
- **Security:** `xcodebuild` runs unsandboxed, and XcodeBuildMCP calls get
  `-allowProvisioningUpdates`. Both are documented in `shell-permissions.md:65-86` and happen only
  after enrolment, which is the consent step. Enabling by default keeps that consent in place; a
  named reviewer should confirm it is enough.
- **Bugs:** with the plugin on and `vncEnabled` off (the default combination), Run opens the Desktop
  pane, `simulator-desktop:list` throws, and the user sees a misleading "no longer running" message.
  Separately, using Run app once silently sets `vncEnabled` to `true` (`app-run-service.ts:84`).
- **Rollout:** `migrateAppleDevelopmentEnablement` seeds it off on upgrade. Graduating it needs a
  migration.

### Copse Reviewer — Enable after X (sign-off)

- **What:** Stage 0 builds and tests the change. A reviewer model reads the diff under one or more
  lenses, and a challenger model tries to refute each finding. It starts from the Changes-view Review
  button, the "Review changes" bubble, or the model calling `review_changes`. It never runs on its own.
- **Tests:** `review-service.test.ts`, `os-sandbox-backend.test.ts`, `container-backend.test.ts`,
  `packages/review/src/*.test.ts`, and e2e specs that render **seeded** reports
  (`review-findings-card`, `review-failure`, `review-inline-transcript`). `git-changes-review-button`
  only checks that the button exists. Nothing clicks Review and runs the pipeline, and no test covers
  the agent spend prompt or a declined approval.
- **Issues/churn:** #2826 now anchors separate reports to their reviewed turns, but #2519 remains
  open because a review started from the Review button is still not added to model context. #2933
  is open (dogfood ledger; precision not yet established), and #3063 recently hardened the CI
  grounding process. 43 commits touch the review paths since 2026-09-21, about 23 of them fixes or
  hardening, mostly in `@copse/review`.
- **Cost:** heavy. Up to 24 reviewer steps per lens, up to 10 verified findings with up to 28
  challenger/reproducer steps each, and the challenger defaults to the most capable model. A user click
  never asks about spend. The tool description tells the model to call it "before declaring a change
  finished", which would make model-initiated reviews routine if it were on by default.
- **Security:** the build and tests run inside the ASRT sandbox or a Docker cell with no network, and
  it falls back to a read-only review when neither is available (`review-service.ts:491-503`). It
  never runs unsandboxed, but it relies on the execution contract, so it needs sign-off.
- **Rollout:** `migrateReviewPluginFromModelComparison` turns the reviewer **on** for profiles that had
  opted into the retired `copse.model-comparison`. Those users agreed to prose comparisons, not
  sandboxed builds.
- **Code-rule violation:** `review-service.ts:252` carries an `eslint-disable`, which `AGENTS.md`
  forbids.

### Automations — Enable after X (sign-off)

- **What:** project-scoped cron schedules. Each run starts a fresh thread in its own worktree. Event
  automations are not wired in: `AutomationEventInbox` is only used by its own test.
- **Tests:** strong. There are unit tests for the service, cron, controller, dialog and settings.
  `automation-trigger.e2e.ts` exercises the real cron boundary with a mock turn, and five more
  enabled-state e2e specs record screenshots.
- **Issues/churn:** 14 commits since 2026-08-01, 4 of them fixes (#1803, #1956, #2149, #1677).
  The heading-alignment polish landed in #3055.
- **Cost:** none until a schedule exists (`automation-service.ts:155-157`). After that, one full agent
  turn per match, with no token or cost budget per schedule.
- **Security:** runs inherit the user's auto-run policy and happen with nobody watching. Deferral mode
  exists for this case (`deferral-mode.ts:8`) but is not used, so an approval prompt stalls the run.
  Neither behaviour is covered by `shell-permissions.md`.

### Roadmap plans — Enable after X

- **What:** a per-project backlog of future-work prompts, with the `roadmap_plan` tool and a Roadmap
  pane (review, issue import, export). Broadly useful.
- **Tests:** the best-covered item in this audit, with 17 `tests/e2e/roadmap-*.e2e.ts` specs that have
  committed screenshots, a 63-case `roadmap-pane.test.ts`, and tool and handler tests.
- **Issues/churn:** #2510 (pop-out error) and #2440 (review CPU) are open. 24 commits since
  2026-08-01, about 6 of them fixes.
- **Cost:** one tool of about 430 characters per turn, plus one background small-tasks call per added
  item to write its title.
- **Bug:** `knowledgeDir()` resolves the _active_ project (`project-namespace.ts:46-57`), and
  `roadmap_plan` passes no project. A thread still running after the user switches projects therefore
  writes to and lists the wrong roadmap. Long-horizon tasks and OKF memories share this defect.

### CI investigator — Enable after X

- **What:** the `investigate_ci` subagent (at most 10 steps) plus read-only `gh_run_list` and
  `gh_run_view`.
- **Tests:** plugin tests, the seeded display e2e `ci-investigator-display.e2e.ts`, and an eval
  scenario. There are no tests for `ci-investigator-service.ts` or `syncCiInvestigatorTools`.
- **Cost/deps:** about 1 KB of tool schema. It needs an authenticated `gh`; without one the tools are
  simply not registered (`registry-bootstrap.ts:338-342`). There is no new permission scope, because
  it uses the same `gh` path as the default-on `gh_pr_*` tools.
- **Bug:** `investigate_ci` is hidden unless `subagentsEnabled` is on, and that setting defaults to
  off. Yet the follow-up with the plugin on says "Use the investigate_ci tool"
  (`follow-up-service.ts:180-188`), and with subagents on but the plugin off the prompt still
  advertises the tool (`agent-prompt.ts:111`).

### Forced planning — Enable after X

- **What:** a turn-start hook that injects a plan-first block (0.64–0.85 KB) on turns run by models
  below a capability threshold. With the defaults it fires for Claude Haiku 4.5.
- **Hooks plan:** conforms to P12 and decisions 15, 19 and 20. Disabling it restores a byte-identical
  prompt. Graduating it must edit P12 ("Ships disabled") and `docs/forced-planning.md` in the same PR.
- **Tests:** 12 + 6 unit tests plus turn-start-hook cases. The steer-eval pack exists (#1612), but no
  recorded real-model lift is in `docs/steer-evals.md`.
- **Gaps:** it can fire alongside todo steering (two overlapping plan blocks). Toggling it per turn
  costs local models their prompt cache. The e2e seed list omits it.

### OKF memories — Keep opt-in (sign-off)

`remember` and `recall` plus a Memories pane. It adds 765 bytes of prompt and two tools to every turn,
and `recall` without a query returns everything, uncapped. There is pane e2e coverage
(`memories-pane-popout.e2e.ts`), but nothing exercises the tools in a turn. It stores memories under
the active project rather than the thread's project, like Roadmap. Memories are also the one channel
that carries text across threads, and the review found gaps in how that text's provenance is tracked.
Those details are being reported privately under [`SECURITY.md`](../../SECURITY.md). Open: #870, #871,
#874.

### Long-horizon tasks — Keep opt-in (sign-off)

`track_long_task` keeps a durable checklist, and `continue` schedules a supervised wake up to an hour
later. Wakes go through `dispatchMachine` with the per-tree budget, re-check permissions, and expire
after 24 h (`long-task-wake.ts:122-214`), which matches decision 5 in spirit. However, decision 5's
list of machine-initiated turns (`hooks-and-feature-packs.md:76-82`) does not include them. The store
is keyed by the active project, so a wake can drive project A's thread from project B's checklist.
There is no checklist UI and no e2e, and #558 is still open.

### Dark factory — Keep opt-in

It emits `dark-factory:fleet-poll` every 15 minutes, and nothing subscribes, so enabling it changes
nothing visible. The Settings description ("observes Copse-owned pull requests") overstates it. Add an
upgrade seed (see Rollout above) before any consumer lands, because the first consumer will poll
GitHub.

### Advisor strategy — Keep opt-in (sign-off)

The `advisor` tool sends the full transcript (system prompt, tool output, file contents) to
`auto:best-intellect`, and the tool description asks for at least two calls per task.
`DEFAULT_ADVISOR_MAX_TOKENS` is never applied (`advisor-strategy.ts:48,115`). The transcript is not
capped. Stop does not abort the non-ACP request (`advisor-runner.ts:119-120`). `advisorAddsLift`
compares the unexpanded selector, so top-tier executors still get the tool
(`advisor-strategy.ts:274-290`). A local executor can send its context to a cloud advisor with no
consent step. The demo entry names a non-existent `consult_advisor` tool (`demo-api.ts:176-195`). There
is no runner test and no loop e2e.

### Artifact checkpoint — Keep opt-in

A single appended message of about 190 characters after 8 minutes of wall-clock time tells the model to
preserve its best runnable artifact. It is cheap, contained and compliant with decision 23, but it came
from Terminal-Bench (#1933) and has no product-shaped A/B. Its wording is also wrong for research,
review or refactor runs that have no artifact. Graduating it would need an eval and a decision-23 edit.

### PII redaction — Keep opt-in (sign-off)

Rampart redacts every label except CITY, STATE and ZIP, and Copse passes no keep-list. In a coding
assistant that rewrites every `https://` URL, dotted IPv4 address (including `127.0.0.1`) and
four-part version number. Packaged releases leave out the ONNX model, so names are not detected even
though the copy promises they are. Placeholder numbering restarts after an app restart, so `reveal_pii`
can return a different value for the same token. An approved reveal is stored in thread history on
disk. If the redactor fails, the text is sent unredacted and only a `console.warn` records it. The
tests use a fake Rampart only. `docs/pii-redaction.md` is stale.

### Parallel Search — Keep opt-in

It sends queries to a paid third-party API, and it needs the user's own key and account. Enabling the
plugin is what the permission gate treats as consent for `api.parallel.ai`
(`permission-gate.ts:724-735`). The key can also come from `PARALLEL_API_KEY`, so turning it on by
default would silently expose paid, auto-allowed search to anyone who has that variable set. It stays
opt-in by design.

### DevTools shortcut — Keep opt-in

It uses Electron's `globalShortcut`, which takes Ctrl+Shift+I from every other application while
enabled, and it opens main-renderer DevTools. If it is ever offered more widely, switch to a
window-local accelerator.

## Settings

### Remote desktop viewer (`vncEnabled`) — Keep opt-in (sign-off)

- **Coverage:** good when enabled. Unit: `vnc-service.test.ts` (real loopback sockets),
  `vnc-username-store.test.ts`, `vnc-machines.test.ts`. E2e: `vnc-viewer.e2e.ts` and
  `simulator-desktop.e2e.ts`.
- **Security:** it widens network scope. When enabled, every launch probes local ports, runs a Bonjour
  browse (which triggers the macOS Local Network prompt) and `xcrun simctl list`, and may open an SSH
  remote scan. This happens even if the pane is never opened (`vnc-pane.ts:1694,1923`). It also stores
  VNC passwords.
- **UX:** the copy says the pane is read-only, but Control desktop exists.
- **Recommended path:** split local-device Desktop (Simulator and emulator) from LAN and SSH VNC, and
  make discovery lazy. Local-device Desktop can then follow Apple Development, while network VNC stays
  opt-in.

### Next-step tab complete (`nextStepSuggestionEnabled`) — Keep opt-in

- **Coverage:** enabled-state tests exist: `next-step-hint.test.ts`, `input-bar.test.ts` and
  `next-step-hint.e2e.ts` with screenshots.
- **Cost:** it adds a second small-tasks call to every finished turn, on top of the follow-up bubbles.
  On a cloud-only profile the default LM Studio route fails silently. If a configured small-tasks model
  fails to build, it falls back to the **chat model** (`provider-selection.ts:310-326`), so a frontier
  model can be billed every turn.
- **Other gaps:** usage is logged against the wrong model. Taking plain Tab from an empty composer is
  an accessibility decision that someone needs to make explicitly. `suggestNextStep` has no unit test.

### Unattended container runs (`containerRunsEnabled`) — Keep opt-in (sign-off)

- **Design:** the container is hardened: read-only, `cap-drop=ALL`, `--network=none` with a brokered
  egress allowlist, a non-root user, and nothing applied automatically.
- **Coverage gap:** the Docker path has never run in CI. The integration tests need
  `COPSE_THREAD_CONTAINER_E2E=1`, which nothing sets, and `thread-in-container.md` records no
  real-model run.
- **Churn and open work:** 65 commits since 2026-08-01, 13 of them fixes. Draft #2689 is still open
  with hardening work.
- **Copy:** the settings text says a run reaches "only its model's origin", but "Install dependencies"
  is ticked by default and adds package-registry and GitHub hosts (`guest-install.ts:36-45`).
- **Security findings:** the review found problems with credential handling and egress. They are being
  reported privately under [`SECURITY.md`](../../SECURITY.md) and are not described here.
- **Cost:** even with the setting off, `sweepOrphans()` runs the `docker` CLI on every window creation
  (`register-handlers.ts:554`).

### Model classifier (`modelClassifierEnabled`) — Keep opt-in

`suggest_model` is a keyword and size heuristic. Its advice has no consumer: the agent cannot switch
models, and `delegate_step` takes no model. The recommendations are not filtered to providers the user
can reach. The setting is read only at boot (`registry-bootstrap.ts:139-141`), so the checkbox does
nothing until restart. There is no enabled-state test. The feature itself is tracked in #557.

### Delegating steps (`orchestrationStrategyEnabled`) — Keep opt-in (sign-off)

The worker's tool calls go through the permission gate and the read-only block. But the worker bypasses
`runParentTool`/`executeParentTool`, so afterToolUse hooks and nested `AGENTS.md` handling are skipped.
That is a hooks-contract concern under [`hooks-and-feature-packs.md`](hooks-and-feature-packs.md). The
feature also has these gaps:

- The default `auto:best-value` worker can send workspace context to a provider other than the thread's
  own.
- There is no spend cap or delegation limit.
- `validateOrchestrationPair()` is never called at runtime.
- The setting is read only at boot.
- `orchestration-runner.ts` has no tests.
- `orchestration-pattern.md:34` names the wrong default worker.

### ACP over SSH (`acpOverSshEnabled`) — Keep opt-in (sign-off)

The agent is launched over the existing SSH ControlMaster. Approvals, the diff queue and `fs/*` stay
local. It is covered by unit tests only: there is no e2e, demo or real-SSH integration test.

`acp-over-ssh.md` is out of date:

- It puts the toggle in the wrong settings section.
- It says there is no remote auto-install, but an approval-gated, unpinned `npm install -g` exists.
- It describes key handling differently from `acp-remote-env-gate.ts`.

`shell-permissions.md` does not document SSH execution at all. The review found problems with how the
remote agent's sandbox status and bridge access are established. They are being reported privately
under [`SECURITY.md`](../../SECURITY.md).

### Developer mode (`developerMode`) — Keep opt-in

It shows the command-hook configuration, thread-ID copy and export, ACP transport noise, and the native
Developer Tools menu item. That is developer noise with arbitrary-code exposure, not a user feature.

## Follow-up issues

Each "Enable after X" item has an issue listing the remaining tests, bug fixes, migration decision and
the visual evidence that `AGENTS.md` requires:

- MCP-UI canvas: [#3068](https://github.com/copse-dev/agent-pane/issues/3068)
- Apple Development: [#3069](https://github.com/copse-dev/agent-pane/issues/3069)
- Copse Reviewer: [#3070](https://github.com/copse-dev/agent-pane/issues/3070)
- Automations: [#3071](https://github.com/copse-dev/agent-pane/issues/3071)
- Roadmap plans: [#3072](https://github.com/copse-dev/agent-pane/issues/3072)
- CI investigator: [#3073](https://github.com/copse-dev/agent-pane/issues/3073)
- Forced planning: [#3074](https://github.com/copse-dev/agent-pane/issues/3074)

## Fix pull requests

The concrete defects this audit found are being fixed in these draft pull requests. None of them changes a default.

- [#3098](https://github.com/copse-dev/agent-pane/pull/3098): CI investigator: only mention `investigate_ci` when the turn can call it (#3073)
- [#3099](https://github.com/copse-dev/agent-pane/pull/3099): Dark-factory upgrade seed; canvas toggle reloads MCP servers; e2e default-off list derived from the product; CSP tests (#3068)
- [#3100](https://github.com/copse-dev/agent-pane/pull/3100): ACP over SSH: remote agents are never treated as sandboxed; no native bridge; pinned remote install; SSH docs — needs security sign-off
- [#3102](https://github.com/copse-dev/agent-pane/pull/3102): Remove `eslint-disable` suppressions (#3070); hooks plan decision 5 lists long-task wakes
- [#3103](https://github.com/copse-dev/agent-pane/pull/3103): Roadmap, long-task and memory stores follow the thread's own project (#3072); memory taint carries forward; `recall` capped — needs security sign-off
- [#3104](https://github.com/copse-dev/agent-pane/pull/3104): Advisor: output cap, Stop cancels, selector expanded before the lift check, transcript cap, demo entry
- [#3105](https://github.com/copse-dev/agent-pane/pull/3105): Container runs: provider key never passed through an environment variable; base image pinned by digest; accurate egress copy; gated orphan sweep — needs security sign-off
- [#3107](https://github.com/copse-dev/agent-pane/pull/3107): PII redaction: keep URLs/IPs, restart-safe placeholders, visible fail-open notice, accurate copy and docs — needs privacy sign-off
- [#3108](https://github.com/copse-dev/agent-pane/pull/3108): Apple Development: tools scoped to enrolled macOS projects; no Enroll on Linux; clear viewer-off message (#3069)
- [#3110](https://github.com/copse-dev/agent-pane/pull/3110): Model classifier and delegating steps take effect without restart; Parallel Search cannot be enabled without a key
- [#3111](https://github.com/copse-dev/agent-pane/pull/3111): Next-step suggestions: usage recorded against the model that answered; `suggestNextStep` tests
- [#3112](https://github.com/copse-dev/agent-pane/pull/3112): Native SSH shell commands are gated as unsandboxed — needs security sign-off
- [#3118](https://github.com/copse-dev/agent-pane/pull/3118): Settings and plugin copy for the Desktop pane, Developer mode, SSH agents, DevTools shortcut and dark factory
