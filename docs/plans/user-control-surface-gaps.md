# User control surface gaps

Status: **Proposed.** No implementation is on `main`. This document is an audit of
user-facing control and chat-management affordances that Copse does not currently
expose, with a delivery order. Each phase below should become its own issue; this plan
is the shared rationale they link back to.

## Why

Copse is positioned around _control_: the user decides what the agent runs, what it
reads, and what it is allowed to touch. The engine behind that promise is unusually
strong — the project sandbox, the permission gate, the trusted-command allow-list, the
approval queue, in-process custom tools, and a broad provider catalog are all on `main`
and are ahead of what comparable commercial agentic desktop clients ship today.

The gap is not capability. It is **surface**. A user cannot set a temperature. A user
cannot tell the app which shell to run commands in. A user is not told when a session
is blocked on their approval. A pending approval is lost on restart. Several of these
are one-afternoon changes sitting on top of machinery we already built, and their
absence reads — fairly — as the product being less controllable than it is.

This plan separates that surface debt into phases so it can ship incrementally rather
than as a single "settings parity" epic.

## Method and confidence

The audit was done by reading `src/`, `packages/`, and `docs/` against a feature
baseline drawn from the category. Two caveats apply to anything marked missing:

- The audit is grep- and read-based, not runtime-verified. A feature implemented under
  vocabulary the audit did not guess would be a false negative.
- Two items in particular have adjacent machinery and should be re-checked before work
  starts rather than assumed absent: **pending-approval persistence** (the thread store
  already persists an append-only event log per thread) and **compaction with custom
  instructions** (history trimming and compaction exist; the user-supplied-instruction
  path is what is unconfirmed).

## Audit

### Present today

Ships and needs no work: streamed tool calls, interactive terminal commands
(`node-pty`, `read_terminal`, `@shell`), plan mode, Agent Skills and skill slash
commands, local + remote (HTTP) MCP including image-returning tools, web search/fetch,
subagents, image/vision, file `@`-mentioning, rich-text composer, `AGENTS.md` project
instructions, Claude Code-compatible hooks, per-chat draft autosave, thread forking,
message queuing (queue/edit/send-now/held), per-thread git worktrees, the integrated
file tree + Monaco editor + terminal, clickable path references, sidebar thread status,
and the context/token usage metrics in the footer and context wheel.

Also present, and worth stating because it is frequently a _roadmap_ item elsewhere:
edit/command sandboxing (`src/main/project-sandbox/`, `permission-gate.ts`), in-process
custom tools (`docs/custom-tools.md`), and a provider catalog well past fifty entries
(`packages/llm/src/extra-providers.ts` plus OpenRouter).

### Partial

| Area                            | State                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- |
| Typography controls             | Font **size** and UI scale are settings; font **family** is not            |
| Theming                         | Accent colour is configurable; background is theme-bound only              |
| Regenerating a response         | Fork-from-message and retry-on-failed-card exist; no direct regenerate     |
| Pausing a run                   | Interrupt/abort and approval gating exist; no pause/resume of a live loop  |
| Subscription rate-limit monitor | Covers Claude, Codex, Cursor, Hugging Face; missing Copilot and Google     |
| Google model access             | Reachable via the ACP `gemini-cli` agent, not as a first-class Code Assist |
| Compaction                      | Manual/auto compaction exists; user-supplied instructions unconfirmed      |

### Missing

Grouped by theme, which is also roughly the delivery order:

**Awareness and durability** — desktop notifications when a session is waiting;
pending tool calls persisted across restarts; a confirmation prompt before closing with
active chats; configurable notification sound and format.

**Model configuration** — system prompt override; hyperparameter controls (temperature,
top-p, max tokens, stop sequences); multiple accounts or credentials for the same
provider; GitHub Copilot as a provider; Amazon Bedrock as a provider.

**Chat management** — lifecycle statuses beyond `idle | running | error` (a
done/abandoned/backlog axis); automatic and manual tagging; relocation between projects
and duplication; tool call re-execution; `Ctrl+R` reverse-incremental prompt history
search; raw markdown view.

**Presentation** — GitHub-style callouts/admonitions in markdown; configurable diff
viewer; smooth-streaming blur/fade; emoji reactions on messages.

**Distribution** — a browser-served mode; sharing a chat by secret link; UI
translations.

## Delivery

### Phase 0 — Awareness and durability

The user cannot currently tell that the agent is waiting for them, and can lose that
state entirely by quitting. This is the phase that changes daily experience most per
line of code, and it should ship first regardless of what else is prioritized.

1. **Desktop notification when a session needs attention.** Fire on approval-required,
   `ask_user`, and run-complete-while-unfocused. Nothing in `src/main` currently
   constructs a `Notification`; the events themselves already exist on the store.
   Gate behind a setting, default on.
2. **Persist pending tool calls across restart.** Verify current behaviour against
   `thread-store.ts` and the spine schema first. If a pending approval genuinely does
   not survive a quit, that is closer to a data-loss bug than a missing feature and
   should be filed as such.
3. **Confirm before quitting with active chats.** `src/main/index.ts:609`'s
   `before-quit` handler is cleanup-only today; add a guard when any thread is running
   or has a pending approval.
4. **Notification sound and format settings.** Small, and naturally bundled with (1).

### Phase 1 — Model configuration surface

The largest credibility gap for a control-oriented product.

5. **System prompt override.** Per-profile and per-thread, layered over
   `agent-system-prompt.ts`. Needs a decision on precedence against `AGENTS.md` and
   pack-injected context.
6. **Hyperparameter controls.** Temperature, top-p, max tokens, stop sequences. The
   wire types already carry `max_tokens`; the rest needs plumbing through the provider
   contract, a per-thread override store, and a settings UI. Some providers ignore some
   knobs — the UI should reflect per-provider support rather than showing dead controls.
7. **Rate-limit monitor: add Copilot and Google.** Completes an already-shipped feature;
   `packages/plan-usage` already has the shape for it.

### Phase 2 — Chat management

8. **Lifecycle statuses.** Extend `ThreadStatus` (`src/shared/types/thread.ts:27`) with
   a user-set disposition axis, distinct from the existing runtime status. Archive
   already exists and should fold into this rather than sit beside it.
9. **Tool call re-execution.** Fits the existing approval and retry machinery; the
   interesting design question is what re-execution means for a tool whose result is
   already in history.
10. **Raw markdown view** and **`Ctrl+R` prompt history search.** Independent, small,
    high daily-use payoff.
11. **Tagging, relocation, duplication.** Larger; touches the thread store's
    project-scoped layout.

### Phase 3 — Providers and presentation

12. **Multiple credentials per provider.** Architectural: key storage is one-per-provider
    today, and this touches settings, the model picker, and `safeStorage` persistence.
13. **Copilot and Bedrock providers.** One adapter each.
14. **Markdown callouts, configurable diff viewer, font family, streaming animation,
    emoji reactions.** Cosmetic; batch them.

### Explicitly deferred

- **UI translations.** Large, invasive (there is no i18n layer at all today), and low
  leverage before GA.
- **Browser-served mode.** A genuine architectural lift, and it overlaps the existing
  SSH remote-workspace and cloud-workspace plans rather than being independent of them.
- **Sharing chats by secret link.** Requires hosting, and it cuts against the privacy
  and ZDR posture documented in `docs/privacy-data-flow.md` and
  `docs/provider-data-policies.md`. If it happens it needs a privacy decision first,
  not an implementation.

## Non-goals

This plan does not touch the agent loop, the tool registry, the sandbox, or the
provider contract's semantics. Every item above is additive surface over machinery that
already exists. Where an item would require changing the engine — multiple credentials
per provider, hyperparameters through the provider contract — that is called out in the
phase rather than hidden.

## Follow-ups

Each phase should become an issue linking here. Phase 0 items 1–3 are small enough to
be a single issue; the rest warrant one issue apiece.
