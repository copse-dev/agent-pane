# User control surface gaps

Status: **Proposed.** No implementation is on `develop`. This document audits the
user-facing control and session-management surface Copse does not currently expose, maps
each gap to the plan, issue, or roadmap item that already owns it, and records what we
have decided not to build.

Companion documents:

- [`mission-control.md`](mission-control.md) — the user-first specification for R-04,
  R-06, R-20 and R-22, which collapse into a single surface.
- [`competitive-landscape.md`](competitive-landscape.md) — the named product comparison
  the category section below summarises.

## Why

Copse is positioned around _control_: the user decides what the agent runs, what it
reads, and what it is allowed to touch. Several of the parts that promise needs are
already on `develop`: the project sandbox, the permission gate, the trusted-command
allow-list, the approval queue, in-process custom tools, credential scrubbing, and around
sixteen model providers including local runtimes.

None of it is reachable from the interface in the ways users expect. A person cannot set
a temperature. They cannot name and reuse an agent configuration. They are not told when
a session has stopped and is waiting on their approval. They can quit the app with work
in flight and lose it. The sandbox and the review tooling only become visible at the
moment they act, so a user has to run something before they can see what the product does
differently.

So this is two problems that share one solution. There are real gaps in what a user can
steer, and there is real capability the interface never advertises. Both are fixed by
building surface, not engine.

## Method and confidence

The audit was done by reading `src/`, `packages/`, and `docs/`. It is not
runtime-verified, so anything marked missing could be a false negative under vocabulary
the audit did not guess. Findings were re-checked against `develop` on 2026-07-29 after a
rebase: no cited issue had closed, and the load-bearing claims still hold — nothing in
`src/main` constructs a `Notification`, `ThreadStatus` is still `idle | running | error`,
`before-quit` is still cleanup-only, and no hyperparameter reaches the settings surface.

Three items are flagged for re-checking before work starts:

- **Pending-approval persistence** — the thread store already keeps an append-only event
  log per thread, so the durable half may exist and only the restore path be missing.
- **Compaction with custom instructions** — compaction and history trimming exist; the
  user-supplied-instruction path is what is unconfirmed.
- **Plan Mode** — see the correction below.

### Correction: Plan Mode is not shipped

It is easy to conclude otherwise. `copse.forced-planning` (`docs/forced-planning.md`)
exists and does make a plan mandatory, but only when the selected model measures below a
capability threshold, and it ships disabled. Its purpose is stopping weaker models from
drifting, not giving the user a decision point.

Transactional Plan Mode — propose, approve or reject, execute against the approved plan,
rewind to a prompt boundary — is **Proposed** in
[`plan-mode-and-rewind.md`](plan-mode-and-rewind.md) under
[#1080](https://github.com/copse-dev/agent-pane/issues/1080), with no implementation
landed. Anyone auditing the product against a feature list should record it as absent.

## Built but not visible

Listed because Phase 0 and Phase 2 below are partly about _surfacing_ these rather than
building them. These are statements about what exists, not rankings against anyone else —
we have not benchmarked against competing products, so treat comparative wording as
absent on purpose.

- **Privacy.** No Copse account, no hosted backend, no product telemetry
  (`docs/privacy-data-flow.md`). Account-gated onboarding and default-on usage reporting
  are common in this category, so not having them is worth stating in the product rather
  than only in a doc.
- **Execution safety.** A macOS sandbox, workspace boundaries, external-command
  escalation, credential scrubbing, and supply-chain checks.
- **Workflow surface.** Browser automation, Monaco, terminal, git changes, PR/CI
  workflows, SSH workspaces, semantic search, post-turn review, and two-model comparison.
  Several of these are scaffolds or partial (advisor, model classifier, and per-thread
  worktrees are all `Active` rather than done), so the breadth is real and the depth
  varies.
- **Open task data.** The thread store is filesystem-native and greppable (`README.md`,
  `docs/thread-store-format.md`), which makes it inspectable and scriptable without going
  through the app.
- **Local-first model routing.** Onboarding can be skipped entirely and auto-discovers LM
  Studio, Ollama, llama.cpp, Jan, and vLLM (`src/renderer/views/onboarding-dialog.ts`).

## Category context

Seven products were reviewed; the detail is in
[`competitive-landscape.md`](competitive-landscape.md). Four findings bear on the order
below.

1. **A delegated task mode is the category headline and we have no equivalent surface.**
   Qoder's Quest Mode, Trae's SOLO, Antigravity's agent manager, and Devin's sessions are
   the same shape: hand over a spec, leave, collect a result. We own most of the parts
   across #1081, #866, #558 and #865 and expose none of them as a mode. This is R-20.
2. **Antigravity organises around one mission-control view** listing every active agent,
   its status, its outputs, and any approval waiting on the user. That is R-04, R-06,
   R-20 and R-22 in one place, which is why they get a single specification rather than
   four issues.
3. **Antigravity's stated philosophy is the opposite of ours** — manage tasks, not
   individual tool calls. Our approval queue is the opposing bet. This document does not
   propose abandoning it, but it does mean R-06 and R-04 stop looking like polish: a tool
   that asks permission constantly has to be excellent at saying so.
4. **Zed co-authored the Agent Client Protocol, which we implement on both sides.** There
   is a registry where an agent registers once and reaches every compatible client. We are
   not in it. Combined with #1079, #1313, #1314 and #362 that is a second possible answer
   to R-10, and it does not require porting Electron.

## Audit

### Present

Streamed tool calls; interactive terminal commands (`node-pty`, `read_terminal`,
`@shell`); Agent Skills and skill slash commands; local + remote (HTTP) MCP including
image-returning tools; web search/fetch; subagents; image/vision; file `@`-mentioning;
rich-text composer; `AGENTS.md` project instructions; Claude Code-compatible hooks;
per-chat draft autosave; thread forking; message queuing; the file tree, Monaco editor and
terminal; clickable path references; context/token usage metrics.

Configurable native notification, sound, and dock/taskbar attention when a run needs input or
finishes (`user-alerts.ts`, `user-alerts-electron.ts`; #1458).

### Partial

| Area                          | State                                                                      |
| ----------------------------- | -------------------------------------------------------------------------- |
| Plan mode                     | Capability-gated forced planning only; transactional mode is #1080         |
| Per-thread worktrees          | Execution-context foundation landed; #869 and its PR stack are open        |
| Compaction                    | Runs automatically; not surfaced, policy contested by `4f427281`           |
| Pausing a run                 | Interrupt and abort exist, and abort is slow (`a6bb72a1`)                  |
| Regenerating a response       | Fork-from-message and retry-on-failed-card exist; no direct regenerate     |
| Subscription credential reuse | Works via ACP and credential read; not presented as a setup path           |
| Usage monitor                 | Covers Claude, Codex, Cursor, Hugging Face; missing two, and misattributes |
| Typography                    | Font size and UI scale are settings; font family and line height are not   |

### Missing

**Session control** — graceful pause/resume; explicit compaction controls; tool call
re-execution.

**Task lifecycle** — statuses beyond `idle | running | error`
(`src/shared/types/thread.ts:27`); saved drafts surfaced in the sidebar; tagging;
relocation between projects; duplication.

**Reusable configuration** — named agent profiles bundling model, system prompt, tool
set, MCP servers, permission posture, and compaction policy.

**Model configuration** — system prompt override; hyperparameters; multiple credentials
for one provider; Copilot and Bedrock adapters.

**Awareness and durability** — pending tool calls persisted across restart;
confirm-before-quit; notification copy and per-event channel choices beyond the shipped
needs-input / thread-finished controls.

**Observability** — no inspector for how a request was composed; no reviewable artifact
collection per run.

**Presentation and reach** — markdown callouts; configurable diff viewer; raw markdown
view; `Ctrl+R` prompt history search; font family and line height; localization; platform
reach beyond macOS 26+.

**Voice** — absent everywhere: no dictation, no read-back, and video attachments never
decode audio (`docs/video-frames.md:149`). Recorded so the absence reads as examined rather
than overlooked. Note the tension before anyone treats it as a straightforward addition: our
bet is per-command approval, and approval is the one interaction that should _not_ be
hands-free — a spoken "yes" across a room is a poor consent signal for a destructive command.
A voice surface for Copse is dictation into the composer and read-back of a result, with the
approval queue deliberately excluded. That is a smaller feature than it first appears, and a
different one. See [`unowned-capability-gaps.md`](unowned-capability-gaps.md) G-05.

## Ownership

Only six of twenty-two originally needed a new issue, and two of those are decision records. Eight
already have an owner among the open issues, where the correct move is to extend that
issue rather than file a second one against the same work. R-05 has since been filed as
#1573, and R-06 shipped in #1458, leaving four of the six outstanding.

| Req  | Repo plan                  | Open issues                | Roadmap                          | Action                                |
| ---- | -------------------------- | -------------------------- | -------------------------------- | ------------------------------------- |
| R-01 | plan-mode-and-rewind       | #1080                      | `247c1245` `a2739a29`            | Owned — defer entirely                |
| R-02 | —                          | #658 #745 #746             | `a6bb72a1` `830efc77` `a330dbbf` | Extend #658                           |
| R-03 | long-horizon-tasks         | #558 #1286                 | `ae775062` `4f427281`            | Extend #1286                          |
| R-04 | —                          | #866 #998                  | `bfa09823` `79b0286f` `00a74fc9` | **New issue** — see `mission-control` |
| R-05 | model-roles-and-defaults   | **#1573** #1314 #1315 #750 | `19418b60` (name collision)      | Filed as #1573                        |
| R-06 | —                          | #1458                      | —                                | Landed                                |
| R-07 | —                          | #656 #1153 #1222           | —                                | Extend #656                           |
| R-08 | —                          | —                          | `a6bb72a1` (blocks) `7f284ad5`   | **New issue**                         |
| R-09 | settings-transparency      | #638 #639                  | —                                | Extend #639                           |
| R-10 | —                          | #659 #802 #507 #806 #1382  | —                                | Decide on #802                        |
| R-11 | settings-transparency      | #750 #638 #745             | `06ac8c21`                       | Fold into #750                        |
| R-12 | —                          | —                          | —                                | **New issue**                         |
| R-13 | —                          | #1154                      | `e9e8f756` `d7f6de34` `0711ebc0` | Extend #1154                          |
| R-14 | provider-host-allow-list   | #648                       | `d665d204`                       | Fold into #648                        |
| R-15 | —                          | #648 #1246                 | —                                | Fold into #648                        |
| R-16 | execution-runtime-security | #656                       | `7ac857cb` (blocked) `a91460d4`  | Extend #656 — leads Phase 2           |
| R-17 | —                          | #865 #866 #867             | —                                | Extend #865                           |
| R-18 | thread-referencing         | #1245 #998                 | `79b0286f` `6f7b7d13`            | Extend #1245                          |
| R-19 | terminal-file-links        | #713                       | ~15 UI items                     | Extend #713                           |
| R-20 | background-supervisor      | #1081 #866 #558 #865       | `0bf7fa5a`                       | Extend #1081 — see `mission-control`  |
| R-21 | —                          | #656                       | —                                | **New issue** — decision              |
| R-22 | —                          | #867 #658                  | `a2739a29`                       | Extend #867 — see `mission-control`   |

Roadmap identifiers are items from the in-app roadmap, which is local workspace data
rather than a hosted tracker. They come from the 27 July 2026 export.

## Delivery

Identifiers are stable and citable, so they are not consecutive within a phase — R-16
leads Phase 2 on a dependency.

### Phase 0 — Session control and task lifecycle

- **R-01 — Transactional Plan Mode.** Owned by #1080; not re-specified here. Roadmap item
  `a2739a29` constrains its interface: plans must not be rendered into the UI as plain
  text, and should link into the repository file viewer with human-readable link text.
- **R-02 — Graceful pause and resume.** Suspend the loop at a tool boundary, keep
  context, resume. #658 already wants to inject guidance into a running turn without
  cancelling, which is the same machinery. Four roadmap items describe the failure mode
  this exists for. Blocked by the abort latency in `a6bb72a1`.
- **R-03 — Explicit compaction controls.** Surface when compaction happened, let the user
  trigger it, let them supply instructions. Two roadmap items own the policy half.
  Compaction invalidates the cached prefix, which is #1286, so they ship together.
- **R-04 — Task-centric lifecycle.** A user-set disposition axis held separately from
  runtime status. Three roadmap items block on it. **Specified in
  [`mission-control.md`](mission-control.md).**
- **R-05 — Named agent profiles.** Model, system prompt, tools, MCP, permission posture
  and compaction policy as a named profile, per task and per subagent. The concept exists
  internally already (#1315 benchmark profiles, #1314 settings-object host), so this is
  mostly exposing and unifying. Must compose with packs and per-thread overrides rather
  than becoming a fourth configuration system. Rename `19418b60`'s dev-environment
  "profile" first or every ticket is ambiguous. **Filed as
  [#1573](https://github.com/copse-dev/agent-pane/issues/1573)**, which also records the
  scope question it must not answer by accident: a profile a thread starts from is a
  settings feature, while a named agent the user returns to changes what a thread and a
  project are.
- **R-20 — Delegated task mode.** Hand over a spec, close the window, collect a result.
  Composes with R-01: approve a plan, then delegate its execution. Needs R-06 to be worth
  using. **Specified in [`mission-control.md`](mission-control.md).**

### Phase 1 — Awareness, durability, onboarding

- **R-06 — Notify when a session needs attention.** Landed in #1458: native notification,
  sound, and dock/taskbar attention are independently configurable for needs-input and
  thread-finished events. The notification is suppressed while Copse is visible (#1587).
- **R-07 — Pending tool calls persist across restart.** Verify first; if a pending
  approval does not survive a quit, file it as a data-loss defect. Sequence behind #1153
  and #1222.
- **R-08 — Confirm before quitting with active chats.** `src/main/index.ts:658`'s
  `before-quit` is cleanup-only. Fix `a6bb72a1` first — a confirmation on top of a slow
  stop makes quitting worse. `7f284ad5` is the same family.
- **R-09 — "Use my existing subscription" onboarding.** Already works technically; not
  presented as a path. Adjacent to #639 and #638.
- **R-10 — Platform reach, record a decision.** GA is macOS 26+. The deliverable is a
  written, dated decision, not an implementation. #802 owns the distribution channel, #1382
  tracks Linux and Windows GA readiness beyond packaging, and #659 proposes off-desktop
  hand-off. The ACP registry route above is the other option, and the one that does not
  require porting Electron. Three open issues and no document connecting them is why this
  reads as drift rather than a choice. **Proposed owner paragraph:**
  [public-readiness-decisions.md](../public-readiness-decisions.md) D5.

### Phase 2 — Observability and model configuration

- **R-16 — Redacted execution inspector.** Payload structure, cache behaviour, tool
  schemas, retries, timings. Default to sanitized views; raw capture is an explicit,
  non-retained opt-in. Leads the phase because trace-sharing (`7ac857cb`) cannot ship
  without it. Also the home for `b1ba83b1`'s ZDR annotations.
- **R-11 — System prompt override, varying by model.** A profile's prompt varies by model
  card rather than being one static string, per #750 and `06ac8c21`. Precedence against
  project instruction files and pack context must be decided first.
- **R-12 — Hyperparameter controls.** Temperature, top-p, max tokens, stop sequences. UI
  must reflect per-provider support rather than showing dead knobs. Unowned anywhere.
- **R-13 — Complete and correct the usage monitor.** Four roadmap items report it
  misattributing, not merely missing coverage. Correctness first. #1154 is rebuilding the
  ledger underneath.
- **R-14 — Multiple credentials per provider.** Architectural; touches settings, the model
  picker, and `safeStorage`. #648 is the right home.
- **R-15 — Enterprise gateway and remaining direct providers.** Already scoped by #648;
  recorded here only as a dependency.
- **R-21 — Enterprise controls, record a decision.** SSO, provisioning, RBAC, audit
  export, compliance attestation. The likely answer is that we do not build them — they
  presume a hosted backend and account model we reject. But "we decided not to" and
  "nobody considered it" look identical from outside, and only one survives a procurement
  conversation. **Proposed owner paragraph:**
  [public-readiness-decisions.md](../public-readiness-decisions.md) D6.

### Phase 3 — Remaining surface

- **R-22 — Verifiable run artifacts.** Plans, task lists, screenshots, browser
  recordings, diffs as reviewable objects a user can comment on without stopping the run.
  #867 asks for a workflow artifact viewer and is the right home; #658 is the steering
  half. **Specified in [`mission-control.md`](mission-control.md).**
- **R-17 — Tool call re-execution.** Open question is what re-execution means for a tool
  whose result is already in history: replace, append, or fork. #865 should own the
  semantics.
- **R-18 — Tagging, relocation, duplication.** Touches the thread store's project-scoped
  layout. #1245 and #998 are prerequisites. Depends on R-04 for anything filterable.
- **R-19 — Polish batch.** Font family and line height, raw markdown view, `Ctrl+R`
  history search, markdown callouts, configurable diff viewer. Roughly fifteen roadmap UI
  items should be triaged into this batch rather than handled individually.

## Non-goals

Declined, not deferred. Copying these would cost the positioning the rest of this plan is
trying to surface.

- **Mandatory accounts or a hosted backend.** Account-free operation is a differentiator,
  not an onboarding gap.
- **Cloud chat sharing by secret link.** Needs hosting and cuts against
  `docs/privacy-data-flow.md` and `docs/provider-data-policies.md`.
- **Raw request and response traffic retained by default.** R-16 exists instead.
- **Cosmetic streaming animation as headline work.** Acceptable in the polish batch; never
  a milestone. This does **not** cover `9f579428`, `bb0ffccf` and `31a9951a`, which are
  rendering correctness defects belonging to #713.
- **Competing on count of settings.** Borrow primitives that reinforce safety and review;
  skip the rest.

## Deferred

Known gaps rather than declines.

- **Localization.** No i18n layer exists at all; invasive and low leverage before GA.
- **Browser-served mode.** A genuine architectural lift that overlaps #659 and the
  existing remote-workspace and cloud-workspace plans.

## Positioning

Proposed, offered for argument rather than assumed: a private, local-first workbench where
the user approves what runs and can check what ran. The phase order follows from it —
steering first, then knowing when you are needed, then seeing what happened, then
configuration. If the positioning is wrong the order is wrong too, which is the more
useful thing to disagree with.

## Follow-ups

Six findings originally needed new ownership: R-04, R-05, R-06, R-08, R-12, R-21. R-05 is
filed as [#1573](https://github.com/copse-dev/agent-pane/issues/1573), and R-06 landed in
#1458. R-04 should share one issue against [`mission-control.md`](mission-control.md) with
R-20 and R-22, since they are one surface. R-08, R-12, and R-21 still need their own owners.
