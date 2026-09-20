---
title: 'Architecture — Copse'
description: 'Interactive, source-verified systems diagrams for the Copse desktop coding assistant.'
canonical: https://copse.dev/architecture.html
generated_from: site/architecture.html
---

<!-- Generated from site/architecture.html by scripts/sync-site-markdown.mts.
     Do not edit by hand — edit the page and run `npm run site:md`. -->

System map

# How Copse fits together

Explore the desktop runtime, agent turn, safety gates, persistent data, UI bridge, auxiliary agents, workspace services, build pipeline, and the audited changes now on main. Choose a view, then select any component to see its responsibilities and source files.

Verified against `origin/main` at `cf0a14c2`. All 226 cited source paths exist at that revision; the Main delta view summarizes the 46 incoming commits.

## Overview

Layers: User interface · Desktop runtime · Execution and integrations · Durable state

### User — User surface

_prompts + approvals_

The user selects a workspace and model, submits prompts, reviews diffs, answers questions, and grants or denies privileged operations.

Source: `src/renderer/views/input-bar.ts`, `src/renderer/views/approval-dialog.ts`

### Renderer — Runtime

_DOM + store_

A framework-free DOM UI renders chat, panes, Monaco, terminal output, browser state, approvals, and streamed agent activity from an in-memory event store.

Source: `src/renderer/main.ts`, `src/shared/store/store.ts`, `src/renderer/controller/agent.ts`

### Preload bridge — Safety boundary

_typed IPC API_

The context-isolated preload exposes a narrow window.api surface. Renderer code never receives direct Node or Electron privileges.

Source: `src/preload/index.ts`, `src/preload/api.d.ts`

### Main process — Runtime

_trusted host_

The Electron main process owns startup, windows, IPC validation, native modules, subprocesses, providers, storage, and shutdown.

Source: `src/main/index.ts`, `src/main/app-init.ts`

### Agent service — Core logic

_route + orchestrate_

The main orchestration seam resolves the selected execution mode, builds prompts and toolsets, enforces context budgets, starts hooks, and streams one coherent turn.

Source: `src/main/services/agent-service.ts`, `packages/agent/src/run-agent-loop.ts`

### Tool registry — Core logic

_validate + execute_

Built-in, MCP, skill, and custom tools share one registry that validates arguments, applies read-only restrictions, runs permission checks, and normalizes results.

Source: `src/main/services/tool-registry.ts`, `src/main/services/registry-bootstrap.ts`

### Model routes — External system

_native / ACP / remote_

A model selection routes to the built-in provider loop, a persistent local ACP agent, or a managed remote agent service. Direct providers also enforce approved egress hosts and surface retention/training policy.

Source: `src/main/services/providers/provider-selection.ts`, `src/main/services/providers/approved-provider-hosts.ts`, `packages/llm/src/data-policies.ts`, `src/main/services/acp/acp-agent-service.ts`

### IPC guards — Safety boundary

_sender + schema_

Every privileged renderer request crosses sender checks and Zod-backed argument validation before it reaches services.

Source: `src/main/ipc/ipc-guards.ts`, `src/main/ipc/register-handlers.ts`

### Workspace I/O — Runtime

_local or SSH_

A workspace abstraction directs file, Git, shell, terminal, and search work to the local machine or a configured SSH host.

Source: `src/main/services/workspace.ts`, `src/main/services/workspace-fs/get-workspace-fs.ts`, `src/main/services/ssh-workspace/connection-manager.ts`

### Safety plane — Safety boundary

_policy + sandbox_

Tool-specific approval policy, hooks, diff review, workspace trust, and the macOS project sandbox constrain what model-authored actions can do.

Source: `src/main/services/security/permission-policy.ts`, `src/main/services/security/permission-gate.ts`, `src/main/project-sandbox/index.ts`

### Integrations — External system

_MCP / web / GitHub_

Optional integrations include MCP servers, browser automation, direct web search/fetch, GitHub CLI/API operations, model APIs, and update infrastructure.

Source: `src/main/services/mcp/mcp-registry.ts`, `src/main/services/browser/session-manager.ts`, `src/main/services/github/gh-service.ts`

### Child processes — Runtime

_PTY / MCP / ACP / index_

The main process supervises terminal PTYs, command runners, background tasks, stdio MCP servers, ACP agents, SSH processes, gortex, and sandbox workers.

Source: `src/main/services/exec/terminal-service.ts`, `src/main/services/exec/command-runner.ts`, `src/main/services/search/semantic-index.ts`

### Local stores — Persistent data

_threads + settings + indexes_

Conversation spines and OKF message files live under ~/.copse; Electron user data holds settings, keys, browser state, usage, and semantic indexes; Git refs hold short-lived backups.

Source: `src/main/services/thread-store.ts`, `src/main/services/storage/settings.ts`, `docs/thread-store-format.md`

### Relationships

| From           | Relationship | To              |
| -------------- | ------------ | --------------- |
| User           | interacts    | Renderer        |
| Renderer       | window.api   | Preload bridge  |
| Preload bridge | IPC          | Main process    |
| Main process   | registers    | IPC guards      |
| IPC guards     | agent:run    | Agent service   |
| Agent service  | selects      | Model routes    |
| Agent service  | tool calls   | Tool registry   |
| Tool registry  | file / Git   | Workspace I/O   |
| Tool registry  | permission   | Safety plane    |
| Tool registry  | optional     | Integrations    |
| Workspace I/O  | processes    | Child processes |
| Main process   | read / write | Local stores    |
| Agent service  | history      | Local stores    |
| Integrations   | results      | Local stores    |

## Agent turn

Layers: Compose and route · Built-in loop · Stream and persist

### Composer — User surface

_user content_

The renderer packages text, image/thread/file attachments, invoked skills, model, todos, working brief, and continuation budget into the run payload.

Source: `src/renderer/views/input-bar.ts`, `packages/agent/src/parse-agent-run-payload.ts`

### agent:run — Safety boundary

_IPC boundary_

The main process validates the sending frame and thread id, hydrates model history, invokes runAgent, then caches the returned LLM history.

Source: `src/main/index.ts`, `src/main/ipc/ipc-guards.ts`

### Pre-submit — Core logic

_hook + PII_

beforeSubmitPrompt may block or inject context. Optional PII redaction replaces personal data before any local, remote, or ACP provider path.

Source: `src/main/services/agent-service.ts`, `src/main/services/security/pii-redactor.ts`, `src/main/services/hooks/before-submit-prompt.ts`

### Route model — Core logic

_3 execution paths_

The resolved model id selects the built-in model loop, a local ACP process, or a remote managed-agent service.

Source: `src/main/services/providers/resolve-agent-model.ts`, `src/main/services/agent-service.ts`

### ACP / remote — External system

_own loop_

ACP agents keep per-thread local sessions and remote agents run service-managed sessions. Both translate their event streams into native StreamChunk records.

Source: `src/main/services/acp/acp-agent-service.ts`, `src/main/services/remote/remote-agent-client.ts`

### Prepare turn — Core logic

_prompt + budget_

The native path builds the system prompt, fingerprints the offered toolset, runs turnStart hooks, estimates context, trims old history, and derives read limits.

Source: `src/main/services/agent-system-prompt.ts`, `src/main/services/history-trimming.ts`, `src/main/services/context-estimate.ts`

### LLM provider — External system

_policy + stream_

Anthropic, OpenAI, OpenRouter, LM Studio, extra OpenAI-compatible providers, or the development mock enforce provider-specific request policy and emit text, reasoning, tool calls, usage, and a stop reason.

Source: `packages/llm/src/create-provider.ts`, `packages/llm/src/provider-host-policy.ts`, `packages/llm/src/data-policies.ts`

### Agent loop — Core logic

_bounded steps_

runAgentLoop alternates provider streams and parallel tool execution within step, wall-clock, LLM-call, context, and output guards.

Source: `packages/agent/src/run-agent-loop.ts`, `packages/agent/src/agent-loop-limits.ts`, `packages/agent/src/agent-loop-guards.ts`

### Tool call — Core logic

_registry path_

Tool arguments are parsed and validated, approved when necessary, executed, and returned to the conversation as tool-result messages.

Source: `src/main/services/tool-registry.ts`, `packages/agent/src/normalize-tool-result.test.ts`

### Post-turn — Core logic

_review + follow-up_

Changed turns can run the pre-review hook, reviewer/remediation cycles, model comparison, todo closeout, stop hooks, and shared continuation accounting before one terminal done.

Source: `src/main/services/post-turn-orchestration.ts`, `src/main/services/review-subagent-runner.ts`, `src/main/services/model-comparison-runner.ts`

### StreamChunk bus — Runtime

_main → renderer_

The AgentHost sends typed chunks for text, reasoning, tools, usage, context pressure, subagents, todos, reviews, hooks, and completion over agent:chunk.

Source: `src/main/services/agent-chunk-sink.ts`, `src/shared/types/stream.ts`, `src/preload/index.ts`

### Agent controller — Runtime

_fold UI state_

The renderer folds chunks into message bubbles, tool cards, subagent sessions, todos, review cards, context usage, and attention state.

Source: `src/renderer/controller/agent.ts`, `src/shared/store/thread-helpers.ts`, `src/shared/store/subagent-helpers.ts`

### Autosave — Persistent data

_event-level writes_

Finalized messages append immediately; debounced metadata reconciliation creates, patches, or deletes thread records through serialized per-thread IPC writes.

Source: `src/renderer/controller/persistence.ts`, `src/main/services/thread-store.ts`

### Queue drain — Core logic

_next turn_

On done, held and queued messages are drained with turn-tree continuation budgets; async hooks can add epoch-scoped queue messages.

Source: `src/renderer/controller/message-queue.ts`, `src/main/services/hooks/continuation-ledger.ts`

### Relationships

| From             | Relationship     | To               |
| ---------------- | ---------------- | ---------------- |
| Composer         | invoke           | agent:run        |
| agent:run        | start            | Pre-submit       |
| Pre-submit       | redacted         | Route model      |
| Route model      | ACP / cloud      | ACP / remote     |
| Route model      | native           | Prepare turn     |
| Prepare turn     | messages + tools | LLM provider     |
| LLM provider     | chunks           | Agent loop       |
| Agent loop       | execute          | Tool call        |
| Tool call        | tool result      | LLM provider     |
| Agent loop       | stop             | Post-turn        |
| ACP / remote     | translated       | StreamChunk bus  |
| Post-turn        | single done      | StreamChunk bus  |
| StreamChunk bus  | fold             | Agent controller |
| Agent controller | events           | Autosave         |
| Agent controller | done             | Queue drain      |
| Queue drain      | continuation     | agent:run        |

## Harness

Layers: Steering — redirect the run · The run loop · Guardrails — gate and stop

### Interjections — User surface

_queued input_

Queued user messages drain at idle and beforeSubmitPrompt hooks can inject context or hold a submit, steering the next turn without stopping the run.

Source: `src/renderer/controller/message-queue.ts`, `src/main/services/hooks/before-submit-prompt.ts`

### Brief & todos — Core logic

_goal + plan_

The working brief (parent goal) and todo state shape the run and are pinned into the prompt so the model keeps to the plan.

Source: `packages/agent/src/working-brief.ts`, `src/shared/todos/todo-logic.ts`, `src/main/services/agent-run-todos.ts`

### Turn-start hooks — Core logic

_context assembly_

turnStart hooks fold todo, commit, and GitHub-link context into the first message each turn as capped system-reminder blocks.

Source: `packages/agent/src/hooks/turn-start-hooks.ts`, `packages/agent/src/todo-steering.ts`, `packages/agent/src/commit-steering.ts`

### Step nudges — Core logic

_stuck / loop / continue_

stepBoundary hooks read conversation pressure and inject nudges — force a text answer, break redundant exploration, or continue a truncated stream — that the loop applies mid-run.

Source: `packages/agent/src/hooks/step-boundary-hooks.ts`, `packages/agent/src/agent-loop-escalation.ts`, `packages/agent/src/agent-loop-guards.ts`

### Advisor — External system

_strategic guidance_

A larger advisor model gives the cheaper executor mid-task strategic guidance, exposed as a gated advisor tool.

Source: `src/main/services/advisor-strategy.ts`, `src/main/services/advisor-runner.ts`, `src/main/tools/advisor-tool.ts`

### agent:run — Safety boundary

_validated entry_

The agent:run handler asserts the sender frame and validates the payload with zod before invoking the run host; agent:abort trips the controller.

Source: `src/main/index.ts`, `src/main/ipc/ipc-guards.ts`, `packages/agent/src/parse-agent-run-payload.ts`

### Run host — Core logic

_setup + abort_

runAgent sets up the provider, toolset, abort controller, deadlines, hook recording, and continuation budget, then hands off to the pure loop.

Source: `src/main/services/agent-service.ts`

### Run loop — Core logic

_step • stream • tools_

runAgentLoop steps a turn — build messages, stream the provider, run the tool batch — and repeats until a final answer, maxSteps, or the budget is reached.

Source: `packages/agent/src/run-agent-loop.ts`

### Limits & budget — Core logic

_deadlines + grant_

Sliding-idle and wall-clock deadlines, an LLM-call budget, and a per-turn-tree continuation grant bound how far a run may keep going on its own.

Source: `packages/agent/src/agent-loop-limits.ts`, `packages/agent/src/hooks/continuation-budget.ts`

### Tool registry — Safety boundary

_validate + gate_

ToolRegistry.execute validates arguments against the tool schema, applies the read-only block, runs the gates, and appends any hook-injected context to the result.

Source: `src/main/services/tool-registry.ts`, `src/main/services/agent-run-readonly.ts`, `src/shared/tools/readonly-tools.ts`

### Permission gate — Safety boundary

_default-allow_

The default-allow permission gate explicitly gates shell, MCP, custom, web, browser, and GitHub-write tools, requesting human approval when policy demands.

Source: `src/main/services/security/permission-gate.ts`, `src/main/services/security/permission-policy.ts`, `src/main/services/approval.ts`

### Tool-gate hooks — Safety boundary

_deny / ask / rewrite_

toolGate hooks run through the dialect adapters and can only tighten the call — deny, ask, or rewrite input — with sequential rewrites re-running policy host-side.

Source: `src/main/services/hooks/tool-gate.ts`, `src/main/services/hooks/copse-adapter.ts`

### Sandbox — Safety boundary

_spawned processes_

Hook and tool processes spawn inside the project sandbox by default, and sandbox violations are surfaced rather than silently allowed.

Source: `src/main/services/hooks/hook-spawn.ts`, `src/main/project-sandbox/spawn.ts`, `src/main/services/security/sandbox-failure.ts`

### Halt-run — Safety boundary

_abort path_

A hook's haltRun, or a tripped deadline or runaway limit, routes through the run's AbortController to break the loop cleanly.

Source: `src/main/services/hooks/halt-run.ts`, `packages/agent/src/agent-loop-limits.ts`

### Relationships

| From             | Relationship   | To               |
| ---------------- | -------------- | ---------------- |
| agent:run        | runAgent       | Run host         |
| Run host         | step           | Run loop         |
| Run loop         | bounded        | Limits & budget  |
| Interjections    | queued input   | Run host         |
| Brief & todos    | pins           | Turn-start hooks |
| Turn-start hooks | inject context | Run loop         |
| Step nudges      | stepBoundary   | Run loop         |
| Advisor          | guidance       | Run loop         |
| Run loop         | tool call      | Tool registry    |
| Tool registry    | permission     | Permission gate  |
| Permission gate  | hook gate      | Tool-gate hooks  |
| Tool-gate hooks  | spawn          | Sandbox          |
| Tool-gate hooks  | deny           | Halt-run         |
| Halt-run         | abort          | Run loop         |
| Limits & budget  | limit hit      | Halt-run         |

## Tools & safety

Layers: Common tool path · Policy branches · Execution boundaries

### Offered toolset — Core logic

_model-visible_

Registry bootstrap combines always-on tools with capability- and setting-gated tools. The parent loop can further filter delegated or read-only surfaces.

Source: `src/main/services/registry-bootstrap.ts`, `src/main/services/agent-service.ts`

### Validate args — Safety boundary

_Zod / schema_

Every tool call is looked up by name and parsed against its own Zod schema before permission or execution.

Source: `src/main/services/tool-registry.ts`, `src/shared/types/tools.ts`

### Read-only gate — Safety boundary

_deny mutations_

Run-scoped read-only mode rejects mutating built-ins and uses MCP annotations plus conservative defaults for external tools.

Source: `src/main/services/agent-run-readonly.ts`, `src/shared/tools/readonly-tools.ts`

### toolGate hooks — Safety boundary

_deny / ask / inject_

Canonical hooks and Cursor/Claude adapters may allow, deny, ask, inject current-turn context, halt the run, or queue a later message.

Source: `src/main/services/hooks/tool-gate.ts`, `src/main/services/security/permission-gate.ts`

### Policy — Safety boundary

_pure decision_

decideShellPermission and companion MCP/custom/browser rules combine platform, sandbox state, static scope, user settings, remembered grants, and optional classifier evidence.

Source: `src/main/services/security/permission-policy.ts`, `src/main/services/security/shell-scope.ts`

### Reads — Runtime

_scoped + screened_

Workspace-scoped files, search, Git, and diagnostics can auto-run when policy permits. User-owned terminal scrollback is separately screened for secrets and prompt injection, with approval on risk or classifier failure.

Source: `src/main/tools/file-tools.ts`, `src/main/tools/read-terminal-tool.ts`, `src/main/services/security/terminal-read-guard.ts`

### File edits — Safety boundary

_diff queue_

Write and replacement tools resolve workspace paths, create a proposed diff, block on the renderer approval queue, and apply only accepted content.

Source: `src/main/tools/write-file-tool.ts`, `src/main/tools/str-replace-tool.ts`, `src/main/services/diff-queue.ts`

### Shell — Safety boundary

_scope matrix_

Static analysis classifies commands as sandbox, ambiguous, or external. macOS can auto-run contained work inside ASRT; without a sandbox, host execution prompts.

Source: `src/main/tools/shell-tool.ts`, `src/main/services/security/shell-scope.ts`, `src/main/project-sandbox/spawn.ts`

### MCP tools — External system

_per-tool approval_

Namespaced mcp__server__tool calls use server metadata, annotations, workspace trust, remembered grants, and first-party bundled status to choose approval.

Source: `src/main/services/mcp/mcp-registry.ts`, `src/main/services/security/permission-policy.ts`

### Custom tools — External system

_full Node privilege_

User-installed JavaScript tools load only from the trusted user-data tools directory and always prompt before their in-process Node execution.

Source: `src/main/services/mcp/custom-tools-registry.ts`, `docs/custom-tools.md`

### Browser tools — Safety boundary

_origin allowlist_

Browser tools are setting-gated and constrain agent navigation and interaction through an origin policy while isolating website content in a guest session.

Source: `src/main/tools/browser-tools.ts`, `src/main/services/browser/browser-origin-policy.ts`, `src/main/services/browser/session-manager.ts`

### Package install — Safety boundary

_extra hardening_

Detected package managers always surface approval and can be wrapped with Socket Firewall while JavaScript install lifecycle scripts are disabled.

Source: `src/main/services/security/safe-install.ts`, `src/main/services/security/socket-firewall.ts`

### Workspace trust — Safety boundary

_project config gate_

Project MCP configs and project hooks are attacker-controlled until the user trusts the workspace; user/global definitions retain priority.

Source: `src/main/services/security/workspace-trust.ts`, `src/main/services/mcp/mcp-registry.ts`

### Approval UI — User surface

_human decision_

The main process pauses a permission, diff, ask-user, SSH, install, or sandbox-escape request while the renderer presents the exact action and choices.

Source: `src/main/services/approval.ts`, `src/renderer/views/approval-dialog.ts`, `src/main/services/ask-user.ts`

### Contained exec — Runtime

_workspace boundary_

Local/SSH workspace services, the macOS project sandbox, and path resolvers contain approved operations to their intended execution target.

Source: `src/main/services/workspace.ts`, `src/main/services/workspace-fs/workspace-fs.ts`, `src/main/project-sandbox/index.ts`

### External exec — External system

_explicit approval_

Network access, out-of-workspace paths, GitHub mutations, package downloads, and sandbox retry run outside containment only after the relevant approval path.

Source: `src/main/services/security/permission-gate.ts`, `src/main/services/exec/command-runner.ts`

### Normalized result — Core logic

_loop + audit_

Tool output is size-capped and normalized with optional edit stats or markdown format, then recorded in the thread and fed back to the model.

Source: `src/main/services/tool-registry.ts`, `src/main/services/exec/subprocess-output-cap.ts`, `src/main/services/thread-store.ts`

### Relationships

| From            | Relationship    | To                |
| --------------- | --------------- | ----------------- |
| Offered toolset | call            | Validate args     |
| Validate args   | parsed          | Read-only gate    |
| Read-only gate  | allowed         | toolGate hooks    |
| toolGate hooks  | decision        | Policy            |
| Policy          | read            | Reads             |
| Policy          | write           | File edits        |
| Policy          | command         | Shell             |
| Policy          | mcp__           | MCP tools         |
| Policy          | custom__        | Custom tools      |
| Policy          | web             | Browser tools     |
| Shell           | package op      | Package install   |
| MCP tools       | project config  | Workspace trust   |
| toolGate hooks  | project hook    | Workspace trust   |
| File edits      | diff            | Approval UI       |
| Shell           | prompt          | Approval UI       |
| MCP tools       | prompt          | Approval UI       |
| Custom tools    | always          | Approval UI       |
| Browser tools   | origin          | Approval UI       |
| Reads           | execute         | Contained exec    |
| File edits      | apply           | Contained exec    |
| Shell           | sandbox         | Contained exec    |
| Approval UI     | approved escape | External exec     |
| Contained exec  | output          | Normalized result |
| External exec   | output          | Normalized result |

## Data & storage

Layers: In-memory state and write coordination · Conversation and project state · Auxiliary local state

### Renderer store — Runtime

_AppState + events_

A small in-memory store holds active project/thread state, pane layout, messages, tool calls, diffs, usage, todos, and transient UI state.

Source: `src/shared/store/store.ts`, `src/shared/store/events.ts`, `src/shared/types/state.ts`

### Autosave mapper — Core logic

_event → write_

Renderer events become serialized create, appendMessage, updateMeta, delete, or shared-storage writes, with a 250ms metadata debounce.

Source: `src/renderer/controller/persistence.ts`

### Storage IPC — Safety boundary

_validated bridge_

threads:* and storage:* handlers validate identifiers and payloads before handing writes to main-process stores.

Source: `src/main/ipc/register-handlers.ts`, `src/main/ipc/ipc-guards.ts`

### Write queues — Core logic

_per-key ordering_

Renderer-side chains and the main-process write queue prevent stale in-flight writes or read-modify-write races from clobbering newer state.

Source: `src/renderer/controller/persistence.ts`, `src/main/services/storage/write-queue.ts`

### LLM — Persistent data

_history_

Provider-format history is cached per thread in main memory and mirrored in config storage so the next turn can resume after restart.

Source: `src/main/index.ts`, `src/main/services/storage/storage.ts`

### Thread directory — Persistent data

_~/.copse/workspace_

Each project/thread directory contains meta.json, append-only events.jsonl, OKF message and reasoning files, tool-result/image blobs, toolset fingerprints, and recursive subagent sessions.

Source: `src/main/services/thread-store.ts`, `src/shared/threads/spine-schema.ts`, `docs/thread-store-format.md`

### Catalogs — Persistent data

_rebuildable JSONL_

Per-project catalog.jsonl powers thread references; an agent-PR index links threads to remote-agent PRs. Both can rebuild from thread directories.

Source: `src/main/services/thread-store.ts`

### config.json — Persistent data

_electron-store_

Projects, active project, UI state, usage events, remembered grants, and provider-format LLM history use the cached general Electron store.

Source: `src/main/services/storage/storage.ts`, `src/main/services/storage/cached-store.ts`

### settings.json — Persistent data

_keys + preferences_

Validated application settings and provider keys live in a separate Electron store. Keys use OS safeStorage when available or require explicit plaintext consent.

Source: `src/main/services/storage/settings.ts`, `src/main/services/storage/settings-schema.ts`

### Git — Persistent data

_refs_

Dirty-worktree restore points are commits retained under refs/copse/backups/*; the newest ten are kept as a short-term safety net.

Source: `src/main/services/worktree-backup.ts`, `docs/recovery.md`

### Knowledge OKF — Persistent data

_~/.copse/knowledge_

Project-scoped memories and roadmap notes are human-readable OKF Markdown with a rebuildable append-only ordering index.

Source: `src/main/services/storage/knowledge-store.ts`, `src/main/tools/memory-tools.ts`, `src/main/tools/roadmap-tools.ts`

### Long tasks — Persistent data

_resumable JSON_

Experimental long-horizon checklists persist by workspace outside any one chat thread.

Source: `src/main/services/storage/long-task-tracker.ts`

### Usage ledger — Persistent data

_tokens + cost_

Normalized usage events are deduplicated, pruned, attributed by model/project/thread/source, and combined with thread history for summaries.

Source: `src/main/services/storage/usage-ledger.ts`, `src/shared/usage/aggregate-usage.ts`

### Browser profile — Persistent data

_copse-browser_

The interactive browser uses a persistent profile partition isolated from the application renderer, retaining cookies and site storage.

Source: `src/main/services/browser/session-manager.ts`, `docs/privacy-data-flow.md`

### Search index — Persistent data

_gortex / cache_

Semantic code indexes and daemon state live inside app data under a sandboxed HOME and can be rebuilt from the workspace.

Source: `src/main/services/search/semantic-index.ts`, `src/main/services/search/bundled-semantic.ts`

### Relationships

| From             | Relationship     | To               |
| ---------------- | ---------------- | ---------------- |
| Renderer store   | events           | Autosave mapper  |
| Autosave mapper  | invoke           | Storage IPC      |
| Storage IPC      | serialize        | Write queues     |
| Write queues     | provider history | LLM              |
| Write queues     | messages / meta  | Thread directory |
| Thread directory | index            | Catalogs         |
| Write queues     | shared state     | config.json      |
| Write queues     | preferences      | settings.json    |
| Write queues     | backup           | Git              |
| config.json      | usage events     | Usage ledger     |
| Storage IPC      | notes            | Knowledge OKF    |
| Storage IPC      | tasks            | Long tasks       |
| Storage IPC      | session          | Browser profile  |
| Storage IPC      | index            | Search index     |

## UI & IPC

Layers: Renderer composition · Context-isolated bridge · Main-process handlers and streams

### App shell — Runtime

_boot + layout_

renderer/main.ts initializes sanitization, highlighting, theme, project state, pane layout, controllers, dialogs, and all view mount points.

Source: `src/renderer/main.ts`, `src/renderer/index.html`

### Chat surface — User surface

_conversation + input_

Conversation, composer, mentions, skill picker, queues, context warnings, todos, tools, reasoning, subagents, hooks, reviews, and model comparisons compose the chat experience.

Source: `src/renderer/views/conversation.ts`, `src/renderer/views/input-bar.ts`, `src/shared/tools/tool-display.ts`

### Right panes — Runtime

_7 work modes_

Explorer, terminal/tasks, changes, pull requests, browser, memories, and roadmap share responsive and pop-out pane infrastructure.

Source: `src/renderer/views/right-panel-layout.ts`, `src/renderer/controller/panels.ts`, `src/renderer/views/pane-popout-button.ts`

### Monaco — Runtime

_lazy bundle_

Monaco loads on demand for file viewing, diffs, and staged-change inspection, with its workers emitted as separate build assets.

Source: `src/renderer/monaco/setup.ts`, `src/renderer/monaco/monaco-global.ts`

### Markdown — Safety boundary

_stream + sanitize_

Streaming Markdown injects host sanitization, highlighting, link decoration, artifact-image policy, code blocks, tables, and Mermaid rendering.

Source: `src/renderer/markdown/sanitizer-backend.ts`, `src/renderer/markdown/highlighter-backend.ts`, `src/renderer/markdown/README.md`

### Event store — Core logic

_state fan-out_

Controllers mutate AppState and emit typed events; views subscribe to narrow event families so streaming text and drafts avoid full-shell rerenders.

Source: `src/shared/store/store.ts`, `src/shared/store/events.ts`, `src/shared/store/thread-helpers.ts`

### Controllers — Core logic

_agent / project / queue_

Controllers coordinate agent chunks, project switching, persistence, files, panels, SSH UI, attention, review retries, and message queue continuations.

Source: `src/renderer/controller/agent.ts`, `src/renderer/controller/projects.ts`, `src/renderer/controller/message-queue.ts`

### Dialogs — User surface

_human checkpoints_

Approval, ask-user, SSH prompt, onboarding, settings, file search, conversation search, and keyboard shortcuts are mounted once and driven by events or IPC.

Source: `src/renderer/views/approval-dialog.ts`, `src/renderer/views/settings-dialog.ts`, `src/renderer/views/ask-user-dialog.ts`

### window.api — Safety boundary

_contextBridge_

The preload exposes grouped clients for workspace, agent, storage, threads, files, Git/GitHub, terminal, settings, MCP, SSH, browser, roadmap, memories, usage, hooks, and tests.

Source: `src/preload/index.ts`, `src/preload/api.d.ts`

### IPC channels — Safety boundary

_invoke + event streams_

Request/response invokes coexist with push streams for agent chunks, terminal output, diffs, file/index changes, approvals, SSH prompts, MCP status, and menu actions.

Source: `src/shared/types/ipc.ts`, `src/preload/index.ts`

### Handler registry — Runtime

_service façade_

registerAllHandlers binds validated workspace, storage, thread, file, Git/GitHub, settings, MCP, roadmap, memory, index, and utility operations.

Source: `src/main/ipc/register-handlers.ts`

### Agent stream — Runtime

_typed chunks_

The main entrypoint owns agent lifecycle handlers and forwards chunks through a tiny AgentHost seam guarded against destroyed windows.

Source: `src/main/index.ts`, `src/main/services/agent-chunk-sink.ts`

### Native IPC — Runtime

_terminal / watch / SSH_

Dedicated initializers own PTY lifecycle, filesystem watchers, diff approval, ask/approval requests, and SSH prompt/connection streams.

Source: `src/main/ipc/terminal.ts`, `src/main/ipc/fs-watcher.ts`, `src/main/services/ssh-workspace/ssh-workspace-ipc.ts`

### Window policy — Safety boundary

_lockdown + guests_

Main/pop-out windows use hardened webPreferences; non-browser webContents are locked down while browser guest contents receive a separate window/open policy.

Source: `src/main/windows/create-main-window.ts`, `src/main/windows/web-contents-lockdown.ts`, `src/main/windows/browser-web-contents.ts`

### Relationships

| From             | Relationship  | To               |
| ---------------- | ------------- | ---------------- |
| App shell        | mounts        | Chat surface     |
| App shell        | mounts        | Right panes      |
| App shell        | lazy          | Monaco           |
| App shell        | installs      | Markdown         |
| Chat surface     | render / emit | Event store      |
| Right panes      | render / emit | Event store      |
| Controllers      | mutate        | Event store      |
| Dialogs          | respond       | Controllers      |
| Controllers      | calls         | window.api       |
| Dialogs          | respond       | window.api       |
| window.api       | IPC           | IPC channels     |
| IPC channels     | invoke        | Handler registry |
| IPC channels     | agent:*       | Agent stream     |
| IPC channels     | push          | Native IPC       |
| Handler registry | sender check  | Window policy    |
| Agent stream     | chunks        | Controllers      |
| Native IPC       | events        | Controllers      |

## Agents & hooks

Layers: Execution modes · Auxiliary model work · Hook and plugin platform

### Native loop — Core logic

_Copse host_

The built-in agent package is hosted in the main process and receives providers, tool execution, chunk callbacks, hooks, budgets, and auxiliary-runner contexts from app services.

Source: `packages/agent/src/agent-host.ts`, `packages/agent/src/run-agent-loop.ts`, `src/main/services/agent-service.ts`

### ACP client — External system

_local agent process_

Copse spawns a configured ACP agent over stdio, owns client callbacks and approvals, forwards eligible MCP servers, and translates session/update events to StreamChunk.

Source: `src/main/services/acp/acp-client.ts`, `src/main/services/acp/acp-agent-service.ts`, `src/main/services/acp/session-update-adapter.ts`

### ACP server — External system

_copse --acp_

Headless server mode exposes Copse’s native loop over ACP stdio to an external ACP client without opening an Electron window.

Source: `src/main/services/acp/acp-app-entry.ts`, `src/main/services/acp/acp-agent-server.ts`

### Remote agents — External system

_managed services_

Cursor or Anthropic managed-agent clients start or resume remote sessions, normalize streamed events, link repository/branch/PR state, and download artifacts.

Source: `src/main/services/remote/remote-agent-client.ts`, `src/main/services/remote/managed-agents-client.ts`, `src/main/services/remote/remote-agent-link-store.ts`

### Native — Safety boundary

_MCP bridge_

Eligible context-free Copse tools are exported through a per-session localhost HTTP MCP server so ACP agents reuse the same registry and permission path.

Source: `src/main/services/acp/acp-native-bridge.ts`, `src/main/services/tool-registry.ts`

### Explore — Core logic

_read-only subagent_

The explore tool starts a bounded read/search subagent, optionally routed to a local model, and streams its nested session into the parent tool card.

Source: `src/main/services/explore-subagent-runner.ts`, `src/main/tools/explore-tool.ts`, `packages/agent/src/run-subagent.ts`

### Delegate worker — Core logic

_bounded implementer_

Experimental orchestration lets the chat model delegate one curated implementation step to a cheaper worker with a restricted toolset.

Source: `src/main/services/orchestration-runner.ts`, `src/main/services/orchestration-strategy.ts`, `src/main/tools/delegate-step-tool.ts`

### Advisor — Core logic

_stronger guidance_

The inverse strategy keeps a cheaper executor in chat and lets it consult a stronger model using transcript plus verified repository context.

Source: `src/main/services/advisor-runner.ts`, `src/main/services/advisor-context.ts`, `src/main/tools/advisor-tool.ts`

### Reviewers — Core logic

_diff verification_

Post-turn reviewers inspect the working diff; optional remediation cycles, CI investigation, and two-model comparison plus judge add specialized verification.

Source: `src/main/services/review-subagent-runner.ts`, `src/main/services/ci-investigator-runner.ts`, `src/main/services/model-comparison-runner.ts`

### Todo workers — Core logic

_local item routing_

A newly in-progress local todo can be executed by a subagent and verified by a declarative check before its status is advanced.

Source: `src/main/services/todo-worker-runner.ts`, `src/main/services/todo-verification.ts`, `src/main/services/agent-run-todos.ts`

### Plugin registry — Core logic

_atomic lifecycle_

Plugins group tools, hooks, prompts, UI panels, settings, and namespaced storage behind one manifest and atomic enable/disable boundary. Historical rendering never depends on live registration.

Source: `packages/agent/src/plugins/plugin-manifest.ts`, `packages/agent/src/plugins/plugin-registry.ts`, `src/renderer/views/plugin-panel.ts`

### Hook registry — Core logic

_canonical events_

A dialect registry merges Copse in-process hooks with Cursor and Claude command-hook adapters behind canonical event and decision types.

Source: `src/main/services/hooks/dialect-registry.ts`, `src/main/services/hooks/copse-adapter.ts`, `src/main/services/hooks/cursor-adapter.ts`

### Hook events — Core logic

_turn + tool_

Events cover before submit, session start, step boundaries, tool gates, after tool/edit, subagents, post-turn review, stop, and async queue/halt effects.

Source: `packages/agent/src/hooks/canonical-events.ts`, `packages/agent/src/hooks/step-boundary-hooks.ts`, `src/main/services/hooks/post-turn-review.ts`

### Executors — Safety boundary

_function / command_

Function hooks run in-process; command hooks receive scrubbed session environments, deadlines, depth limits, stdout response parsing, and project trust/sandbox policy.

Source: `src/main/services/hooks/command-hook-runner.ts`, `src/main/services/hooks/hook-spawn.ts`, `src/main/services/hooks/run-deadline.ts`

### Outcomes — Safety boundary

_ask / steer / halt_

Normalized outcomes can block, ask, inject context, apply a diff, alter environment, halt a run, or enqueue epoch-scoped continuation messages.

Source: `src/main/services/hooks/permission-decision.ts`, `src/main/services/hooks/diff-apply.ts`, `src/main/services/hooks/halt-run.ts`

### Recording — Persistent data

_spine + cards_

Every hook execution records a hook_run line with timing, parse status, decision, stream blobs, and toolset fingerprint, while live runs also emit hook cards.

Source: `src/main/services/hook-run-recorder.ts`, `src/main/services/thread-store.ts`, `src/shared/hooks/hook-card.ts`

### Relationships

| From            | Relationship    | To              |
| --------------- | --------------- | --------------- |
| Native loop     | spawns          | Explore         |
| Native loop     | delegates       | Delegate worker |
| Native loop     | consults        | Advisor         |
| Native loop     | verifies        | Reviewers       |
| Native loop     | routes          | Todo workers    |
| ACP client      | HTTP MCP        | Native          |
| Native          | ToolRegistry    | Native loop     |
| Remote agents   | local post-turn | Reviewers       |
| ACP server      | hosts           | Native loop     |
| Native loop     | fires           | Hook events     |
| ACP client      | lifecycle       | Hook events     |
| Plugin registry | contributes     | Hook registry   |
| Hook registry   | subscribes      | Hook events     |
| Hook events     | dispatch        | Executors       |
| Executors       | normalize       | Outcomes        |
| Outcomes        | steer / halt    | Native loop     |
| Executors       | append          | Recording       |
| Recording       | live cards      | Native loop     |

## Workspace & search

Layers: Workspace selection and execution target · File, process, Git, and terminal services · Search and code intelligence

### Project — User surface

_root + optional SSH_

A project record binds an id and display state to either a local root or an SSH host/path; switching projects restores its thread and pane state.

Source: `src/shared/types/state.ts`, `src/renderer/controller/projects.ts`

### Workspace service — Core logic

_path policy_

The workspace service owns the active root, readable-path exceptions for thread references, write confinement, language hints, and local/remote execution target.

Source: `src/main/services/workspace.ts`, `src/main/services/ssh-workspace/execution-target.ts`

### WorkspaceFS — Core logic

_backend interface_

A shared filesystem interface gives tools and IPC local or SSH implementations for listing, reading, writing, stat, mkdir, rename, and removal.

Source: `src/main/services/workspace-fs/workspace-fs.ts`, `src/main/services/workspace-fs/get-workspace-fs.ts`

### Local — Runtime

_Node fs_

LocalWorkspaceFS and local process services operate directly against the selected workspace after path validation.

Source: `src/main/services/workspace-fs/local-workspace-fs.ts`, `src/main/services/workspace-fs/local-workspace-fs.test.ts`

### SSH — External system

_OpenSSH_

SSH connection management, prompts, askpass, transport, remote exec, remote filesystem commands, capabilities, and process metadata support remote folders.

Source: `src/main/services/ssh-workspace/connection-manager.ts`, `src/main/services/ssh-workspace/openssh-transport.ts`, `src/main/services/ssh-workspace/remote-exec.ts`

### File tools — Core logic

_read / edit / diff_

File, search, edit, staged-diff, and filesystem-operation tools consume the workspace/path abstractions and feed the same approval and audit path.

Source: `src/main/tools/file-tools.ts`, `src/main/tools/write-file-tool.ts`, `src/main/tools/file-ops-tools.ts`

### Process runner — Runtime

_shell + background_

Command routing selects local or SSH execution, caps output, propagates cancellation, and can keep opt-in background processes alive across turns.

Source: `src/main/services/exec/command-runner.ts`, `src/main/services/exec/background-process.ts`, `src/main/services/ssh-workspace/ssh-spawn.ts`

### Terminal — Runtime

_PTY + agent reads_

Main-process node-pty sessions stream to renderer xterm instances. Open shells can be mentioned with @shell; read_terminal captures bounded scrollback only after the dedicated sharing guard allows it.

Source: `src/main/services/exec/terminal-service.ts`, `src/main/tools/read-terminal-tool.ts`, `src/renderer/terminal/shell-catalog.ts`

### Git services — Runtime

_branch / diff / PR_

Dedicated Git and GitHub services power tool calls, changes pane, branch binding, PR details/actions, CI checks/logs, and worktree backups.

Source: `src/main/services/github/git-service.ts`, `src/main/services/github/gh-service.ts`, `src/main/services/worktree-backup.ts`

### Watchers — Runtime

_fs + index_

Filesystem watchers notify the renderer and keep the search index synchronized, with platform-aware watcher limits and shutdown cleanup.

Source: `src/main/ipc/fs-watcher.ts`, `src/main/services/search/workspace-index-watcher.ts`, `src/main/services/fs-watch-limits.ts`

### Lexical search — Core logic

_rg + file index_

find_files, search_code, indexed grep, slow fallback search, ignores, and Git-derived exclusions provide deterministic workspace search.

Source: `src/main/services/search/file-index.ts`, `src/main/services/search/indexed-grep.ts`, `src/main/services/search/slow-code-search.ts`

### Search routing — Core logic

_intent + fallback_

search_codebase and semantic_search choose lexical or semantic engines, resolve file references, enforce read limits, and return model-friendly summaries.

Source: `src/main/tools/search-codebase-tool.ts`, `packages/agent/src/search-routing.ts`, `src/main/services/search/file-reference-resolver.ts`

### Semantic index — External system

_gortex → vera_

Native semantic search probes a bundled gortex daemon first, then vera on PATH, while index status and workspace synchronization surface to the UI.

Source: `src/main/services/search/semantic-index.ts`, `src/main/services/search/bundled-semantic.ts`, `src/main/services/search/semantic-search.ts`

### Read-only thread mount — Persistent data

_@-referenced history_

The filesystem-native thread store is exposed as a read-only exception to ordinary workspace reads so agents can inspect referenced past conversations without gaining a write path.

Source: `src/main/services/workspace.ts`, `packages/agent/src/build-text-with-attachments.ts`, `docs/thread-store-format.md`

### Relationships

| From              | Relationship   | To                     |
| ----------------- | -------------- | ---------------------- |
| Project           | activate       | Workspace service      |
| Workspace service | select backend | WorkspaceFS            |
| WorkspaceFS       | local root     | Local                  |
| WorkspaceFS       | remote root    | SSH                    |
| Workspace service | paths          | File tools             |
| Workspace service | target         | Process runner         |
| Workspace service | target         | Terminal               |
| Workspace service | cwd            | Git services           |
| WorkspaceFS       | changes        | Watchers               |
| File tools        | queries        | Lexical search         |
| Watchers          | refresh        | Lexical search         |
| Lexical search    | results        | Search routing         |
| Search routing    | fallback       | Semantic index         |
| Workspace service | read exception | Read-only thread mount |
| Search routing    | resolve refs   | Read-only thread mount |

## Build & CI

Layers: Source graph and local build · Verification tiers · Packaging and distribution

### TypeScript — Core logic

_src + packages_

Application code lives under src with reusable @copse/agent, @copse/llm, and @copse/plan-usage packages plus @shared aliases.

Source: `src`, `packages/agent`, `packages/llm`, `packages/plan-usage`

### esbuild — Core logic

_scripts/build.mts_

The build emits main, sandbox worker, SSH askpass helper, preload, renderer, and lazy Monaco bundles plus copied assets, workers, icons, and optional native resources.

Source: `scripts/build.mts`, `scripts/copy-monaco-workers.mts`

### Node bundles — Runtime

_CJS / node22_

Main-side bundles target Node 22 and externalize Electron, node-pty, sandbox runtime, browser parsing packages, shell-quote, and electron-updater.

Source: `scripts/build.mts`, `src/main/index.ts`

### Web bundles — Runtime

_app + Monaco_

Renderer code and CSS target the browser; Monaco stays in a separate lazy bundle to keep initial application startup smaller.

Source: `scripts/build.mts`, `src/renderer/monaco/setup.ts`

### Release guard — Safety boundary

_strip test directives_

COPSE_RELEASE disables mock steering directives, minifies syntax for dead-code elimination, and fails if directive markers survive in the shipped main bundle.

Source: `scripts/build.mts`, `packages/llm/src/mock-provider.ts`

### npm run check — Safety boundary

_fast gate_

The standard gate runs node/web typecheck, ESLint, Prettier check, dead-code analysis, oracle validation, and bundled Node unit tests.

Source: `package.json`, `scripts/check-dead-code.mts`, `scripts/run-tests.mts`

### Unit tests — Core logic

_node --test_

esbuild bundles src, package, and script tests with storage shims; Node’s test runner executes them in parallel after an Electron warm-up.

Source: `scripts/run-tests.mts`, `src/main/services/storage/settings.test-shim.ts`

### Electron e2e — Runtime

_WebdriverIO_

Focused WebdriverIO specs seed isolated app data and thread directories, drive the built Electron app with the mock LLM, assert DOM/runtime behavior, and capture reference screenshots.

Source: `wdio.conf.ts`, `tests/e2e/helpers/seed-config.ts`, `tests/e2e`

### Remote e2e — External system

_cloud containers_

A dirty-tree snapshot is pushed to an isolated host; pre-baked registry images avoid on-host builds, sharded one-shot containers test under Xvfb, and logs/screenshots return locally.

Source: `scripts/remote-e2e.mts`, `ci-runners/entrypoint.sh`, `ci-runners/exec-run.sh`

### GitHub Actions — External system

_trust-tiered DAG_

Precheck gates check, benchmarks, build, and e2e. Forks stay on hosted read-only precheck; trusted same-repo static gates and e2e use selected self-hosted fleets with screenshot reconciliation.

Source: `.github/workflows/ci.yml`, `docs/ci-runner-security.md`

### electron-builder — Core logic

_asar + native unpack_

Packaging includes dist and package metadata in an asar while unpacking node-pty, the sandbox runtime, and bundled gortex resources required at runtime.

Source: `package.json`, `build/entitlements.mac.plist`

### macOS release — Safety boundary

_DMG + ZIP_

Release builds target arm64 and x64 macOS, use hardened runtime entitlements, sign/notarize when configured, and create DMG plus updater ZIP artifacts.

Source: `.github/workflows/release-mac.yml`, `package.json`, `docs/release-checklist.md`

### GitHub Release — External system

_prerelease channel_

electron-builder publishes release artifacts to GitHub; packaged macOS builds use electron-updater for background checks and user-controlled installation.

Source: `src/main/services/auto-update.ts`, `package.json`

### Supply-chain gates — Safety boundary

_CodeQL + gitleaks_

Dedicated workflows scan TypeScript/JavaScript and repository history; dependency overrides, checksum-pinned gortex downloads, npm audit, and lockfile-exact CI reduce build-chain risk.

Source: `.github/workflows/codeql.yml`, `.github/workflows/gitleaks.yml`, `scripts/gortex-checksums.json`, `docs/supply-chain-security.md`

### Relationships

| From             | Relationship        | To                 |
| ---------------- | ------------------- | ------------------ |
| TypeScript       | bundle              | esbuild            |
| esbuild          | emit                | Node bundles       |
| esbuild          | emit                | Web bundles        |
| esbuild          | release mode        | Release guard      |
| TypeScript       | validate            | npm run check      |
| npm run check    | includes            | Unit tests         |
| Node bundles     | launch              | Electron e2e       |
| Web bundles      | launch              | Electron e2e       |
| Electron e2e     | optional            | Remote e2e         |
| npm run check    | precheck / coverage | GitHub Actions     |
| Unit tests       | results             | GitHub Actions     |
| Electron e2e     | shards              | GitHub Actions     |
| Release guard    | clean dist          | electron-builder   |
| electron-builder | package             | macOS release      |
| macOS release    | publish             | GitHub Release     |
| GitHub Actions   | parallel gates      | Supply-chain gates |

## Main delta

Layers: Audit baseline · Runtime and policy changes · User experience and delivery changes

### main @ cf0a14c2 — Persistent data

_46 commits / 355 files_

The architecture audit compares the inherited d442ee4 snapshot with origin/main at cf0a14c2: 46 commits changed 355 files with 29,312 insertions and 6,438 deletions.

Source: `CHANGELOG.md`, `AGENTS.md`, `.github/workflows/ci.yml`

### Hooks — Core logic

_canonical platform_

Main completed the Copse-native dialect, session and step events, context injection, permission re-runs, halt semantics, post-turn migration, sandboxed commands, payload snapshots, and hook cards.

Source: `docs/hooks.md`, `src/main/services/hooks/copse-adapter.ts`, `packages/agent/src/hooks/step-boundary-hooks.ts`

### Plugins — Core logic

_manifest + panels_

A plugin manifest and registry now atomically group tools, hooks, prompts, UI, settings, and storage; level-2 panels carry declarative list/tree updates without arbitrary renderer code.

Source: `docs/plugins.md`, `packages/agent/src/plugins/plugin-registry.ts`, `src/renderer/views/plugin-panel.ts`

### Provider boundary — Safety boundary

_host + data policy_

Custom-provider egress is restricted to built-in, loopback, or explicitly approved hosts. Provider retention and training metadata now drives settings/model-picker badges and request-level protections.

Source: `packages/llm/src/provider-host-policy.ts`, `packages/llm/src/data-policies.ts`, `src/main/services/providers/approved-provider-hosts.ts`

### Terminal context — Safety boundary

_@shell + read guard_

Users can mention open shells and expose bounded scrollback through read_terminal. A local safety classifier screens secrets and prompt injection; uncertainty falls back to explicit approval.

Source: `src/main/tools/read-terminal-tool.ts`, `src/main/services/security/terminal-read-guard.ts`, `src/renderer/terminal/shell-catalog.ts`

### Advisor routing — Core logic

_pair assessment_

Advisor mode gained transcript plus verified repository context, ACP bridging, role-specific model selection, pair-quality assessment, and normalized tool-result handling.

Source: `src/main/services/advisor-context.ts`, `src/main/services/acp/acp-advisor.ts`, `src/main/services/advisor-strategy.ts`

### Visible UI states — User surface

_threads + diffs + cards_

Main added active-thread running dots, hook cards, file-viewer Changes mode, failed-comparison dismissal, provider policy badges, and the read-terminal/settings surfaces.

Source: `src/renderer/views/projects-pane.ts`, `src/renderer/views/context-panel.ts`, `src/renderer/views/comparison-panel.ts`

### Roadmap knowledge — Persistent data

_attachments + search_

Roadmap items now support persisted attachments and participate in the quick-open palette while preserving the existing knowledge-store and IPC boundaries.

Source: `src/main/services/storage/knowledge-attachments.ts`, `src/renderer/views/roadmap-pane.ts`, `src/renderer/views/file-search-dialog.ts`

### CI and security — External system

_gates + remote fleet_

CodeQL, gitleaks, npm-audit hardening, trust-tiered CI, label-forced full e2e, pre-baked remote images, drainable burst runners, and revised self-hosted routing changed delivery behavior.

Source: `.github/workflows/codeql.yml`, `.github/workflows/gitleaks.yml`, `scripts/remote-e2e.mts`

### Runtime baseline — Runtime

_deps + model cleanup_

Electron and npm dependencies advanced, adm-zip is overridden for the audit gate, and the obsolete live/composite intellect frontier stack was removed while model-intellect metadata remains.

Source: `package.json`, `packages/llm/src/model-intellect.ts`, `packages/llm/src/model-catalog.ts`

### Relationships

| From              | Relationship | To                |
| ----------------- | ------------ | ----------------- |
| main @ cf0a14c2   | hooks        | Hooks             |
| main @ cf0a14c2   | plugins      | Plugins           |
| main @ cf0a14c2   | egress       | Provider boundary |
| main @ cf0a14c2   | context      | Terminal context  |
| main @ cf0a14c2   | routing      | Advisor routing   |
| Hooks             | cards        | Visible UI states |
| Plugins           | panels       | Visible UI states |
| Provider boundary | badges       | Visible UI states |
| Terminal context  | mentions     | Visible UI states |
| Advisor routing   | context      | Roadmap knowledge |
| main @ cf0a14c2   | CI           | CI and security   |
| main @ cf0a14c2   | dependencies | Runtime baseline  |
| Roadmap knowledge | surface      | Visible UI states |
