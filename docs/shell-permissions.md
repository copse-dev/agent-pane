# Shell and tool permission contract

A tool cancelled while waiting for permission reports cancellation and never
executes after the signal aborts. A negative gate result preserves its denial
reason, distinguishing a user decline from policy, hook and unanswered-prompt
refusals. Pending ACP approval remains a separate retryable error.

When an authorized bridged action finishes after its caller detaches, Copse
records its textual result before requesting continuation against the original
human epoch. This delivers an outcome, never re-executes the action, and does
not grant authority to run another tool.

This document describes current shipped behavior. Read it before changing permission policy, shell
scope analysis, the project sandbox, escalation, or approval UI. Historical design decisions
remain in `docs/plans/`; this is the durable cross-platform contract.

Shell command auto-run is gated by the pure `decideShellPermission` function in
`src/main/services/security/permission-policy.ts`, called from `permission-gate.ts`. The OS sandbox
runs on macOS (ASRT seatbelt) and Linux (bubblewrap). Windows, and any platform whose sandbox failed
to start, has no project OS containment: standard commands normally prompt. The optional model classifier (the safety
model, or a classifier connection chosen for safety screening) is never an authorization boundary. The deterministic auto-approval classifier may skip a prompt only while the
project sandbox is active. Explicit trusted-command grants and Guarded YOLO are separate policies;
neither supplies OS containment when the sandbox is absent.

## Permission modes and grants

Approval, containment, network authority and credential access are separate properties. The
[user sandbox guide](user/project-sandbox.md#execution-boundaries) diagrams execution boundaries;
the [auto-approval guide](user/auto-approval.md) explains the user-facing controls.

| Control                          | Scope and restriction                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard shell mode              | Contained commands may auto-run; external and destructive commands normally prompt. Local containment requires active macOS Seatbelt or Linux bubblewrap.                                                                                                                                                                                                                                                |
| Auto-run and deterministic tiers | Extra shape grants are Off, Reads, Reads + local commits, or Reads + local commits + pushes. Require auto-run, workspace trust and an active project sandbox; can authorize an external command without a prompt.                                                                                                                                                                                        |
| Trusted commands                 | Explicit binary grants route eligible commands outside the sandbox in trusted projects with auto-run on. Every segment must qualify and none may redirect into a file other than `/dev/null`; Always ask suppresses the grant.                                                                                                                                                                           |
| Per-tool override                | Inherited behavior, Always allow, Always ask or Blocked. Ordinary approval is independent of operation-specific gates and runtime containment.                                                                                                                                                                                                                                                           |
| Read-only agent mode             | Default-deny tool allowlist; MCP tools need read-only/non-destructive hints and retain their ordinary gate. Child calls inherit the run scope.                                                                                                                                                                                                                                                           |
| Strict external denial           | Classifier confidence plus a deterministic destructive signal can hard-deny. The classifier cannot authorize execution.                                                                                                                                                                                                                                                                                  |
| Outside-project reads            | Thread-scoped, in-memory grant; every command must prove an eligible plain read. Credential and whole-home/root targets are excluded.                                                                                                                                                                                                                                                                    |
| Commit-signing grants            | macOS-only isolated system signer access to an approved key/socket. Socket access is granted automatically by default and cached for the project/identity until restart; an Always ask override on git_commit asks every time and never remembers. Private-key-file consent is one commit only. Git, hooks and the agent receive no direct key/socket access.                                            |
| Web/browser grants               | Named origins; temporary scoped or persistent remembered grants. Hard URL/network denials and preview CSP remain enforced.                                                                                                                                                                                                                                                                               |
| MCP/custom grants                | Exact tools; MCP identity includes origin, source, server and name. Custom requiresApproval tools cannot remember consent. Neither grant establishes a project OS sandbox for the handler/server.                                                                                                                                                                                                        |
| Automation grants                | Exact schedule-owned MCP tools or eligible project-repository GitHub actions. No ambient shell, file, web-origin, ACP, sensitive-reveal or model-spend authority.                                                                                                                                                                                                                                        |
| Guarded YOLO                     | Session-only, thread-scoped; routine shell scope prompts waived subject to the harm gate. Keeps containment where applicable, permits external routing and retains hard denials/one-time confirmations.                                                                                                                                                                                                  |
| Environment setup                | Suggests values for the auto-approval level, trusted commands, web origins, trusted SSH hosts and trusted package registries from prompts a person approved in the active project. Applies only what the user ticks, through the same settings; adds no grant path. See [Environment setup](#environment-setup).                                                                                         |
| Deferral mode                    | Session-only, thread-scoped; approval requests queue instead of blocking. Changes prompt handling, not authorization.                                                                                                                                                                                                                                                                                    |
| Unattended container             | Explicitly armed run on an attested disposable guest. Contained shell effects allow, outward effects defer or deny, host escapes deny; budgets required. Experimental, off by default, mutually exclusive with Guarded YOLO.                                                                                                                                                                             |
| ACP permission mode              | Agent-specific session mode, additional to Copse's gate and sandbox. Sandboxed Claude presets may default to acceptEdits; unsandboxed/SSH presets do not receive that default. Remembered ACP grants are per agent and tool kind; a request that runs a command is never remembered, so every command reaches the shell gate. See [ACP permission requests](#acp-permission-requests).                   |
| Agent managed thread mode        | Opt-in per thread for external coding agents. Copse does not apply its process sandbox and selects the agent-advertised Auto/Default session mode when available. The agent's permission requests are presented without Copse's shell classifier, remembered grants, or edit auto-approval. Copse's native-tool bridge remains available and every bridged call still uses the ordinary Copse tool gate. |

## Unanswered approvals across ACP turns

Normal ACP turn completion ends tool execution and releases the execution context, but it does
not cancel an unanswered approval. The prompt remains answerable even when turn completion
arrives before the MCP client's disconnect. A later identical request in the same thread and
execution root can consume that decision once, within the existing ten-minute replay window.
Changed commands or arguments require their own approval; answering a detached prompt never
starts the old tool call.

Stop, send-now interruption, failure, idle expiry, session closure, and thread deletion revoke both
pending prompts (including detached ones) and stored answers for that thread. The bridge observes
turn and session termination separately from a disconnected call so the first abort cannot hide
later revocation. Self-started turns distinguish completion from Stop,
idle expiry, and session closure. Ordinary prompts have no approval deadline. Client abandonment
and turn completion are logged as pending requests with distinct sources; cancellation, window
closure, and explicit safety-check timeouts retain their own audit sources.

Settings holds ordinary approval dialogs back while it is open. A request for the focused thread
still receives an attention indicator and a **Review approval** action in Settings. Reviewing
closes Settings and surfaces the request through the ordinary approval dialog.

## Per-tool permission settings

### Web search providers

Settings → Web search selects Tavily, Parallel, or Not configured. `web_search` is offered only
when a provider is selected and its API key resolves; provider and key changes update availability
without restarting. `fetch_url` remains available independently. A stale call after configuration
changes returns setup guidance without making a network request. Searches never fall back to DuckDuckGo or a
different provider. Selecting a provider and resolving its API key IS the user's consent to send
search queries to that provider: `web_search` auto-allows the provider's fixed API origin instead
of a one-time web-origin prompt, still honors a disabled-approvals hard stop and a per-tool
override (an explicit Always ask on `web_search` still prompts every call). There is no separate
plugin or tool for Parallel — picking it here is the only way to reach it, and it shares the same
API key as the retired `copse.parallel-search` plugin. API keys use the existing secret store.
Tavily also supports `TAVILY_API_KEY`; Parallel supports `PARALLEL_API_KEY`. Tavily uses Basic
search with generated answers and automatic parameter selection disabled.

### Access to other conversations

An agent's first read of another thread asks **Read your other threads?** Once approved,
that thread can read every other conversation in the local chat store without another
conversation-access prompt. Its own transcript remains readable, and so is the one parent thread a
thread was explicitly started from with **Create follow-up thread** (recorded at creation as
`followUpOf`; read-only, direct parent only, never inherited by forks or by a follow-up of the
follow-up). File read guards,
the shell classifier and the sandbox read mount use the same thread-scoped permission;
the chat store is never writable through these grants.

Local shell reads also check each named target's symlink destination before reusing an
outside-project path grant. A file or directory alias into another thread still requires
conversation-read consent; revoking that consent leaves the outside-path grant insufficient.

`list_threads` searches conversation titles and summaries and returns paths for the existing
read tools. `send_thread_prompt` asks a separate **Send prompts to your other threads?**
approval. Reading never grants sending. Both grants are persisted in main-owned settings,
keyed by the requesting thread; they are not inherited by destination or forked threads.
Either permission can be revoked in the thread’s Context panel → Permissions.
Destination prompts enter the normal queue with machine provenance, consume the existing
continuation budget and respect held/paused queues. They do not interrupt active work or
switch the visible thread. An unavailable or archived destination is rejected.

The experimental interactive-client API requires its default-off plugin and desktop pairing.
Viewing and submitting decisions are separate session-only grants across all projects. A client
may approve once or deny an exact pending standard shell-command or bounded worktree-preparation session/request/revision; it cannot create remembered
grants or task leases. Pairing is desktop-only, and agent-invoked plugin runtimes have no decision
write API. Disable or quit revokes every client. Audit events identify the paired client as the
human-response source. Authentication trusts the paired software; it does not attest a physical
gesture. See [the client protocol](plugin-client-api.md).

Settings → Permissions lists registered Copse, custom, and connected MCP tools. Each tool can keep
its inherited default or receive one explicit override:

- **Always allow** skips the tool's ordinary approval prompt. It does not bypass tool-gate hooks,
  read-only mode, diff approval, workspace trust, the OS sandbox, hard web/browser denials, or
  separate operation-specific approval such as a sandbox escape or background port binding.
- **Always ask** requires approval for every invocation. It disables remembered grants,
  annotation-based/read-only auto-allow, shell auto-approval, trusted-command routing, replay
  leases, and standing outside-project read grants for that tool.
- **Blocked** rejects before hooks, prompts, cache lookup, or handler execution. If the setting
  changes to Blocked while an approval is pending, the gate rechecks it before execution.

Resetting a row removes its override and restores the existing policy behavior. Group actions store
only the explicit tool ids currently shown in that group, so tools discovered later inherit their
own defaults. Stable MCP identities include origin, source, server, and tool name; an ambiguous
legacy execution name fails closed rather than inheriting another server's grant.

Always allow is unavailable where the product contract requires a fresh operation-specific
approval: worktree preparation, mutating GitHub actions, host GUI launch, and custom tools declared with
`requiresApproval`. Mutating GitHub actions may instead receive the narrower, exact
schedule-scoped automation opt-in described below. An approval prompt's existing “remember” action
writes the same explicit Always allow policy when that policy is available.

`ask_classifier` uses saved classifier connections without a tool prompt by default.
Settings → Classifiers exposes “Ask before agent classifier questions” as an
opt-in. Enabling it writes the per-tool Always ask policy and prompts for each
question, with the full request behind Show details. Disabling it resets the
override to the default. An existing Always allow override remains valid, while
Blocked continues to deny. Each configured classifier's provider-host approval
remains a separate gate.

## Approval audit evidence

Approval decisions persist the available tool-call ID, including cancellation and
replayed answers. A shared prompt remains one decision; its detail blob lists the
tool-call IDs still waiting when it settles. The top-level ID identifies the
request that opened the prompt. Audit routing is captured at request time so an
abort outside the original async context does not lose its project/thread.

Shell escalation, expected-block, retry, contained-command and harm prompts retain
their structured reasons. Their detail blobs also capture request-time booleans:
sandbox availability, the configured auto-run setting, workspace trust,
Guarded YOLO and active network scope. These are diagnostic
facts, not a complete snapshot of all grants or an execution authorization.
Coalesced prompts retain the opening request's context. Raw command text is still
omitted: use the tool-call reference to find the existing tool arguments.

## High-level tool restrictions

This table covers the built-in registry and dynamic tool families. Feature/plugin enrollment,
credentials and per-turn availability may withhold a tool entirely. Every offered tool still passes
the explicit policy, tool-gate hooks and read-only gate before execution. **Read-only: Yes** means
membership in the run allowlist, not merely a non-mutating implementation; other tools are denied
in that mode. Always allow does not bypass the restrictions below.

| Tool(s)                                                                                                 | Operation restriction                                                                                                                                                                                                        | Read-only   |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `read_file`, `list_dir`                                                                                 | Validated workspace or authorized chat-store reads; traversal/symlink confinement and output bounds.                                                                                                                         | Yes         |
| `search_code`, `find_files`, `search_codebase`, `semantic_search`                                       | Workspace-scoped search/index access, bounded results and configured semantic-search capability.                                                                                                                             | Yes         |
| `read_skill`                                                                                            | Registered skill content; only offered when skills are available.                                                                                                                                                            | Yes         |
| `write_file`, `str_replace`, `apply_patch`                                                              | Workspace guards and diff/recoverability checks; direct apply when safe, otherwise stage for approval.                                                                                                                       | No          |
| `delete_file`, `rename_file`, `make_directory`                                                          | Validated workspace paths and file-operation diff/recoverability path.                                                                                                                                                       | No          |
| `staged_diffs`, `read_staged_diff`                                                                      | Inspect proposed changes without applying them.                                                                                                                                                                              | Yes         |
| `git_status`, `git_diff`, `git_log`, `git_show`                                                         | Repository inspection, validated path arguments and read-only local subprocess confinement where available.                                                                                                                  | Yes         |
| `git_commit`                                                                                            | Fixed stage/commit argv, hooks/signing preserved; execution approval before staging. Separate scoped signing consent; no unsigned or unsandboxed fallback.                                                                   | No          |
| `run_shell`                                                                                             | Shell policy, harm/scope analysis, execution-target routing and sandbox escalation. Unattended guests use the contained-effects policy.                                                                                      | No          |
| `run_background`                                                                                        | Shell rules plus supervised lifetime/ownership; loopback binding needs separate scoped permission.                                                                                                                           | No          |
| `preflight_worktree`                                                                                    | Enforcing OS sandbox required; network blocked, project/caches read-only, private disposable scratch. No unsandboxed fallback.                                                                                               | Yes         |
| `prepare_worktree`                                                                                      | Fresh approval of exact plan/fingerprint; scoped project/cache writes and setup network policy. No reusable arbitrary-command grant or unsandboxed fallback.                                                                 | No          |
| `gh_pr_list`, `gh_pr_view`, `gh_pr_files`, `gh_run_list`, `gh_run_view`                                 | GitHub read authority and tool availability; explicitly excluded from unattended guests.                                                                                                                                     | No          |
| `gh_api_read`                                                                                           | Copse-built `gh api` argv: REST GET or one GraphQL `query`; no flags, headers, hosts or URLs; 256 KiB output, 10 pages, 60 s. See [Host-side read tools](#host-side-read-tools).                                             | No          |
| `git_fetch`                                                                                             | Origin-only fetch of named branches / `refs/pull/<n>/head` into `refs/remotes/origin/*` through the host scratch repository. See [Host-side read tools](#host-side-read-tools).                                              | No          |
| `get_ci_status`, `get_ci_failure_logs`, `wait_for_ci_checks`                                            | GitHub reads; bounded supervisor wait. Explicitly excluded from unattended guests.                                                                                                                                           | No          |
| `gh_pr_create`, `gh_pr_approve`, `gh_pr_mark_ready`, `gh_pr_enable_auto_merge`, `gh_pr_rerun_failed_ci` | Fresh approval unless an exact owning schedule/project grant applies. Ordinary Always allow unavailable; excluded from unattended guests.                                                                                    | No          |
| `web_search`, `fetch_url`                                                                               | Web-origin policy, approval settings and hard URL/network denials, including across redirects. A configured web-search provider auto-allows `web_search`'s fixed origin (see [Web search providers](#web-search-providers)). | No          |
| `browser_navigate`                                                                                      | Task/project-owned agent browser partition; origin grants enforced at the network request boundary, separate from user cookies.                                                                                              | No          |
| `browser_preview`                                                                                       | Validated workspace preview and restrictive document/CSP policy; grants cannot relax prototype CSP.                                                                                                                          | No          |
| `browser_snapshot`, `browser_screenshot`, `browser_tabs`                                                | Scoped browser session/tab access. Inspection alone does not place a browser tool in the read-only run allowlist.                                                                                                            | No          |
| `browser_click`, `browser_type`, `browser_show`                                                         | Scoped agent browser actions; resulting requests retain network controls. Click/type may cause external website effects.                                                                                                     | No          |
| `present_visual_evidence`                                                                               | Existing capture validated as belonging to the thread; publication changes no workspace or external service state.                                                                                                           | Yes         |
| `video_frames`                                                                                          | Authorized workspace/attachment input and bounded frame/image budgets.                                                                                                                                                       | Yes         |
| `read_archive`                                                                                          | Authorized archive, extraction limits and thread-owned output; traversal/symlink entries rejected or skipped.                                                                                                                | No          |
| `read_terminal`                                                                                         | Current thread's user-shell output only; local safety screening and explicit approval fallback. Cannot type into the terminal.                                                                                               | Yes         |
| `reveal_pii`                                                                                            | Per-placeholder consent inside the handler, never remembered; current-session mapping only.                                                                                                                                  | No          |
| `image_gen`                                                                                             | Configured OpenAI credential supplies provider network authority; explicit Ask still prompts.                                                                                                                                | No          |
| `launch_gui_app`                                                                                        | Fresh host-launch approval every time; local macOS only, unavailable on SSH workspaces.                                                                                                                                      | No          |
| `device_hub`                                                                                            | Enabled Apple plugin and enrolled local macOS project; host-device approval by default, explicit tool overrides supported.                                                                                                   | No          |
| `open_simulator_desktop`                                                                                | Apple plugin/enrollment, enabled Desktop viewer and booted simulator. Agent presentation starts view-only.                                                                                                                   | No          |
| `explore`, `task`                                                                                       | Read/search or user-authored subagent delegation; child tools retain run read-only scope and permission gates.                                                                                                               | Yes         |
| `run_readonly_workers`                                                                                  | Explicit named read-only workers; supervisor admission, a two-worker turn cap, attempt deadline and owned cancellation. No writable isolation or recursive delegation.                                                       | Yes         |
| `run_isolated_workers`                                                                                  | Explicit named writable workers, each in an owned local Git checkout and diff queue; native file tools and approved preparation only. Shares the worker limits.                                                              | No          |
| `delegate_step`                                                                                         | Enabled implementation-worker feature; delegated tool calls retain permission controls.                                                                                                                                      | No          |
| `review_changes`                                                                                        | Enabled review plugin; paid-model spend can ask separately. Test/build execution needs suitable review-cell isolation.                                                                                                       | No          |
| `investigate_ci`                                                                                        | Enabled CI investigator and GitHub CLI setup; investigation uses its configured subagent/tool surface.                                                                                                                       | No          |
| `advisor`, `suggest_model`                                                                              | Enabled feature and model/provider configuration; advice grants no execution authority. Advisor can send transcript/repository context to its model.                                                                         | No          |
| `recall`                                                                                                | Enabled memory plugin; reads stored project memory.                                                                                                                                                                          | Yes         |
| `remember`                                                                                              | Enabled memory plugin; writes project memory under Copse storage.                                                                                                                                                            | No          |
| `update_todos`, `roadmap_plan`, `track_long_task`                                                       | Task/plan metadata writes, feature/ownership checks and bounded supervisor continuations where applicable.                                                                                                                   | No          |
| `ask_user`                                                                                              | Requests user input; does not itself grant operation approval.                                                                                                                                                               | Yes         |
| `request_review_input`                                                                                  | Saves a review question; explicitly not a permission approval mechanism.                                                                                                                                                     | No          |
| `propose_thread`                                                                                        | Inert proposal card; user acceptance authorizes thread creation/execution.                                                                                                                                                   | No          |
| `run_checkup`                                                                                           | Read-only diagnostics, instructed to run only on explicit user request; nevertheless excluded from the read-only run allowlist.                                                                                              | No          |
| `mcp__…`                                                                                                | Exact tool/source grants, hooks and workspace trust. Server execution is not automatically project-sandboxed. Read-only hints are advisory and do not independently grant approval.                                          | Conditional |
| Custom tools                                                                                            | User-authored in-process code with full privilege after approval/grant. requiresApproval always prompts.                                                                                                                     | No          |

Sources of truth: [registry bootstrap](../src/main/services/registry-bootstrap.ts),
[permission gate](../src/main/services/security/permission-gate.ts),
[per-tool overrides](../src/main/services/security/tool-permissions.ts),
[read-only allowlist](../src/shared/tools/readonly-tools.ts), and
[guest exclusions](../src/main/services/container-runtime/guest-tools.ts).
Keep the table aligned when tools are registered or their handlers change. The general gate's
unmatched-tool branch is default-allow: a new mutating or network-capable tool must use an explicit
operation gate or the diff queue, not rely on that branch as authorization or confinement.

Custom agents retain the ordinary tool gate and inherit run read-only scope.
`run_isolated_workers` gives each named worker an owned local Git checkout and
separate diff queue; only root-confined native file tools and the existing
preflight/approved preparation tools are available. Shells, MCP and arbitrary
custom tools are withheld from these workers. Both worker tools share the two-run
parent-turn allowance and existing supervisor limits. They cannot
call `update_thread_plan` or `report_plan_completion`: the parent owns the shared
thread plan, and workers return their findings in attributable task results.

## Unattended container boundary

The experimental container runtime runs the whole headless agent loop in a disposable guest,
without a nested per-command project sandbox. The host attests the boundary and the guest checks
its observable confinement before declaring it: non-root uid, read-only rootfs, dropped
capabilities, no-new-privileges, no ordinary network interface and only run-owned host mounts.
Docker requires its shared-kernel security profiles; Apple container uses a separate VM.
Workspace/scratch writes remain available, with resource and run budgets enforced.

The unattended ledger and attested container tier must both apply before shell permission uses
the contained-effects branch. Host escapes and harm hard-denials stay denied. Recognized outward
effects, such as push/publish/HTTP writes, defer through the approval seam; external ACP commands
that cannot be replayed are denied instead. Other contained effects can proceed even when the
desktop harm gate would ask. Explicit Ask, Blocked, hooks and read-only restrictions still apply.
Reactive retries remain inside the same guest and never grant host execution.

Network has no direct route out of the guest. A host broker enforces named destinations;
per-command access is token-gated. The run receives the model credential it needs, not ambient
host credentials or Git remotes. Results return as Git bundles to `refs/copse/runs/<id>` for
explicit adoption, without moving the host checkout's HEAD or pushing. This is not a
hostile-workload/multi-tenant guarantee; syntactic effect classification cannot identify every
possible action of arbitrary guest code.

Implementation and limits: [thread-in-container](plans/thread-in-container.md),
[runtime attestation](../src/main/services/security/runtime-containment.ts), and
[contained shell effects](../packages/shell-guard/src/container-effects.ts).

## Platform matrix

This matrix describes standard shell policy. Explicit trusted-command grants, per-tool overrides,
Guarded YOLO and attested unattended containers have the separate rules above.

| Situation                                | Sandbox-contained command                                                    | Hard-external command (network download, `git push`, install, `~/...`)                                                               | Ambiguous “may reach” command (`gh`, `nc`, cloud CLIs, `open <url>`)                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS ASRT / Linux bubblewrap active** | Auto-runs inside the project sandbox. The model classifier is not consulted. | Prompts first, then runs outside the sandbox. Recognised low-risk shapes (`git push origin`) may skip that prompt via auto-approval. | Auto-runs inside the sandbox. A verified block offers retry outside. This includes opaque interpreter heredocs, whose effects the sandbox contains. `expects_sandbox_block: true` can move that prompt before the first attempt. |
| **Windows / sandbox init failure**       | Prompts because no OS sandbox can contain it. Auto-approval does not fire.   | Prompts, unless strict-mode hard-deny applies. Auto-approval does not fire.                                                          | Prompts and is treated as external. Auto-approval does not fire.                                                                                                                                                                 |
| **Auto-run disabled**                    | Prompts.                                                                     | Prompts.                                                                                                                             | Prompts.                                                                                                                                                                                                                         |

The ambiguous tier exists because short command names also appear harmlessly as paths or arguments.
Where a sandbox is active, the sandbox—not a fuzzy match—decides whether they escape. Without a
sandbox there is no containment boundary, so ambiguity must prompt, and auto-approval cannot skip
that prompt.

A hard matcher that names a program (`ssh`, `curl`, `pnpm install`, `exec`, `eval`, `git push`,
`docker run`, …) is only a signal when something runs that program. When every segment of the
shell parser's own reading that contains the word is an inert read — a read-only tool without
an option that runs a program (`rg --pre`, `fd -x`, `sort --compress-program`, an active `sed`
script), or `echo`/`printf` without `printf -v` — the word is a search pattern, file name or
printed text. The same holds for an argument to a project script (`pnpm|npm|yarn|bun run|test`,
never `exec`, `dlx` or `x`): `pnpm test -- acp-ssh-transport` hands a test filter to a script that
already runs contained on its own. The command then reports the ambiguous reason _names a network
or code-running command only as an argument_ instead: `grep -rn ssh src`,
`sed -n 1,80p services/exec/a.ts; echo ---` and `grep "pnpm install" docs/a.md` start inside an
active sandbox, and still prompt without one. Ambiguous is not `sandbox`, so deterministic
auto-approval cannot run them outside. This relaxation fails closed: the hard reason stays when the
line does not parse, when it contains command substitution (`$(…)`, backticks) or process
substitution, when a variable decides which program runs (`$x host`), when a pipe feeds an
interpreter, `xargs`, `parallel`, `source` or `eval`, or when any segment holding the word is
anything else (`grep x f; ssh host`, `bash -c "ssh host"`, `timeout 5 ssh host`, `yarn ssh`). A
variable in an operand or redirect target (`grep ssh $FILE > $TMPDIR/out`) names no program.
Destructive and privileged matchers (`sudo`, `rm -rf`, `kill -9`, `chmod 777`, `dd`) never relax.

`rm` prompts inside an active sandbox as a recursive delete when it is recursive (`-r`, `-R`,
`--recursive`). A forced `rm -f` without `-r` deletes exactly what a plain `rm` does, which runs
contained, so `rm -f e2e-failure-artifacts/demo-failure.png` does too when every `rm` on the line
is run directly and names literal paths under the working directory. A forced delete still prompts
when its operands come from `xargs` or another wrapper, or name a path outside the project, a
variable or a glob (`find … | xargs rm -f`, `rm -f /elsewhere/x`, `rm -f *.log`).

`pnpm exec <command>` runs an installed command and is not itself an install or shell
`exec` signal, including with global options before `exec` (`pnpm -s exec tsc`). Its child
command still receives the normal scope checks, so downloads, opaque interpreter code, and
outside-project paths keep their existing policy. Corepack and package downloads retain their
existing gates. Package-manager global options never hide an install: `pnpm -s install`,
`npm --prefix web install` and `pnpm --filter app add` are hard-external like `pnpm install`.
Options are read on one line only, so a shell `exec` on the following line stays dynamic
execution.

Remembered local port-binding consent is keyed by the project root, shared across its
thread worktrees. Command execution still uses the thread's execution root and passes
the shell gate. Other projects require their own consent, and disabling the Background
tasks plugin still revokes its loopback-binding capability. Legacy worktree-root grants
are not broadened automatically; the next project-level consent can be remembered.

Newline-separated commands are inspected independently. For example, an opaque
`python3 - <<'PY'` heredoc followed by `wc -l src/a.ts` stays ambiguous and runs inside
an active sandbox: the TypeScript file belongs to `wc`, not to the interpreter.
A following script execution, download, or outside-project read still contributes
its own escalation reason. Quoted newlines and backslash line continuations remain
part of their original command's arguments.
Other package-manager `exec` commands (`npm exec`, `yarn exec`, `bun exec`) are ambiguous: they
run a project command, but npm may fetch a missing executable. They start inside an active sandbox
and ask before an outside retry only if that sandbox blocks them. Local `pnpm exec` follows the
contained `pnpm run` treatment described above. Explicit package installs remain hard-external. The
shell `exec` builtin in command position, `find -exec`, and container `exec` remain hard-external as
dynamic execution.

A native `run_shell`, `run_background` or todo-verification command in an SSH workspace
(`docs/plans/ssh-remote-repo.md`) is spawned on the remote host, where Copse applies no sandbox. The
gate therefore judges it by the **Windows / sandbox init failure** row whatever this machine's
sandbox state, and whatever containment a caller reports. It asks the same execution-target
resolution the spawn uses (`spawnRunsOnSshTarget` in `project-sandbox/spawn.ts`), and a remote
project that cannot route over SSH counts as unsandboxed rather than local.

On macOS, ASRT's network allowlist is process-wide. While a sandboxed ACP agent or background task
temporarily widens it, a newly started network-capable command could inherit that access. Copse
therefore pauses auto-run and names the holder in an approval prompt before overlapping the two.
Structurally read-only commands do not prompt because they cannot open a network connection.

### Linked worktree recovery

A contained command in a validated linked thread worktree may update that worktree's own Git
administration plus the shared object, ref, reflog, and atomic `packed-refs.lock` /
`packed-refs.new` paths. Linux must mount the common Git directory as the atomic rename boundary
because bubblewrap ignores missing file grants; it re-binds configuration, hooks, primary checkout
metadata, and discovered sibling worktree administration read-only. Those protected paths remain
outside the writable surface on every platform.

A detached thread checkout remains usable by agent turns, file and editor operations, and terminals
only during validated Git recovery. Main must validate the persisted checkout path, Git registration,
repository identity, and base commit, and the per-worktree Git directory must contain an active Git
recovery marker. The persisted branch identity is retained while HEAD is detached. An unrelated
detached checkout remains blocked. The footer offers recovery only while nothing can write to the
checkout: not during a turn (including one waiting on approval), and not while a background task
for the thread is alive. Main computes that (`agentBusy` on the attachment inspection) and
`reattachWorktree` refuses under the same condition, so a stale or scripted call cannot race an
agent.

Recovery is the fallback; prevention comes first. In a managed thread worktree the gate refuses,
before any prompt, the commands that strand a checkout: `git rebase` (any form), `git pull
--rebase` (flag or `-c pull.rebase=…`), `git bisect start`, and `git switch|checkout --detach`.
A rebase that stops on a conflict or a failed signature leaves HEAD detached, and approving it
would only strand the thread. The refusal names the alternative (`git merge`, `git pull
--no-rebase`, `git worktree add --detach` outside the checkout) and says to ask the user to run
the command in a terminal if it is truly needed. Exits from an operation already under way
(`rebase --abort|--continue|--skip|--quit`, `bisect reset`) are never refused. Shared project
checkouts are the user's own and keep ordinary policy. Classifier: `detectCheckoutDetachingCommand`
(`packages/shell-guard/src/checkout-detach.ts`). Limits: the classifier is static, so a
bare `git pull` under a `pull.rebase` set only in a config file, a script that rebases, or an
external ACP agent's own shell is not covered; recovery stays available for those.

### Deferred-worktree threads (prototype)

In an `on-write` project a thread's first turns read the user's own checkout before it has a
worktree (see [`plans/deferred-thread-worktrees.md`](plans/deferred-thread-worktrees.md)). While
deferred, a contained `run_shell` command runs in the ordinary profile with every write at or under
the checkout removed; reads, the workspace tmp dir, agent scratch, and the no-network policy are
unchanged. There is no unsandboxed route in that state: a command the platform matrix would run
outside the sandbox (hard-external, trusted-routed, or `expects_sandbox_block`), or any command when
no sandbox is active, first allocates the thread's worktree and then follows the matrix above
there. The reactive unsandboxed retry and denial-cache escalation are not offered, and the spawn
layer refuses an unsandboxed read-only request outright.

## Apple development operations

Apple Development uses actor-specific consent. Clicking Load targets, Build, Test, Run, or Cancel
in the panel authorizes that operation and does not open another approval modal. Main resolves the
enrolled project and thread, validates the selected target, constructs fixed `xcodebuild` or
`simctl` argument arrays, or resolves a macOS executable inside the validated built app bundle.
The process runs with normal host access. The generic project sandbox is not a functional boundary
for Xcode's package resolution, caches, Keychain and signing services, CoreSimulator, devices, and
project-controlled build phases.

The agent receives the pinned XcodeBuildMCP server only while the first-party plugin is enabled and
the active local macOS project is enrolled. All upstream workflows are available. Each call passes
through the normal MCP permission gate, including its per-tool remembered grants and corroborated
read-only auto-run option; enrollment alone does not approve agent execution. XcodeBuildMCP runs
with normal host access after that gate for the same Xcode service requirements as the panel.

Panel Build, Test, and Run operations, and XcodeBuildMCP build/test/build-and-run tools, add
`-allowProvisioningUpdates`. An authorized operation may therefore contact Apple and download or
update signing profiles. Discovery and unrelated tools do not receive the flag. Panel operation
products remain in Copse-owned per-operation scratch directories, with ownership, cancellation,
duration, and log bounds enforced. A host restart invalidates the panel operation authority epoch,
so a recovered task cannot launch a second Xcode process whose predecessor may still be alive.

The native `device_hub` tool also requires an enabled Apple Development plugin and an enrolled
local macOS project. Device discovery, screenshots, app launch, and simulator input request tool
approval by default because they access host devices outside the project sandbox. Explicit tool
permission overrides apply, but read-only mode and enrollment checks still fail closed. Showing a
simulator does not enable renderer control; discrete agent input is a separate approved call.

## ACP permission requests

`respondToPermission` in `src/main/services/acp/acp-agent-service.ts` answers an external
agent's `session/request_permission`. A request **runs a command** when either:

- its kind is `execute`, with the command in `rawInput.command` or, failing that, in the title; or
- it has no kind, or ACP's catch-all `other`, and carries a `rawInput.command` string or argv
  (`acpShellCommandText`). ACP makes `kind` optional, so an agent can omit it. A structured
  `command` object is a tool's argument, not a command line.

A request that runs a command goes through the shell gate (`ensureShellCommandPermitted`), like
native `run_shell`, after the bridged-tool check (Copse re-gates those calls when they run). Only
an `execute` request runs in the agent's own shell, so only it carries the agent's sandbox claim
into the gate. An unclassified request's `command` may be an MCP tool argument (a Redis or SQL
command) that runs outside that sandbox, so it is judged as unsandboxed and never auto-runs on the
sandbox. Its
answer is never remembered, and no stored grant answers it. Remembered grants are keyed by agent
and tool kind only. One remembered command approval would therefore approve every later command of
that kind, such as `rm -rf`, before the gate classified, sandboxed or confirmed it. The grant store
also ignores and prunes `execute` grants saved by earlier versions. An `execute` request with no
command text at all gets the generic prompt without a remember option.

A remembered `other` grant still covers `other` requests that carry no `rawInput.command`, such
as an MCP tool call. A title alone does not make an `other` request a command. For such a call the
title is a label, like an MCP tool name or "Delete everything", and treating it as a command line
would send every unclassified tool call through the shell classifier. So an agent that puts a
command only in the title of a kind-less request still gets the generic prompt, which an `other`
grant can answer. Kinds the agent did classify (`read`, `edit`, `search`, `fetch`, and so on) keep
their own handling even when their input has a `command` field.

Copse answers with the agent's `allow_always` option only for a remembered grant or a ticked
remember box. A one-shot approval, including every shell-gate approval, selects `allow_once`. An
agent that offers no `allow_once` gets `cancelled`, not `allow_always`, because the agent would
otherwise remember an answer the user gave once and stop asking Copse. Agent managed thread mode
shows the agent's own request without Copse's shell classifier or remembered grants. Only its
`allow_always` rule applies there: the dialog's box selects the agent's own option.

## ACP MCP mediation

The Codex ACP preset allows the macOS `com.apple.trustd.agent` service for TLS
certificate verification. Without it, allowlisted ChatGPT requests fail during
workspace-routing discovery. This is a per-process seatbelt permission, carried
through both model probes and session hosts; ordinary shell commands and other
agents do not inherit it. Filesystem restrictions and the destination allowlist
remain in place. The trust service can make its own network requests outside the
domain proxy, so this is an explicit, narrow exception to network isolation, not
a general default. Custom ACP sandbox overrides can select `allowMacOsTrustd`;
the flag has no effect on other operating systems.

Configured MCP servers are never handed directly to an external ACP agent. Direct forwarding lets
the agent call a server without a host callback, which would bypass Copse's hooks, read-only mode,
and per-tool permission policy. Copse instead advertises the connected server's registered
`mcp__...` tools through its authenticated native-tool HTTP bridge. Each call returns through
`ToolRegistry` and the normal permission gate before cache lookup or handler execution.

An ACP agent that does not advertise MCP-over-HTTP support cannot mount that bridge and receives no
configured MCP tools. This is deliberately fail-closed: ACP provides no per-call host enforcement
point for a stdio or HTTP MCP server the external agent mounts itself.

## ACP client terminals

An ACP agent that delegates a command through `terminal/create` (issue #623; see
[ACP agents](acp-agents.md#client-terminals)) gets no authority of its own: the
request becomes exactly one `run_shell` call through `ToolRegistry`, under the
owning turn's thread identity and execution context, as a bridged `run_shell`
call would. The permission gate, per-tool overrides, hooks, read-only mode, the
platform matrix above, Guarded YOLO, the expected-block and reactive
unsandboxed-retry prompts and the denial cache therefore apply unchanged, and the
command's text is what the gate judges and the prompt shows. `env` and `cwd` are
rendered into that text (`export` lines and a `cd` into a workspace
subdirectory); a `cwd` outside the execution root is refused, never run
elsewhere. A request that arrives with no turn bound is refused, as a bridged call
is. For a sandboxed agent the command shares the agent's network scope, as bridged
shell calls do.

Terminals are offered only alongside the native bridge for a local agent, never
to an agent on an SSH host or on Windows. Copse does not auto-approve an agent's
own `execute` permission request because terminals are advertised: the agent may
still use its private shell, which only the spawn-time seatbelt contains.
Implementation: `acp/acp-terminals.ts` (ACP side) and
`AcpNativeBridge.runShellCommand` (turn binding); per-call output and exit
reach the terminal through `runWithShellRunObserver` in
`exec/shell-output-context.ts`.

## SSH workspaces

On an SSH workspace (`docs/plans/ssh-remote-repo.md`) commands, git, search and files run on the
remote host, outside any local OS sandbox; Copse applies no sandbox on the remote host. The local
main process keeps every decision: the permission gate, approval dialogs, the diff queue and write
approvals run on the desktop whatever host the bytes land on. User-authored `ssh`/`scp`/`rsync`
stay hard-external; the SSH transport is injected below command routing, so classification still
reads the original command.

- **Integrated terminals** targeting SSH always ask first (“Open remote terminal?”), and the
  approval cannot be remembered. A shell Copse adds on its own (a new thread or worktree while the
  Shells pane is open, or the pane restored at launch) waits for a click or keypress before it
  spawns and asks, so the prompt only follows a user action. An explicit local console, such as the Usage panel’s sign-in
  action, runs at local home and follows the local terminal permission contract even while the
  active project targets SSH. Agent reauthentication still selects the agent’s host.
- **Remote ACP agents** (`acpOverSshEnabled`, off by default; [plan](plans/acp-over-ssh.md)) are
  treated as **unsandboxed** whenever the agent's working directory resolves to an SSH target,
  even when the local project sandbox is active. The Windows / sandbox-init-failure row of the
  platform matrix applies to them: read/search requests, Codex code-mode cells, ambiguous commands
  and opaque interpreter scripts prompt, deterministic auto-approval does not fire, and Claude
  presets keep their own prompting mode rather than `acceptEdits`. Such an agent is not offered
  Copse's loopback native-tool bridge or its token, so bridged-title auto-approval does not apply
  either. Configured agent `env` reaches the host only after a consent prompt, over stdin; a
  missing curated adapter is installed only after an approval that names the host and the pinned
  `package@version`. Remembered ACP tool-kind approvals are scoped to the configured SSH host;
  an approval on one host never authorizes the same agent on another. No host remembers an
  approval for a request that runs a command.
- **Native `run_shell`, `run_background` and todo-verification commands** use the actual
  execution target to determine containment. `commandRunsSandboxed` rejects a local sandbox
  claim when `spawnRunsOnSshTarget` resolves remote execution. The unsandboxed platform policy
  therefore applies even when the local sandbox is active: ordinary commands prompt, and
  deterministic shape auto-approval and sandbox replay leases do not apply. Explicit trusted
  commands and Guarded YOLO remain separate policies; neither confines the remote account.

> **Review:** this section records a security contract. A change to it needs sign-off from a
> named human security reviewer before merge.

## Shared Run app workflow

The titlebar/project-menu **Run app…** flow is available for detected local Apple and Android
projects independently of agent-plugin enrollment. Opening the picker authorizes loading the project
configuration (including Gradle configuration or Xcode metadata). Clicking Build, Test, or Run
authorizes the selected workflow and its project-controlled build scripts with normal host access.
The main process resolves the selected project/thread checkout and validates the discovered app,
variant, and device. It never receives arbitrary command lines from the renderer. This workflow does
not enable agent plugins or create remembered agent-tool permissions.

The shared Apple picker defaults signing-profile updates off. Its explicit per-run checkbox adds
`-allowProvisioningUpdates` only to that operation; the existing Apple plugin/MCP behavior described
above is preserved. Creating a device uses an installed runtime. Downloading an iOS runtime or an
Android system image is a separate labeled action. Android license agreements are not silently
accepted. External setup links open only the fixed Xcode/Android Studio destinations.

Operations have a duration bound and cancellable process trees. Logs are bounded; interrupted
operations are reported after restart and never replayed. A user-run local simulator/emulator opens
in Desktop with control enabled, scoped to the same project/thread. Agent-originated presentation
and remote desktops retain explicit view-only control. Closing Desktop leaves the device running;
Stop app targets only the app session launched by that workflow.

## Strict mode and expected blocks

Direct project executables (including `./node_modules/.bin/tsc`) and local scripts run
inside an active OS sandbox when auto-run is enabled. Opaque contents alone do not
establish that the sandbox would block execution. Other network/outside-path signals
and destructive-command checks still apply. Without containment or auto-run, approval
is required. Guarded YOLO's bounded script-content harm scan remains a separate check;
reading a script is not proof that it is safe or permission to escape containment.

`safetyExternalDenyThreshold` defaults to `1` (off). At a lower threshold, a command is hard-denied
only when both conditions hold:

1. the classifier is at least that confident the command is external; and
2. deterministic analysis reports a destructive signal in `dangerousInSandboxReasons`.

Strict mode never denies a merely external command. Without the destructive signal it is surfaced
for approval.

An agent may pass `expects_sandbox_block: true` to `run_shell` when an ambiguous command is expected
to need network or outside-workspace access. This only advances the same unsandboxed-retry prompt:

- a hard-external command already prompts and runs outside;
- a sandbox-contained command ignores the hint and must earn escalation through a verified block;
- declining the advanced prompt runs the command in the sandbox without prompting again on failure.

When the command is bounded opaque local execution — its only reasons are a project script or
executable, with no network, outside-path, destructive or install signal — the advanced prompt
also offers “Allow retries outside the sandbox (up to 10, for 2 hours)”. Ticking it leases that
exact command line, byte for byte, to the current human turn tree in this thread and execution
root, so an agent rerunning the same browser demo or harness after each fix is not asked again.
Any other command, a changed command, another turn tree or another thread asks again. The same
outside-sandbox lease, with the same bounds, is offered when a verified sandbox block escalates.
A block recognised only from command output, or a forced ask, never offers or spends it.

The prompt is titled “Agent requests sandbox escape” and describes this as the agent's
expectation, not a confirmed sandbox failure. A cached denial instead retains “Run outside
sandbox?” and states that a previous denial was recorded, without attributing a new request
to the agent. Approval authorizes one outside execution; rejection keeps the contained attempt.

Some sandboxed failures come from a broker or helper that does not increment the OS sandbox's
violation counter. After a non-zero attempt, `run_shell` may recognise the bounded denial signatures
for a Git network read, GitHub CLI config access, or a package install unable to download from inside the sandbox and offer the
same one-time unsandboxed retry. Command output is untrusted evidence: a signature can open that
approval prompt, but cannot approve the retry: neither Guarded YOLO nor the deterministic shell
auto-approval classifier may answer it. An unattended container may retry either kind inside the
same disposable guest because that does not escape to the host. Reactive elevation is only available
when the failed attempt actually ran inside the project sandbox; an attempt already routed or
approved outside is never repeated under a misleading second “outside the sandbox” retry.

A recognised denial is remembered in memory for that exact operation and thread only after its
escalation was approved; declining leaves no cache entry. A later matching operation can move the
same approval question before the sandboxed probe; it does not authorize the command, persist across
app restarts, or generalise from (for example) `git fetch` to `git push`. The operation is read from
the parsed command, after wrapper unwrapping, never from raw text: `grep -rn "git fetch" docs` or
`echo git push` runs no git and is never matched to a cached `git fetch`/`git push` denial. Because the cache originated
in forgeable command output, Guarded YOLO and deterministic shell auto-approval must still show that
question; only an unattended container may advance it without a person while staying inside the same
guest.

## Host-side read tools

`gh` through `run_shell` is an ambiguous “may reach” command: it starts in the network-less project
sandbox, fails, and then asks for an unsandboxed retry. `gh api graphql` and `gh api -f …` always
prompt via the harm gate, and the exact-operation denial cache means each differently-worded query
prompts again. `git fetch origin <branch>` fails in the sandbox the same way. Two registered tools
cover these reads without a prompt. Both are in `HOST_NETWORK_READ_TOOLS`
(`permission-policy.ts`): they auto-run, an explicit per-tool **Ask** still prompts and **Block**
still blocks. They are not in the read-only run allowlist, are excluded from unattended container
guests, and are bridged to ACP agents. Their read-only guarantee comes from Copse constructing the
request, not from a reduced credential; no new token is introduced.

**`gh_api_read`** is registered with the other `gh` read tools and hidden whenever `gh` is
unavailable or unauthenticated. It runs `gh` on the host without a shell, using the user's
existing `gh` login exactly as `gh_pr_view` does, so it can read **any repository, organisation or
user data that login can read**, not only the current project. The agent supplies an `endpoint` or
a `graphql` document, optional `variables`, `jq` and `paginate`; nothing else (the schema is
strict, so `method`, `headers`, `hostname` or flags are rejected).

- REST: Copse runs `gh api --method GET --include [--jq=…] -- <endpoint>`. The endpoint must be a
  relative API path with an optional query string: no scheme, host, `//`, leading `-`, `.`/`..`
  segments (also percent-encoded), whitespace, control characters, `\` or `#`, and not `graphql`.
- GraphQL: the document is parsed with the reference `graphql` package and must hold exactly one
  operation, of type `query`, plus any fragments. Mutations and subscriptions (named, anonymous or
  aliased), several operations, schema definitions and unparsable documents are refused before
  anything is sent. Copse sends `{query, variables}` as the request body on stdin
  (`gh api graphql --input -`), so variable values cannot become flags.
- `jq` is passed as one `--jq=` argument. `gh` evaluates it with gojq, whose `env`/`$ENV` expose
  the `gh` process environment (including a forwarded `GH_TOKEN`), so those and module
  `import`/`include` are refused.
- Output after `jq` is capped at `GH_API_READ_MAX_OUTPUT_BYTES` (256 KiB), truncated on a UTF-8
  boundary with a notice to narrow the query. `paginate` follows REST `Link: rel="next"` headers
  (keeping only the link's path, never its host) or the first GraphQL `pageInfo` (the query must
  declare `$endCursor`), and stops after 10 pages with a notice naming where to resume. The whole
  call has a 60 s budget.

**`git_fetch`** is a core tool, unavailable in SSH workspaces. The agent names branches on origin
and/or `refs/pull/<n>/head` (at most 20). Copse validates each as a plain branch name (no
refspec, `refs/` path, remote, URL, option, `..`, `@{`, `~^:?*[\`, whitespace or control
characters) and maps it to a fixed destination: `refs/heads/<b>` → `refs/remotes/origin/<b>`, and
`refs/pull/<n>/head` → `refs/remotes/origin/pr/<n>`. A branch that is literally named `pr/<n>` shares
that destination: a call naming both is refused, and separate calls overwrite each other. The fetch reuses the background default-branch fetch
([threat model](threat-model.md#background-default-branch-fetch)): only an `http(s)://`, `ssh://` or
`user@host:` `remote.origin.url` is accepted; the network step runs on the host in a fresh,
per-call Copse scratch repository that never reads the project's `.git/config`; and a sandboxed,
local-only fetch copies the tips into the project. Local branches, HEAD, the index and the working
tree never change. The result lists each destination ref with its SHA. Any other origin returns a
message pointing at `run_shell git fetch`.

`backgroundDefaultBranchFetch` (Settings → Permissions → Upstream updates) does **not** govern
`git_fetch`. That setting controls Copse's own unattended hourly/allocation fetches; `git_fetch` is
an agent-requested action, governed like any tool by its per-tool permission (set it to Ask or
Block to require approval or disable it).

## Read access outside the project

A command that only reads fully-accounted-for paths outside the project receives the narrower
“Allow read access outside of the project?” question. The prompt lists every requested path and
warns that a directory can contain sensitive files. Its primary action grants reads of those
specific paths for the remainder of the thread, in memory only: an approved file covers only that
file, while an approved directory covers its descendants. A later command that names any other
outside path asks again. A descendant is covered only when every segment of its path is literal:
a token the shell would expand (braces, `*`/`?`/`[` globs, `$`, backticks, quotes, backslashes,
`~` past the start, extglob parentheses) asks again, because `dir/{..,sub}/x` sits under `dir` as
text but reads `dir/../x`. Repeating the exact approved token is still covered.

Coverage and the credential checks are decided on the path text and do not resolve symlinks, so a
symlink inside an approved directory reaches whatever it points to. The approved root itself is
identity-pinned while it exists: replacing a granted file or directory, or retargeting a granted
symlink, revokes that grant and asks again. The sandbox does not close the nested-symlink case:
`readAllowedSandboxOverlay` canonicalizes each target with `realpath` before widening `allowRead`,
so it widens to the link's destination. Without an OS sandbox the command reads it on the host. An
expanded “Approve this command” action approves one invocation without a grant.

Reads under macOS's per-user temp directory (`getconf DARWIN_USER_TEMP_DIR`, `/var/folders/…/T`)
skip the question: the seatbelt already lets every command read there, so the gate records a
`user-temp-read` decision and allows the command. A leading `NAME=/literal/path;` assignment is
folded into later `$NAME` references before analysis (shell-behaviour variables such as `PATH` are
never folded), and a `<` input redirect counts as a read of its target, so `tr … < "$L"` is
classified by the file it opens.

The grant authorizes no command by itself. `read-outside-project.ts` re-analyzes every later command
and must prove it is a plain read through a fail-closed allow-list. An unknown command head, write
flag, redirect, environment variable, or privilege wrapper falls back to the ordinary prompt; the
whole wrapper chain counts, so `nohup env …` is refused like `env …`. Another user's home
(`~name/…`) and `~+`/`~-` are never resolved into a grant target.
Shell-builtin assignment forms such as `printf -v` also fall back: they can change `PATH` and
replace a later reader without containing a leading `NAME=value` token.
Credential targets (`.env*`, `*.pem`, `~/.ssh`, `~/.aws`, `.netrc`, `.config/gh`, and similar) and
paths as broad as `~` or `/` are never eligible.
The Copse LAN certificate and device directory (`<COPSE_DIR>/lan`, normally
`~/.copse/lan`) and its ancestors are also ineligible for a standing read
grant; a directory read of the whole profile must not sweep in its CA key.

The proof follows a `cd` to an absolute or home-relative directory when it runs in sequence (`&&`
or `;`), not in a pipeline, subshell, background job, or after `||`. Later relative operands
resolve against that directory; every operand after it is treated as a path, so
`cd ~/other && cat .env` meets the credential rules; a command with no operand, and any `git`
command, reads the directory itself. `cd` alone, `cd -`, and relative targets stay ineligible. A
`sed` is a read only in the filter shape the read tier already admits (no `-i`, no `-f`, no
`r`/`w`/`e` command), and its script is not a path. The Guarded YOLO harm gate carries the same
`cd` forward, so `cd ~/.ssh && cat id_rsa` is refused like `cat ~/.ssh/id_rsa`.

This applies on every platform. Off macOS/Linux there is no seatbelt/bubblewrap to leave, but the
access is still outside the project and requires the same narrowly reasoned permission.

The in-memory grant disappears on restart. The decision record does not: an answer appends a
`decision` spine event at `scope: external-read`, including the paths and whether the grant was
remembered. Each later allowed command records a verdict sourced to `read-outside-grant`.

## Native commits and signing

`git_commit` runs fixed add/commit argv, preserving hooks and signing. Local commands
stay inside the available project sandbox even when `git` has a remembered shell
bypass. Without containment, each commit prompts before staging. Auto-run disabled
also prompts. An unsuccessful helper never triggers an unsigned or unsandboxed retry.

On macOS, Settings → Permissions → Commit signing has an **Allow signed commits**
toggle, on by default. After a trusted sandboxed socket probe receives an OS
permission denial, Copse uses the system SSH signer, one configured public key and
the exact agent socket, without asking. The grant for that project and identity is
cached until app restart; a changed config, key, signer binary or socket re-runs the
probe and re-grants, still without asking. Setting the git_commit tool to Always ask
in Tool Permissions forces a fresh approval for every signing helper use instead, and
never remembers it. Turning the setting off blocks further brokered ssh-agent
signing. Config supplied by the repository never grants authority on its own.

The socket is available only to a separately sandboxed `/usr/bin/ssh-keygen`, with
fixed arguments selecting that public key and the `git` signing namespace. Git and
its hooks receive a single-use commit-signing endpoint; they cannot talk to ssh-agent
directly. On this ssh-agent path, the configured private key remains unreadable. The helper and key are
pinned through command-line config, so changing Git config during approval cannot
replace the approved executable. The broker accepts bounded commit objects, not
commands or arbitrary SSH authentication requests.

With the ssh-agent setting off, a configured SSH key file has a separate one-commit
consent path on macOS. Before staging or running hooks, the approval names the commit,
resolved private-key path, system signer and project. Copse reads no private-key
contents until approval. This approval is never remembered: only the isolated system
signer gains read access to the exact file. Git, hooks and the agent receive no key
access. File identity is checked across approval and before and after each signer
invocation. No private-key copy is written. A missing `.pub` file does not prevent signing. Passphrase-protected
keys require the existing ssh-agent path; Copse does not collect their passphrases.
Rejecting or failing never triggers an unsigned or unsandboxed retry.

This is the commit step of a PR workflow. The Create PR dialog pushes already committed
changes; it does not commit, read signing keys or grant future signing access. PR
publication retains its own approval. Turning off the ssh-agent setting revokes socket
grants and still permits a fresh, explicit one-commit private-key approval.

The setting supports the default/system SSH signer. Custom signing programs and
other configured helpers keep ordinary project sandbox access. Linux does not get a
socket grant because its backend cannot restrict Unix sockets by path; Windows has
no project sandbox. No global socket/network allowlist is widened. The existing
pinned ASRT patch provides per-spawn macOS socket permissions for these isolated
processes. See [the threat model](threat-model.md#scoped-ssh-signing) for exact limits.

## What an approval prompt says

Prompt prose explains the effect, execution boundary, and duration of the grant outside the
detail box. The box holds the complete command, arguments, or variable URL. Web-fetch,
browser-navigation, and provider-host prompts put only the requested URL there; the surrounding
copy names the origin/host and whether approval covers one request, the chat's browser session,
or a persistent Settings grant. Provider-host approval always persists, so its action is labeled
“Always allow host”. Browser origin grants cover the chat's browser session even without remembering.

Static sandbox escapes, agent-expected escapes, and retries after a sandbox failure all warn
that execution uses the user's access to files and the network beyond the project sandbox.
Commands with no available sandbox say so even when the immediate reason is that auto-run is off.
Contained prompts still warn that project files can change. The execution policy is unchanged.

GitHub write tools explain their specific remote effect. PR creation exposes the repository,
title, head, base, draft status, and body. A single literal `gh pr create` invocation with known
flags and explicit title/body gets the same publication explanation alongside the full command.
Unknown flags, shell expansions, scripts, and compound commands retain the general reasons.
These explanations are presentation only and never authorize or reroute a command.

Remembered tool approvals cover the exact tool with other arguments; schedule grants cover
future runs of the named schedule. The outside-project read grant still covers all eligible
outside-project reads for the chat, not only the paths currently displayed. Its primary action
is labeled “Allow reads for this chat”; the secondary action approves just the displayed command.
Batch and Activity views use the same advice, complete details, and footer as individual prompts.

Classifier reasons are **identifiers, not copy**. The regex pass and the token pass share them
verbatim so the two dedupe against each other, and every answered prompt writes them into the
decision spine, so they must stay stable — which is why they read like rules
(`inline script (interpreter -c/-e/--eval)`) rather than like something a user can act on.

`shell-scope.ts` therefore keeps a second table, `SCOPE_REASON_TEXT`, holding one plain-English
sentence per reason, and `describeShellScopeReasons` resolves a reason list into sentences at the
moment a prompt is built. The shell prompt formatters in `permission-policy.ts` render those as a
bullet per line; the Guarded YOLO harm prompt resolves the same sentences but keeps its existing
one-paragraph `Potential harm: …` shape, because it is capped by length rather than by line. Logs,
hooks and the decision spine keep the identifiers.

Two properties this contract depends on:

- **Every rule has copy.** `ScopeReason` is derived from the keys of `SCOPE_REASON_TEXT` and
  annotates the pattern tables, the shared reason constants, and the accumulators both classifier
  passes push through, so a new classifier rule whose reason has no sentence fails to typecheck.
  The one deliberate exception is the runtime-built `absolute path outside workspace: …`, which
  bakes in an operand and so is matched by prefix instead; anything still unrecognised is shown
  verbatim rather than dropped.
- **One concern, one line.** Deduping happens on the resolved sentence, so rules that describe the
  same underlying fact collapse — a heredoc, a `-c` body and an `eval` are all "runs code written
  or built inside the command itself" (so `node --eval`, which trips two rules, reads as one line),
  and `~/` and `$HOME` are both "in your home directory". The Guarded YOLO harm prompt dedupes the
  same way but joins the result into its one paragraph rather than one bullet per line.

Prompts that offer a sandbox escape name no platform: they appear only while a project sandbox is
active, which is seatbelt on macOS and bubblewrap on Linux. `permission-policy.ts` owns the
up-front prompts and `sandbox-failure.ts` the after-a-block retry; the `expects_sandbox_block`
wording stays an expectation, per the section above.

## Worktree preparation capability

Every project can use `preflight_worktree` and `prepare_worktree`. Preflight detects npm, pnpm,
Yarn Classic/modern, and Bun from an exact package-manager declaration or an unambiguous lockfile.
Python projects use locked uv workspace synchronization (`pyproject.toml` + `uv.lock`) or
wheel-only pip installation when every root requirement is exact and SHA-256-hashed. uv package
builds may execute repository code, which approval states; automatic pip source builds and global
Python/tool installation are disabled.
It reports runtime requirements, dependency state, declared checks, configuration problems, exact
setup commands, and a plan fingerprint. The optional `directory` selects a nested project inside
the execution root. There is no repository-name check or implicit Electron/native requirement.

Other ecosystems and optional native setup use `.copse/worktree-preparation.json` to declare argv
commands, fingerprint inputs, and read-only checks. Unknown projects receive configuration guidance.
See [the project preparation plan](plans/project-worktree-preparation.md) for the schema and examples.
Copse's own native setup uses that same declaration. Readiness covers dependencies and declared
checks; it does not claim that builds or tests pass.

Preparation always asks once, displaying the selected project, exact package install, every declared
setup command, and its network/write scope. Project-defined setup is labelled executable repository
code. The fingerprint from preflight is required in the tool call and is checked before approval and
again before each step; changed inputs require a new approval. Grants cannot be remembered or reused
for arbitrary commands. Automatic JavaScript installs use frozen lockfiles, the package firewall, and
manager-specific lifecycle disabling. Custom steps retain their explicitly approved semantics.

Both tools require an enforcing OS sandbox and have no unsandboxed fallback. Preflight probes and
checks run with network blocked and the project/shared caches read-only. Each probe can write only
private disposable scratch, removed after execution, for manager bookkeeping. Preparation writes only the selected project and fixed
managed cache directories under `~/.copse/cache/` (`COPSE_DIR` relocates them), including Corepack,
npm, pnpm, Yarn, Bun, uv, package-firewall advisory feeds, and native build caches. Toolchains are read-only; native setup
uses a managed build home. No declaration may request broader filesystem grants. Temporary files
stay in the project; redirected cache roots and outside-worktree metadata inputs are rejected.
Root Git/editor configuration remains protected, while dependency metadata can be extracted.

Later project-sandbox shell commands receive read-only cache access and matching package-manager
cache variables without changing their install policy. Offline preparation blocks network for every
subprocess using kernel isolation with no proxy ports or sockets; other agents' network grants
cannot widen this boundary. Missing runtime versions or offline inputs fail with remediation.
Runtime installation/version switching and Windows sandbox support remain separate capabilities.

## Guarded YOLO

Guarded YOLO is a session-only, thread-scoped mode armed from the composer footer. It becomes
active at the next run start and stays active until disabled or the app restarts. It does not
disable the OS sandbox.

While active:

- Routine shell commands skip ordinary scope prompts, subject to the host-owned harm gate in
  `shell-harm.ts` (`allow` / one-time `prompt` / hard `deny`). Safety confirmations in Guarded
  YOLO deny after two minutes without an answer and dismiss the prompt, returning a rewrite
  hint so unattended work can continue. Dangerous-command confirmations (including flagged
  recursive `rm`) in ordinary auto-run use the same deadline. Standard-mode prompts with
  auto-run disabled or an explicit Always ask policy keep their existing indefinite wait;
  hard denials remain immediate.
- The thread is treated as holding the outside-project read grant above. Eligible plain reads of
  non-credential paths auto-run; on macOS/Linux they stay contained with a widened `allowRead`
  seatbelt rather than a full sandbox escape. Credential targets and paths as broad as `~` or `/`
  remain hard-denied by the harm gate.
- Writing or opaque GitHub CLI forms (`gh pr create`, `gh api -X POST`, `gh api -f …`,
  `gh api graphql`, …) prompt via the harm gate. Agents should use `gh_api_read` and `git_fetch`
  ([Host-side read tools](#host-side-read-tools)) for GitHub reads and branch fetches instead. A `gh api` call is a read only as a plain GET:
  one REST endpoint (no full URL), no method other than `GET`, no field, `--input`, header or
  `--hostname` flag.
  `gh run download` may run inside the project sandbox, which contains its local writes.
  It does not receive a classifier read grant: running or retrying it outside the sandbox
  requires approval, even when the session has an active sandbox. Dedicated mutating GitHub tools
  (`GITHUB_WRITE_TOOLS`) still prompt unless the owning automation has the exact project-scoped grant
  described below. Read-only `gh` carve-outs keep the normal sandboxed path.
- Direct execution of a workspace file the gate cannot read as text prompts, except a compiled
  executable (ELF, Mach-O, PE header) inside the workspace: it has no text to inspect, and running
  it is no riskier than the `cargo run` or `make` that built it. The workspace's own pnpm shims
  are a second exception: a file directly in `<workspace>/node_modules/.bin` that consists only of
  pnpm's shim template, and runs only files under `<workspace>/node_modules`, runs like the
  `npx <name>` that resolves to it. Any other line, or a target outside `node_modules`, and the
  file is read as the script it is. Targets are followed through links, so a workspace package
  that pnpm links to its source in the repository is read, not trusted. A word starting with `#`
  in command position is a comment, not a script to inspect.
- Script and inline code is read as code, not shell: a `${…}` template literal is not an
  expansion. Deletion calls (`rm(…)` from `fs`/`fs/promises`, `rmSync`, `unlink`, `rmtree`, …)
  deny on a catastrophic literal target and otherwise prompt, so a script that recursively
  deletes a computed path, such as `scripts/run-tests.mts` clearing its output directory, asks.
- Commands that reach past this machine's project without deleting anything ask once
  (`host-reach.ts`):
  - `ssh`, `scp`, `sftp`, `mosh`, and remote `rsync` to a host not listed under Settings →
    Permissions → Trusted SSH hosts (empty by default; every `-J`/`ProxyJump` host and any
    command-line `Hostname` override must be listed too). A trusted host still asks when the client
    would load or run local code (`-o ProxyCommand`, provider/helper options, `-F`,
    `scp`/`sftp -S`, `mosh --ssh`/`--client`, or `rsync -e`/`--rsh`), forwards a local capability
    (`-A`, `-K`, `-X`, `-Y`, or their `-o` forms), opens a forwarding or tunnel (`-L`, `-R`, `-D`,
    `-W`, `-w`, `-O forward`/`proxy`, or the equivalent `-o` options), forwards a secret-looking
    variable with `SendEnv`/`SetEnv`, weakens host authentication, selects a local control socket,
    or activates command-line hostname canonicalization. Remote commands (including
    `RemoteCommand`, `mosh --server`, and `rsync --rsync-path`) still receive the destructive-pattern
    check. Each client has its own option grammar, and clustered OpenSSH options such as `-fL…` and
    `-vJ…` receive the same checks. Trusting a host otherwise hands it commands as if it were this
    machine, including reads of its secrets. An SSH-family command under `xargs` always asks because
    stdin can append an uninspected destination or remote command.
  - printing the environment (`env`, `printenv`, `export -p`, `declare -x`, bare `set`), a
    secret-named variable (`printenv GITHUB_TOKEN`), `gh auth token`, or a keychain password, and
    any network command (`curl`, `wget`, …) whose line references a secret-named variable;
  - `launchctl`, `systemctl`, `crontab`, and `defaults` writes, `screencapture`, `osascript`, and
    every `pkill`/`killall` (a pattern cannot be scoped to the agent's own processes, so even
    `pkill -f "node scripts/watch"` can stop the user's watcher; `kill` by PID or job runs);
  - `npx`/`npm exec` of anything but a binary installed in the workspace's `node_modules/.bin`,
    package-manager initializer commands (`npm create`/named `npm init`, `pnpm create`,
    `yarn create`, `bun create`), and `pnpm dlx`, `yarn dlx`, `bunx`, `uvx`, and `pipx run`,
    which download code before running it;
  - running anything as another user (`sudo`, `doas`, `pkexec`, `su`), wherever it sits in the
    line (`… | sudo sh`);
  - running code a substitution downloads (`eval "$(curl …)"`, `bash <(curl …)`), inline or
    heredoc code that downloads and runs code or posts data (`python3 -c "exec(urlopen(…))"`,
    `perl - <<EOF` with an HTTP POST), and running or `chmod +x` on a file the same command
    downloaded;
  - a temporary directory on `PATH` (`export PATH=/tmp/x:$PATH`);
  - a secret file inside the workspace (`.env*` except templates such as `.env.example`, `*.pem`,
    `*.key`, `id_rsa`, `.npmrc`, …) read, searched, encoded or sent by a program that shows its
    contents, and CLIs whose output is a secret (`gh auth status --show-token`,
    `gcloud auth print-access-token`, `aws configure get`, `npm token`, `kubectl get secret`,
    `helm get values`, `security dump-keychain`, `git credential fill`, a `credential.helper`
    change);
  - any command other than the store's own client that names a credential store (`~/.ssh`,
    `~/.aws`, `~/.config/gh`, `~/Library/Keychains`, shell history files, …), such as
    `tar -czf - ~/.ssh` or `cp ~/.ssh/id_rsa /tmp/k`;
  - publishing (`npm`/`cargo`/`gem`/`twine` publish, `docker push`), deploying and changing
    infrastructure (`kubectl`, `helm`, `terraform`, `pulumi`, `vercel`, `netlify`, `fly`,
    `firebase`, `heroku`, `wrangler`, whose read subcommands are an allow-list), cloud writes
    (`aws`/`gcloud`/`az`/`doctl` verbs that create, delete, deploy or change IAM), Stripe calls
    other than reads, and SQL or Mongo statements that drop, delete, truncate, alter or grant;
  - containers with host access (`--privileged`, `--pid=host`, mounting `/`, `/etc`, home or the
    Docker socket), stopping or removing containers, and the payload of `docker exec` or
    `kubectl exec`, which is inspected as a command;
  - installing from a registry other than the default (`GOPROXY`, `GOSUMDB=off`,
    `--registry`, `--index-url`, …), unless every registry the command selects is listed under
    Settings → Permissions → Trusted package registries (empty by default). Trust is by origin
    and covers only settings that choose a registry; ones that switch off checksum or TLS checks
    (`--trusted-host`, `GOSUMDB=off`, `GOINSECURE`, `GOFLAGS=-insecure`), Go's `direct`, and
    `GOPROXY=off` still ask;
  - any infrastructure, remote-shell or database program (`kubectl`, `helm`, `terraform`, cloud
    CLIs, `ssh`, `psql`, …) that names a cluster context, namespace, cloud project or profile, or
    host listed under Settings → Permissions → Production targets (empty by default), reads
    included. Matching is on whole words the command passes (`--context=prod-eu`,
    `deploy@db.prod.example`, a URL's host), never substrings. The list can only add prompts;
  - sending a request body or upload to a host other than loopback (`curl -d`, `-T`, `-X POST`,
    `wget --post-file`), opening a listener or relay (`nc -l`, `nc -e`, `socat`), and mail;
  - test and load runners pointed at a non-loopback URL (`pytest --base-url https://…`,
    `artillery run --target …`), `act -W` with a workflow URL, bulk database loaders (`pgloader`,
    `pg_restore` into a database, `mongorestore`, `mongoimport`, `mysqlimport`, `redis-cli --pipe`),
    `influx` verbs that write or delete (`write`, `delete`, `restore`, …) and SQL run
    from a file or stdin (`psql -f`, `mysql db < dump.sql`, `cat dump.sql | psql db`);
  - filtering shell history for a secret-named word (`history | grep -i token`);
  - `find` deletions rooted outside the workspace (`find /x -exec rm {} +`,
    `find /x | xargs rm`), and `git filter-repo`.
- Credential reads stay hard-denied when a redirect such as `2>&1` follows them and when the gate
  has no workspace root. A shell's first operand (`bash ./payload`) is inspected whatever its
  name. A program run by absolute path is an installed program when it lives under a system root
  (`/usr`, `/bin`, `/opt`, `/System`, …) or a home toolchain directory (`~/.cargo/bin`,
  `~/.local/bin`, nvm, Volta, mise, asdf, pyenv, Xcode's DerivedData, …). Anywhere else a script's
  text is assessed and an unreadable or missing program prompts. Only a word the shell parse puts in
  command position counts: a path the fallback lexer cuts out of quoted text (`sed "s|/etc/x|y|"`)
  or one glued to a substitution (`$(…)/Platforms`) is not executed. A program in command position
  is inspected however its path is spelled (`$HOME/x.sh`, `"$HOME/x.sh"`, `'/abs/x.sh'`); a spelling
  the gate cannot match to the parse is inspected rather than skipped. Anything run from a temporary
  directory (`/tmp`, `/var/folders`, …) is inspected or prompts, and so is the program an
  `rg --pre` or `tar --to-command` flag names.
- Other network / outside-workspace commands may still auto-run unsandboxed when the harm gate
  allows them. When a classifier connection is chosen under Settings → Classifiers → Safety
  screening, such a command first gets its second opinion (`tier-screening.ts`). A P(`ask`) of at
  least 0.5 turns the allow into the harm gate's one-time confirmation. The classifier can only add
  a prompt: a missing, slow or failing connection leaves the harm gate's allow standing. A command
  that stays inside the project sandbox is not asked. Every confirmation ends "Approve this command
  once?", because an ask-once prompt need not be destructive.
- A shell builtin that assigns variables for later commands (currently `printf -v`) requires the
  one-time harm confirmation; changing `PATH` can otherwise replace the command being authorized.

Host shutdown/reboot hard denials require a parsed command invocation, including wrappers and
nested shell payloads. Filenames, ordinary arguments, quoted text, and shell comments are not
invocations. A shutdown-related text match in arbitrary interpreter source is uncertain and uses
the existing one-time harm confirmation; literal child-process shell payloads are still inspected
and can be hard-denied. The confirmation shows the exact command, the uncertainty, and whether it
will run inside or outside the project sandbox. Approval applies only to that invocation and cannot
be remembered; declining prevents execution. It does not override a confirmed hard denial.

A `PATH=` or `export PATH=` value is not an outside path either. It names directories to search
and opens none of them, and a program found through it still runs inside the sandbox, so
`export PATH="$HOME/.cargo/bin:$PATH"; …` no longer forces a contained command outside.
Auto-approval, which runs commands outside the sandbox, still refuses the assignment.

Text that names no file is not a path. The pattern of a `grep`/`rg` search and the operands of an
`echo`/`printf` whose output is not piped onward are masked before the outside-path rules run, so
`grep -v "//"` is not a read of the filesystem root and `echo "/tmp/x"` does not leave the
workspace. Recognition is an allow-list (`inert-operands.ts`): one unknown search flag, any
substitution, or a head that turns text into commands or paths (`xargs`, a shell, an interpreter)
disables it, and a masked path that appears in any other word stays visible. A `sed` script is
masked only when the whole `sed` is a read-only filter (no `-i`, script file, or `r`/`w`/`e`
command), so `sed -n '/^\/api\//p' a.ts` reads `a.ts`; an escaped path is kept when any other word
holds it with or without its escapes. `awk` scripts are not masked: they can read and write files.
A `../` in a pattern (`rg "from '../lib'" src`) is text only when no other word holds `..` and the
command has no `$` expansion, so `rg '../x' ../other` still leaves the workspace. A program name in
a pattern (`rg 'close|open' src`) is not that program running: it is ambiguous and runs contained.

`~/…` and `$HOME/…` (either spelling) that resolve inside the workspace are the workspace. `$HOME`
is trusted only when nothing else in the command mentions `HOME`, so `HOME=/ …` and `unset HOME`
keep it an expansion that prompts.

A pipe into an interpreter prompts, except into a `python`/`node` program given inline as the first
argument (`python3 -c …`, `node -e …`) whose source has no execution, dynamic-import, or file-write
primitive: that program reads the pipe as data.

Interpreter inspection recognizes Node's `.mts` and `.cts` launchers as well as `.mjs`, so a later
configuration-file argument cannot accidentally be inspected in place of the launcher.

Update this document and the Guarded YOLO / harm / read-outside tests with any intentional change.

## Environment setup

Environment setup ([plan](plans/environment-setup.md)) reviews the prompts a person answered in the
active project and suggests values for settings this contract already defines: the shell
auto-approval level, trusted commands, web origins, trusted SSH hosts and trusted package
registries. It changes no rule. An applied suggestion has exactly the effect of the same value
typed into Settings → Permissions.

- **Evidence is the user's own answers.** Main reads the decision log's `user` and
  `mobile-device` verdicts from the last 30 days and joins each shell decision to its `run_shell`
  or `run_background` call (durable shell decisions omit the command). Classifier, hook and system
  verdicts, timeouts and repository content are never evidence.
- **Every suggestion is a counterfactual.** The deterministic rule that raised each prompt runs
  again with the candidate value added (`assessAutoApproval`, `resolveCommandRouting`,
  `assessShellHarm`); a candidate is kept only when it would have removed the prompt. A command
  auto-approval recognises as a shape never counts toward trusting its binary, so `git push` can
  suggest a tier but never trusting `git`. A candidate needs 3 approvals from at least 2 threads,
  and any refused prompt it would also have removed marks it declined.
- **Main owns the values.** A review is issued under an opaque id; the renderer sends back only the
  ticked suggestion ids. Trusted commands, SSH hosts and package registries never start ticked.
- **Scope.** Offered only in a trusted workspace with auto-run on, at most every 14 days, and never
  to an agent: there is no tool for it, so read-only runs, automations, unattended containers, ACP
  agents and paired clients cannot open or apply it. The auto-approval suggestion is left out where
  the sandbox is inactive.
- **Record and undo.** Each applied or undone value is appended to
  `user-data/environment-setup.jsonl`. Undo, offered until the app restarts, removes exactly the
  values one apply added and restores a raised level only if nobody has changed it since.

## Automation-scoped tool grants

Automation schedules default to no extra approvals. A user may opt one schedule into exact MCP
tool names and a fixed catalogue of mutating Copse GitHub actions. These grants are stored with the
schedule, never as ambient thread or application trust, and the gate resolves them only from the
latest thread that main recorded as created by that schedule. Renderer-visible thread metadata is
only a claim: the gate corroborates its schedule, thread id, and trigger time against the
main-owned schedule run record before using a grant. Read-only mode and tool-gate hooks still run
first. A global **Blocked** policy rejects before the schedule grant, and **Always ask** forces a
fresh prompt without offering to remember the answer back to the schedule.

Copse GitHub grants cover the current project repository only. Passing an explicit `owner` or
`repo` keeps the normal per-call prompt. Shell commands, file changes, web/browser origins,
sensitive-data reveals, ACP agent permission kinds, and model-spend approvals are deliberately not
eligible. An eligible prompt raised inside an automation offers to add that exact action or MCP
tool to the owning schedule; ordinary threads retain their existing global MCP “always allow”
behavior.

The first turn of a verified schedule-created thread runs in deferral mode. A
prompt without a schedule grant records a pending request and returns a
non-execution error to the agent instead of waiting at a modal. The result
includes a request id; `deferred_approval_status` reads only requests owned by
the current thread. Later user turns use ordinary interactive approval.
Resolving a queued request records the human decision; it does not prove that
the original action ran.

PR maintenance also offers separate grants for `git_push`, `gh_pr_merge`, `gh_pr_comment`,
and `gh_pr_resolve_review_thread`. Push publishes one branch to origin and only replaces
rewritten history with an explicit full remote SHA lease, and refuses unsigned commits when
the checkout sets `commit.gpgsign`. Merge uses the repository's merge strategy and requires an
expected head SHA; it refuses drafts, outstanding change requests, and PRs without an approving
review of that head commit, and never requests administrator bypass.
Review-thread resolution checks the thread's repository and PR before mutation. The three
PR maintenance actions require the host GitHub CLI. These grants do not authorize shell
scripts, general network access, or tool calls from unrelated threads.

## Implementation map

Sandboxed native commands and ACP processes redirect `TMPDIR`, `TMP`, `TEMP`, and zsh's
`TMPPREFIX` into the existing workspace scratch directory. zsh uses `TMPPREFIX` for large
heredocs independently of `TMPDIR`; leaving its default `/tmp/zsh` breaks patch commands even
when every destination file is inside the workspace. This redirect does not widen the sandbox's
writable roots or change the approval policy. When `COPSE_DIR` is reached through a symlink,
Copse canonicalizes the scratch directory before setting `$TMPDIR`; macOS seatbelt otherwise
rejects traversal through the home-directory link before its target allow can apply.

On macOS the project seatbelt also allows writes to direct children of the per-user Darwin temp
directory returned by `getconf DARWIN_USER_TEMP_DIR` (typically `/var/folders/…/T`). Apple
converters such as `sips` ignore `$TMPDIR` and stage files there. The shallow `T/*` grant keeps
SVG→PNG (and similar) contained without making nested workspaces, all of `/var/folders`, or `/tmp`
writable. Linux and Windows are unchanged.

The project sandbox denies reads of the home directory and re-allows only what contained commands
need to run: the workspace, the user's git config, the chat store, Copse's own caches, the Node
toolchain found on `PATH`, and the rustup toolchain (`$CARGO_HOME/bin`, `$RUSTUP_HOME/toolchains`,
and `$RUSTUP_HOME/settings.toml`). The rest of `$CARGO_HOME` stays denied: `credentials.toml` and
`config.toml` can hold registry tokens, and the registry and git caches are downloaded sources, not
a toolchain. So `cargo --version`, `rustc`, and `rustfmt` run contained, while a build that needs
the registry still fails contained and offers to run outside.

- `permission-policy.ts`: pure permission decisions, MCP decisions, outside-sandbox classification,
  and prompt-body formatting.
- `@copse/shell-guard` (`packages/shell-guard/`): the deterministic classifiers, host-free.
  `shell-argv.ts` (lexing, wrapper unwrapping, read-only tables), `shell-scope.ts` (static
  `sandbox` / `ambiguous` / `external` analysis and human-readable reasons), `shell-harm.ts`
  (the Guarded YOLO harm gate), `read-outside-project.ts` (read-shape proof and refusals),
  `gh-argv.ts` (GitHub CLI shapes), `command-routing.ts` (trusted-command routing). The
  `src/main/services/security/` files of the same names re-export them and bind the two facts
  only the app knows through `shell-guard-environment.ts`: the read-only chat-store mount and
  the scratch directories configured ACP agents declare. Docker run/pull/push and Apple
  container run/image pull/image push are hard-external; read-only list/inspect/status commands
  remain sandbox-scoped.
- `github/gh-api-read.ts` and `git-fetch-origin.ts`: validation and argv construction for the
  host-side read tools `gh_api_read` and `git_fetch`; `default-branch-fetch.ts` owns the shared
  host scratch-repository fetch.
- `read-outside-grant.ts`: the thread-scoped read grant; the approval-prompt copy for it stays in
  `read-outside-project.ts` beside the other prompt formatters.
- `safety-classifier.ts`: optional model classifier used only when the OS sandbox is unavailable.
  It asks the Instruct / safety model, or the classifier connection chosen under Settings →
  Classifiers → Safety screening (`safety-classifier-profile.ts`). Both produce the same
  `ClassificationResult`; a connection's verdict is read from its probabilities (ties read as
  external), and any failure yields no verdict. Terminal-read screening (`terminal-read-guard.ts`)
  uses the same choice; through a connection it shares without asking only at P(safe) ≥ 0.80.
- `auto-approval.ts` / `auto-approval-config.ts`: deterministic shape allow-list; honoured only
  while the project sandbox is active, auto-run is on, and the workspace is trusted. Write tiers
  are additionally capped at `read` if a caller reaches the level helper without a sandbox. A
  segment that names a secret file (`secrets.ts`) is never approved, even inside the workspace,
  and `gh auth status --show-token` is not the `gh auth status` read.
- `environment-suggestions.ts` (pure counterfactual builder), `environment-evidence.ts` (decision
  log and tool-call join) and `environment-setup.ts` (offer, review, apply, undo): environment
  setup, above. `trusted-package-registries.ts` and `production-targets.ts` in `@copse/shell-guard`
  hold the two Guarded YOLO lists the harm gate reads through `host-reach.ts`.
- `tier-screening.ts`: the classifier second opinion. In Guarded YOLO it may add the confirmation
  above. In standard mode it only records a `tier-shadow` decision, in the background, for each
  shell prompt: what a local-write blend (deterministic tiers, or P(`read`/`local-write`) ≥ 0.95
  with a harm-gate allow) would have approved. The shadow record keeps a SHA-256 of the command,
  not its text. It is evidence for a later decision, and it approves nothing.
- `host-reach.ts`, `secrets.ts`, `remote-change.ts`: the Guarded YOLO ask-once rules above. The
  public command test set (`benchmarks/escalation-review/testset/`) pins every deterministic
  verdict on 782 labelled commands; `gates.mjs --check` fails on any change until the snapshot is
  reviewed and updated.
- `automations/automation-service.ts`: exact schedule-owned Copse/MCP grants, the selectable
  permission catalogue, and corroboration of renderer-visible provenance against the schedule's
  main-owned latest-run record.
- `project-sandbox/`: ASRT on macOS and bubblewrap on Linux. `isProjectSandboxEnabled()` is false
  on Windows and after init failure. Copse's own subprocesses that only read the checkout (Git
  reads, including the worktree manager's `show`/`for-each-ref` probes, the file-index listing,
  fs-gateway reads) use `readOnlyWorkspaceSandboxOverlay` or the read-only fs-server overlay: the
  same read confinement with no write rules. On Linux, a writable overlay makes bubblewrap create
  empty host placeholders for missing mandatory write-deny paths (`.bashrc`, `.gitconfig`,
  `.vscode`, ...), and ASRT removes them only once no sandbox is active, so `git status` and the
  Changes pane would list them as untracked files. Every wrapped command therefore releases its
  ASRT lease exactly once when its process exits, including after a timeout.

`permission-platform.test.ts` pins the platform matrix; `permission-gate.test.ts` and
`auto-approval-config.test.ts` pin gate wiring, the sandbox auto-approval gate, and MCP decisions.
`shell-gate-replay.test.ts` replays the public command test set through the real gate under each
platform situation and pins every outcome (`benchmarks/escalation-review/testset/gate-replay.jsonl`).
Update this document and those tests with any intentional contract change.

### Approved host artifact reads

Approved outside-project read targets are added as exact files or recursive directory
subtrees, without ancestor `allowRead` entries. ASRT already allows directory metadata
traversal. A bare ancestor is a recursive subpath allow, and with the current runtime
it can also cause a late whole-home deny to hide the explicitly approved target.
Native regression coverage reads nested test artifacts while rejecting sibling reads
and writes; read consent never grants host writes or network access.

### CoreSimulator host commands and deletion

`xcrun simctl` device operations and direct `simctl` invocations use host
CoreSimulator services and follow the host-approval path, even when a pipeline
or `|| echo` masks a command failure. Help and `xcrun --find` stay contained.

Device Hub simulator deletion accepts one UUID, shuts down that device if
needed, deletes it, and reports absence only after a successful host inventory.
Deletion asks on every invocation, including with a stored Device Hub allow,
and cannot be remembered through the approval dialog. Stored blocks, read-only
runs and toolGate hooks still win. Other Device Hub actions retain their policy.
