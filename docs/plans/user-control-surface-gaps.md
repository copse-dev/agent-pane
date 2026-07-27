# User control surface gaps

Status: **Proposed.** No implementation is on `main`. This document audits the
user-facing control and session-management surface Copse does not currently expose,
sets a delivery order, and records the things we have decided _not_ to build. Each
phase below should become its own issue; this plan is the shared rationale they link
back to.

## Why

Copse is positioned around _control_: the user decides what the agent runs, what it
reads, and what it is allowed to touch. The engine behind that promise is genuinely
strong and largely already on `main` — the project sandbox, the permission gate, the
trusted-command allow-list, the approval queue, in-process custom tools, credential
scrubbing, and a provider catalog well past fifty entries.

The problem is legibility. Competing agentic desktop clients make their advantages
immediately visible — named profiles, task states, plan approval, pausing, branching,
compaction controls — while several of Copse's deeper advantages are buried in settings
or invisible until execution. A user cannot set a temperature, cannot name and reuse an
agent configuration, is not told when a session is blocked on their approval, and can
quit with work in flight. Meanwhile our sandbox, our review-and-delivery workflow, and
our privacy posture are barely surfaced at all.

So this is two problems, and the plan treats them as one:

1. **Missing session control.** Real gaps in what a user can steer.
2. **Invisible strengths.** Real capability the UI never advertises.

## Method and confidence

The audit was done by reading `src/`, `packages/`, and `docs/` against a feature
baseline drawn from the category. It is read- and grep-based, not runtime-verified, so
anything marked missing could be a false negative under vocabulary the audit did not
guess. Three items are flagged for re-checking before work starts rather than assumed:

- **Pending-approval persistence** — the thread store already keeps an append-only
  event log per thread, so the durable half may exist and only the restore path be
  missing.
- **Compaction with custom instructions** — compaction and history trimming exist; the
  user-supplied-instruction path is what is unconfirmed.
- **Plan Mode** — a first audit pass wrongly counted this as shipped. It is not. See
  below; the correction matters enough to call out.

### Correction: Plan Mode is not shipped

`copse.forced-planning` (`docs/forced-planning.md`) is an opt-in, capability-gated pack
that makes a plan mandatory when the selected model measures below a threshold. It
ships disabled and exists to stop weaker models drifting. That is a useful thing and it
is not Plan Mode.

Transactional Plan Mode — propose, approve or reject, execute against the approved
plan, rewind to a prompt boundary — is **Proposed** in
[`plan-mode-and-rewind.md`](plan-mode-and-rewind.md), tracked by
[#1080](https://github.com/copse-dev/agent-pane/issues/1080), with no implementation on
`main`. It is the single largest session-control gap and it already has an owner, so
this plan does not restate its design; it just places it first in the order.

## Where we are already ahead

Recorded here because Phase 0 and Phase 3 below are partly about _surfacing_ these, not
building them.

- **Privacy.** No Copse account, no hosted backend, no product telemetry
  (`docs/privacy-data-flow.md`). Account-gated onboarding and default-on usage
  reporting are common in this category; we should treat not having them as a feature
  and say so in the product, not only in a doc.
- **Execution safety.** A real macOS sandbox, workspace boundaries, external-command
  escalation, credential scrubbing, and supply-chain checks. This is frequently a
  _roadmap_ item elsewhere.
- **Workflow depth.** Browser automation, Monaco, terminal, git changes, PR/CI
  workflows, SSH workspaces, semantic graph search, post-turn review, and two-model
  comparison. The review-and-delivery story in particular has no close equivalent.
- **Open, durable task data.** A filesystem-native, greppable thread store beats an
  opaque application database on both trust and extensibility (`README.md`,
  `docs/thread-store-format.md`).
- **Local-first model routing.** Onboarding can be skipped entirely and auto-discovers
  LM Studio, Ollama, llama.cpp, Jan, and vLLM
  (`src/renderer/views/onboarding-dialog.ts`). Our cost and privacy routing is more
  opinionated than a longer provider list would be.

## Audit

### Present today

Streamed tool calls; interactive terminal commands (`node-pty`, `read_terminal`,
`@shell`); Agent Skills and skill slash commands; local + remote (HTTP) MCP including
image-returning tools; web search/fetch; subagents; image/vision; file `@`-mentioning;
rich-text composer; `AGENTS.md` project instructions; Claude Code-compatible hooks;
per-chat draft autosave; thread forking; message queuing (queue/edit/send-now/held);
per-thread git worktrees; integrated file tree, Monaco editor, and terminal; clickable
path references; sidebar thread status; context/token usage metrics.

### Partial

| Area                            | State                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Plan mode                       | Capability-gated forced planning only; transactional Plan Mode is #1080, not shipped   |
| Compaction                      | Manual/auto compaction exists; user-supplied instructions unconfirmed, and not exposed |
| Pausing a run                   | Interrupt/abort and approval gating exist; no graceful pause/resume of a live loop     |
| Regenerating a response         | Fork-from-message and retry-on-failed-card exist; no direct regenerate                 |
| Subscription credential reuse   | Technically supported via ACP and credential read; not presented as a setup path       |
| Subscription rate-limit monitor | Covers Claude, Codex, Cursor, Hugging Face; missing Copilot and Google                 |
| Typography                      | Font size and UI scale are settings; font family and line height are not               |
| Theming                         | Accent colour is configurable; background is theme-bound only                          |

### Missing

**Session control** — graceful pause/resume; explicit compaction controls; tool call
re-execution.

**Task lifecycle** — statuses beyond `idle | running | error`
(`src/shared/types/thread.ts:27`); saved drafts surfaced in the sidebar; tagging;
relocation between projects; duplication.

**Reusable configuration** — named agent profiles bundling model, system prompt, tool
set, MCP servers, permission posture, and compaction policy, selectable per task and
per subagent. Nothing like this exists today; routing and packs are spread across
separate settings surfaces.

**Model configuration** — system prompt override; hyperparameters (temperature, top-p,
max tokens, stop sequences); multiple credentials for one provider; Copilot and Bedrock
adapters.

**Awareness and durability** — desktop notification when a session needs attention;
pending tool calls persisted across restart; confirm-before-quit with active chats;
notification sound and format.

**Observability** — no inspector for how a request was actually composed.

**Presentation and reach** — markdown callouts; configurable diff viewer; raw markdown
view; `Ctrl+R` prompt history search; font family and line height; localization;
platform reach beyond macOS 26+.

## Delivery

### Phase 0 — Session control and task lifecycle

The work that most changes how the product _reads_ to someone using it.

1. **Finish transactional Plan Mode.** Owned by
   [#1080](https://github.com/copse-dev/agent-pane/issues/1080) /
   [`plan-mode-and-rewind.md`](plan-mode-and-rewind.md). Not restated here; it is
   listed first because everything else in this phase is cheaper and less valuable.
2. **Graceful pause/resume.** Distinct from abort: suspend the loop at a tool boundary,
   keep context, resume. The approval queue already proves we can hold a run
   mid-flight.
3. **Explicit compaction controls.** Surface when compaction happened, let the user
   trigger it, and let them supply instructions. Verify the instruction path first.
4. **Task-centric lifecycle.** Expand `ThreadStatus` into a user-set disposition axis —
   Working, Needs approval, Ready, Done, Backlog, Abandoned — held separately from
   runtime status. Archive folds into this rather than sitting beside it. Surface saved
   drafts in the sidebar so unfinished work is visible.
5. **Named agent profiles.** Save model + system prompt + tools + MCP + permission
   posture + compaction policy as a named, selectable profile, per task and per
   subagent. This is the item the original audit missed entirely, and it is the one
   that turns our scattered configuration depth into something a user can perceive.
   Design question up front: profiles must compose with packs and with per-thread
   overrides rather than becoming a third parallel configuration system.

### Phase 1 — Awareness, durability, and onboarding

6. **Notify when a session needs attention.** Fire on approval-required, `ask_user`,
   and run-complete-while-unfocused. Nothing in `src/main` constructs a `Notification`
   today; the events already exist on the store. Setting-gated, default on. Sound and
   format settings bundle here.
7. **Persist pending tool calls across restart.** Check current behaviour first — if a
   pending approval genuinely does not survive a quit, file it as a data-loss bug, not
   a feature.
8. **Confirm before quitting with active chats.** `src/main/index.ts:609`'s
   `before-quit` is cleanup-only; guard when any thread is running or has a pending
   approval.
9. **"Use my existing subscription" onboarding.** We can already reuse Claude Code,
   Codex, Cursor, and ACP credentials; it is not presented as a path. Make it a
   first-run option alongside API keys and local models.
10. **Distribution reach — decide explicitly.** GA is macOS 26+ on Apple Silicon or
    Intel (`README.md`). This is the largest addressable-market constraint we have and
    it is expensive to close. The deliverable for this plan is a recorded decision, not
    an implementation: is macOS-only deliberate positioning or an artefact of where
    effort has gone? Everything else in Phase 1 is blocked on nothing; this is blocked
    on an answer.

### Phase 2 — Model configuration surface

11. **System prompt override,** per-profile and per-thread, layered over
    `agent-system-prompt.ts`. Needs a precedence decision against `AGENTS.md` and
    pack-injected context. Lands naturally on top of Phase 0's profiles.
12. **Hyperparameter controls** — temperature, top-p, max tokens, stop sequences. Wire
    types already carry `max_tokens`; the rest needs the provider contract, a
    per-thread override store, and UI that reflects per-provider support rather than
    showing dead knobs.
13. **Rate-limit monitor: add Copilot and Google.** Completes a shipped feature;
    `packages/plan-usage` already has the shape.
14. **Multiple credentials per provider.** Architectural — key storage is
    one-per-provider today and this touches settings, the model picker, and
    `safeStorage`.
15. **Copilot and Bedrock adapters.** One each.

### Phase 3 — Observability and polish

16. **Redacted execution inspector.** Show how a request was actually composed:
    provider payload structure, cache behaviour, tool schemas, retries, timings. The
    category norm is exposing raw HTTP/SSE traffic; we should default to sanitized
    views and treat raw capture as an explicit, non-retained opt-in. Building the
    redacted version _is_ the differentiated version — it also finally makes the
    credential-scrubbing work visible.
17. **Tool call re-execution.** Fits existing approval and retry machinery; the open
    design question is what re-execution means for a tool whose result is already in
    history.
18. **Tagging, relocation, duplication.** Touches the thread store's project-scoped
    layout.
19. **Polish batch.** Font family and line height, raw markdown view, `Ctrl+R` prompt
    history search, markdown callouts, configurable diff viewer.

## Non-goals

Not deferred — declined. Copying these would cost us the positioning the rest of this
plan is trying to make visible.

- **Mandatory accounts or a hosted backend.** Account-free operation is a
  differentiator, not an onboarding gap.
- **Cloud chat sharing by secret link.** Needs hosting and cuts against
  `docs/privacy-data-flow.md` and `docs/provider-data-policies.md`. If it is ever
  wanted it needs a privacy decision first, not an implementation.
- **Raw request/response traffic retained by default.** Item 16 exists instead.
- **Cosmetic streaming animation as headline work.** Fine in the polish batch; never a
  milestone.
- **Out-toggling the category.** We should not compete on count of settings. Borrow
  interaction primitives that reinforce safety and review — lifecycle states, profiles,
  plan approval, pause/resume, the redacted inspector — and skip the rest.

## Deferred

- **Localization.** No i18n layer exists at all; the work is invasive and low leverage
  before GA. It stays a known polish gap rather than a decline.
- **Browser-served mode.** A genuine architectural lift that overlaps the SSH
  remote-workspace and cloud-workspace plans rather than being independent of them.

## Positioning

The framing the phases are ordered against, recorded so the sequencing is auditable:

> Copse is the private, safety-first engineering workbench that reviews its own work.

Phase 0 makes the agent steerable, Phase 1 makes it trustworthy to leave running,
Phase 2 makes it configurable, Phase 3 makes what it did inspectable. Anything that
does not serve that sentence belongs in the polish batch or in Non-goals.

## Follow-ups

Each phase becomes an issue linking here. Phase 0 items 2–5 warrant one issue apiece;
item 1 already has #1080. Phase 1 items 6–8 can share one issue; 9 and 10 are separate,
and 10 is a decision rather than an implementation.
