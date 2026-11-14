# Renderer XSS containment

## Threat and boundary

Assume arbitrary JavaScript runs in the main renderer through model output, a project file,
Markdown, a web surface, or another UI bug. It can call every API exposed by the preload,
forge DOM events and approval answers, and read renderer-visible state. Main-frame IPC checks
and renderer dialogs do not prove a human decision. The main process, OS dialog, and project OS
sandbox are separate trust domains.

The first containment step keeps each pending approval request in main and requires an
OS-owned confirmation before accepting a positive renderer answer. The dialog shows the
main-owned action and proposed grant scope. High-impact renderer IPC paths now require the
same confirmation before changing permissions, loading executable integrations, starting
unsandboxed app tooling, publishing GitHub changes, or opening renderer-supplied links in the
system browser. An MCP server's discovered sign-in destination receives a separate exact-URL
confirmation before the system browser opens it. Rejected or unavailable confirmation must leave
the underlying state unchanged.

Project MCP definitions are pinned to the exact configuration shown in the OS confirmation.
An edit to a trusted project's MCP configuration leaves those servers inert on every reload
path, including external agent forwarding, until the user reviews the new definitions.
Previously trusted projects need this review before their project MCP servers restart.
Project stdio MCP servers now launch in the enforcing project OS sandbox. If the sandbox is
unavailable, they fail closed; they are not handed to an external agent to spawn. Project
environment variables are applied after the sandbox starts, so a project-supplied loader or
shell startup variable cannot run code in the unsandboxed launcher.

## Remaining blockers

1. **Existing integrated terminals.** `terminal:write` trusts the owning `WebContents.id`.
   XSS in that renderer can send arbitrary bytes to a live PTY after the user has opened it.
   A confirmation only at `terminal:create` does not constrain later input. Confirming every
   byte would make the terminal unusable, and confirming only newline or control bytes is
   insufficient because shell key bindings and line editing can execute on other input.
   Move terminal input to a separately isolated trusted surface and remove the write
   capability from the main renderer preload. The separate surface needs a narrow preload,
   no opener or DOM access from the main renderer, strict CSP, and safe handling of PTY output.
   Main must bind each PTY to that surface and revoke its input when the surface closes.
2. **Previously granted agent authority.** A renderer XSS can submit a forged user message or
   steer an active chat. A prompt appears only when policy requires one, so remembered grants,
   trusted commands, and other ambient capabilities may be exercised without the new native
   approval. User input that can activate those grants needs provenance from a trusted input
   surface or a fresh main-owned confirmation of the concrete privileged action.

   The selected product direction is a protected message-entry surface. Main must own its
   `WebContents`, preload, submitted bytes, target thread, and one-use dispatch record. The
   ordinary app renderer may display the conversation but must not receive a token it can spend
   on another prompt. Moving only the visible text box is insufficient: attachments, inline
   chips, queued sends, side chats, resends, delegated prompts, Git recovery continuations,
   review starts, and persisted user-role transcript writes can otherwise carry forged input.
   Main-owned automation and agent continuations need separate provenance and budgets. Ship the
   protected entry only after direct main-renderer IPC and transcript-write probes cannot forge
   any of those routes while normal compose, queue, attachment, and recovery workflows still
   work. The protected surface must have a narrow preload, strict CSP, no opener or webview
   access, no access to the app renderer DOM, and a main-owned visible project/thread identity.

   The implemented protected-entry path freezes provider history and the thread plan before the
   native review, admits the dispatch before consuming a sender-bound one-use optimistic-message
   receipt, and durably accepts the canonical user identity before emitting a turn or starting the
   provider. Renderer appends may edit only an unaccepted user message; they cannot change its
   role or replace an accepted (including pre-lifecycle) user identity. Editing or undoing saved
   provider history now requires an OS-owned review of the exact main-owned before/after history.
   Deleting a whole thread likewise requires native confirmation and a post-confirmation revision
   check, so deletion cannot silently reset the accepted-identity namespace. The renderer no
   longer has a standalone clear-history capability; confirmed whole-thread deletion owns that
   cleanup. Forks, side chats, and promoted side chats create their new transcript and provider
   sidecar together under the main process's project write queue, and fail if the target id already
   exists. A fork can therefore create new context but cannot replace an accepted thread's provider
   history or race a reviewed history edit. Main verifies the new transcript is an exact fresh-id
   copy of accepted source messages before writing it; renderer creation is limited to a blank
   thread or one unaccepted prompt. Renderer autosaves cannot write checkout policy or automation
   provenance. A scheduled first turn requires empty provider history and a validated isolated
   worktree before its one-use unattended grant is consumed; deleting a pending run retires that
   grant before the thread id is released.
   Model-created subthread prompts use a separate Main-minted one-use grant bound to the exact
   owned parent, child, prompt text and optimistic message id.
   Main activates it only after that exact message is durable in a validated isolated worktree,
   then reserves the dispatch slot and revalidates the worktree before consuming it. The grant
   carries no renderer-mutable plan, todos, brief, model or execution controls; canonical provider
   history is re-read from the Main-only sidecar inside that exclusive slot. Renderer machine
   provenance is display/queue metadata only; edits and deletion revoke the bound receipt/grant,
   while changed, replayed, missing or post-restart grants fall back to protected human review.

3. **Broader renderer data access and side effects.** The renderer still has many read and
   low-friction write APIs. In particular, the visible browser's public-web session accepts
   renderer-created webviews and arbitrary HTTP(S) navigations, so an XSS can use it as a
   network egress path despite native confirmation on system-browser links. Audit that
   session and the remaining file, browser, integration and denial-of-service APIs against
   a capability inventory. Native dialogs on selected sinks do not replace that boundary.
4. **User-level executable integrations reachable through a workspace.** User/global MCP
   definitions still launch outside the project sandbox. A user definition may explicitly
   point at a script in a renderer-writable workspace, or select that workspace as its
   working directory. The project-source sandbox rule does not cover that case. Inventory
   those launch paths and either move them into an enforcing sandbox or require a trusted
   decision about the executable content at spawn time.
5. **Pending native-parent steering integration.** Draft PR #4310 is not part of this source.
   Its current renderer `agent:steer` path can select a held renderer-authored note and add it to
   provider history without protected acceptance. It must be composed with this boundary before
   merge: main must freeze the exact note and target, require the protected human decision, and
   durably accept the canonical identity before provider delivery. Denial, Stop, or turn closure
   must leave the note held and must not add it to provider context.

## Acceptance criteria for closing the blockers

- Inject JavaScript into the primary renderer in a test profile with a live terminal. Direct
  `terminal:write` and synthetic terminal events cannot execute a command; real typing in the
  isolated terminal still works. The same result holds for a terminal opened before the
  injection and for a pane pop-out.
- Inject JavaScript while an agent approval is pending. Renderer `approval:respond` alone
  cannot execute the action, remember it, or grant a turn-tree lease. Native Deny and window
  closure leave the action denied. Native approval displays the exact main-owned request,
  including Markdown body and grant scope.
- Inject JavaScript with existing remembered grants. It cannot turn a forged renderer
  message into unsandboxed or externally published work without fresh trusted provenance.
- A renderer-supplied external URL, including a window-open or navigation attempt, reaches
  the system browser only after the user confirms its exact URL in an OS dialog. Denial and
  invalid URLs do not open it.
- A trusted project MCP stdio server whose script changes after config approval cannot write
  outside its project or use network access. With the OS sandbox unavailable, it does not
  launch; no project stdio definition reaches an external agent for a direct spawn.
- Run the security-focused unit tests, a focused Electron screenshot spec, an on-device native
  dialog check, and the full `pnpm run check` gate. Record platform-specific failures and
  independent security review before marking the PR ready.

## Follow-up acceptance cases

The following cases assume script execution in the primary renderer, including access to
the full primary preload API. A check that only dispatches a synthetic DOM event is too
weak: the injected script must call the exposed API directly. Each case also verifies the
ordinary human workflow after the attempted misuse.

### Live terminal input

- Open an unsandboxed terminal, then inject script into its owning app renderer. Direct
  `terminal:write` calls, synthetic xterm key/paste events, and a pane pop-out cannot send
  command bytes to that existing PTY. A real person can still type, paste, resize, close,
  and reopen a terminal through a separate input surface. An app-renderer reload revokes
  any stale input binding.
- Main owns the PTY and binds input to the separately isolated terminal view's exact
  `WebContents` and frame. The ordinary app preload has no terminal-write capability.
  PTY output is treated as untrusted text in the terminal view, and that view cannot
  navigate, open windows, attach webviews, or access the chat/project DOM.

### Forged chat and standing grants

- With an existing trusted-command, MCP, browser-origin, or GitHub-write grant, inject
  script that calls `agent:run`, `agent:run-machine`, sends a queued prompt, or steers a
  running chat. No grant-backed command or outward request runs solely because of that
  script. Denial or closure of the main-owned decision leaves the action unexecuted.
- A real person can submit the same message and exercise the already-granted action
  through trusted message entry, or approve the exact privileged action in an OS dialog.
  The decision is bound to the frozen message or concrete tool call, thread, and turn;
  later text edits, queued delivery, or workspace switches cannot reuse it.
- Main-owned automation and agent continuations keep their recorded provenance and
  existing budgets. They cannot be relabelled as human messages through renderer IPC.

### Scheduled-run grants

- The main process records the exact prompt and model of each created automation run.
  Its schedule-scoped MCP and GitHub grants apply only during that run's first turn
  when the actual model input matches that record and contains no added instructions,
  attachments, thread plan, or earlier unrelated messages, and execution is bound to
  the validated isolated worktree main allocated for that run.
- A later message to the same automation thread, a forged `automationRun` marker,
  an edited pending prompt, or a concurrent schedule edit cannot reuse unattended
  grants. Main consumes a durable one-time claim before the first turn starts, so
  even a failed or empty first run cannot grant a second turn. The normal approval
  path remains available for a person continuing the
  thread. Existing runs without the new record fail closed for schedule grants.

### Native parent steering

- A renderer call that asks to steer a held note cannot add that note to a live provider context
  until the exact main-owned note and target pass protected human acceptance. Renderer-writable
  queue flags, run ids, and steering receipts are not proof of human authorship.
- Denying the protected decision, pressing Stop, closing the turn, or changing the held note while
  review is open leaves it held and delivers no provider message. An accepted note is delivered at
  most once and its canonical accepted identity is committed before the next provider request.

### User-level MCP definitions that reach a workspace

- A user/global stdio definition whose command, working directory, loader variables,
  or resolved script target is inside a renderer-writable workspace does not execute
  that code outside containment without a fresh main-owned decision for that launch.
  Changing the script after an earlier launch, then invoking reload, repeats the check.
- The implicit working directory for a user/global definition is a main-owned user
  directory, not the currently selected workspace. A server configured entirely
  outside the workspace continues to start as before. If no trusted decision surface
  is available, a workspace-coupled launch fails closed and reports a useful status.
- The same rule applies at app boot, Settings reload, plugin reload, external-agent
  forwarding, and headless ACP startup. A direct external-agent stdio spawn cannot
  bypass Copse's launch decision.

### Visible browser network access

- Inject script that appends a `<webview>` using the visible browser partition,
  navigates an existing tab, or calls the guest's `executeJavaScript` method. None
  of those paths can send a request to an attacker-controlled HTTP(S) origin.
- A person can still use the address bar, tabs, login cookies, context menu, and
  page navigation in a main-owned browser guest. Main binds each guest to a trusted
  view, and its navigation authority cannot be minted by the app renderer. Agent
  browser partitions remain separate and keep their origin allowlist.
