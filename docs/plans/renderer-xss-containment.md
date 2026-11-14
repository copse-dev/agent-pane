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
