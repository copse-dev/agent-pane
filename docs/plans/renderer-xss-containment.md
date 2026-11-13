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
unsandboxed app tooling, or publishing GitHub changes. Rejected or unavailable confirmation
must leave the underlying state unchanged.

Project MCP definitions are pinned to the exact configuration shown in the OS confirmation.
An edit to a trusted project's MCP configuration leaves those servers inert on every reload
path, including external agent forwarding, until the user reviews the new definitions.
Previously trusted projects need this review before their project MCP servers restart.

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
   low-friction write APIs. Audit those against a capability inventory, including remote
   browsing, file access, external integrations, and denial of service. Native dialogs on a
   selected set of sinks do not replace that inventory.
4. **Executable content behind trusted project MCP configuration.** The configuration pin
   blocks changed command strings, arguments, environment and working directory. A command
   can still execute a script inside the project, such as `node server.js`; a renderer XSS
   can edit that script without changing `.mcp.json`. Project stdio servers still start
   outside the project sandbox. Contain them in the project OS sandbox and deny launch
   where containment is unavailable, or pin and verify executable content at the spawn
   boundary. Apply the same rule to project servers forwarded to external agents.

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
- Run the security-focused unit tests, a focused Electron screenshot spec, an on-device native
  dialog check, and the full `pnpm run check` gate. Record platform-specific failures and
  independent security review before marking the PR ready.
