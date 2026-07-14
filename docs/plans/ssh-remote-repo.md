# SSH support for remote repos

**Status:** exploration / plan. Nothing here is implemented. This document maps
every moving part required to let Copse work with a repository that lives on a
**remote host reachable over SSH** (VS Code Remote-SSH-style), plus the smaller
prerequisite of making **SSH-authenticated git remotes** work properly on local
checkouts. It is grounded in a code audit of the current `main` — file/line
references below are from that audit.

## Two readings of "SSH support", and why the plan covers both

1. **Phase 0 — SSH auth for git remotes on a _local_ checkout.** Today any git
   operation that needs interactive SSH auth (key passphrase, unknown host key)
   fails silently-ish: the internal runner forces `GIT_SSH_COMMAND='ssh
-oBatchMode=yes'` + `GIT_TERMINAL_PROMPT=0`, and there is **no askpass,
   credential-helper, or host-key plumbing anywhere** in the codebase. This is
   small, independently shippable, and a hard prerequisite for the bigger
   feature (the bigger feature _is_ an SSH client).
2. **Phases 1–6 — an SSH-remote workspace.** Open a repo whose filesystem and
   toolchain live on another machine: file tree, agent file tools, shell tool,
   terminal, git pane, and search all operate on the remote host, while the
   LLM loop, approvals, thread store, and UI stay local.

## What the audit found (current state)

### Execution is centralized; filesystem I/O is not

- **One spawn choke-point.** Every workspace-targeted command funnels through
  the four functions in `src/main/project-sandbox/spawn.ts`:
  `spawnInProjectSandbox` (:84, argv form → `runCommand`),
  `spawnShellInProjectSandbox` (:126, `sh -c` form → shell tool),
  `spawnBackgroundProcess` (:181), and `spawnPtyInProjectSandbox` (:265,
  node-pty → integrated terminal). Each already branches
  sandboxed/unsandboxed; a remote mode is a third branch here and covers all
  four call paths at once. The only workspace-git spawn that bypasses it is
  `runGitBuffer` (`git-service.ts:214`, a `spawnSync` used for image blobs).
- **Path _resolution_ is centralized, I/O is scattered.**
  `resolveWorkspacePath` / `resolveReadablePath` / `assertWorkspaceWriteTarget`
  / `toRelativePath` (`src/main/services/workspace.ts:128,203,240,286`) gate
  nearly every path — but they are synchronous and local-fs-bound
  (`existsSync`, `realpathSync.native`, `lstatSync`). Actual reads/writes do
  **not** funnel through one interface: the `gateway*` functions
  (`src/main/project-sandbox/sandbox-fs-client.ts:87-135`) cover only the four
  renderer `fs:*` IPC handlers and the fs-watcher; the agent file tools
  (`file-tools.ts`, `write-file-tool.ts`, `str-replace-tool.ts`,
  `file-ops-tools.ts`, `read-text-file.ts:138`) and the entire diff-queue
  apply path (`diff-queue.ts:389,410,434,464`) call `node:fs/promises`
  directly. Roughly 15 non-test modules touch `node:fs` against workspace
  paths.
- **Search shells out.** Grep/index paths never read file content via
  `node:fs` — they run `rg`/`ig`/gortex with `cwd = workspaceRoot`
  (`file-index.ts`, `indexed-grep.ts`, `semantic-index.ts:230-242`). The
  semantic index daemon stores state under Electron `userData`
  (`gortexHomeDir()`, `semantic-index.ts:226`), keyed by the resolved local
  root.
- **Terminal renderer is transport-agnostic.** The xterm.js pane only needs
  the existing IPC shape (`terminal:create/write/resize/destroy` +
  `terminal:output/exit`, `src/shared/types/ipc.ts:200,327`) — an opaque
  session id and a byte stream. A remote PTY needs zero renderer changes.

### Git and GitHub

- The internal git service (`src/main/services/github/git-service.ts`) is
  **local-only by design**: status/diff/blob/branch/commit/backup, no
  push/pull/fetch/clone. Network git happens only through the agent's
  `run_shell` (classified by `shell-scope.ts:101` as "git network operation")
  and the user's terminal.
- The blocking SSH env is set in exactly **two** places — `runCommand`'s
  `prepareGitInvocation` (`command-runner.ts:41-59`) and `runGitBuffer`
  (`git-service.ts:223-224`) — and both already honor an ambient
  `GIT_SSH_COMMAND` override. That is the natural insertion seam for Phase 0.
  Note a subtlety: a shell-spawned `git push` (`sh -c "git push"`) does _not_
  get the forced BatchMode (cmd ≠ `git` at the runner), so it inherits the
  ambient env — with no tty and no `SSH_ASKPASS`, passphrase-protected keys
  and unknown hosts fail there today unless an ssh-agent is loaded.
- GitHub access is a three-impl backend (`cli` / `api` / `mock`,
  `backend/backend.ts:35-89`) authenticated by HTTPS tokens — SSH plays no
  role there, and the `api` backend runs local `fetch`, so the GitHub layer
  is almost untouched by a remote workspace (see Phase 4).

### Security machinery that interacts

- `ssh`/`scp`/`rsync` are **hard-flagged external** commands
  (`shell-scope.ts:88`) and `ssh` is in `NON_TRUSTABLE_COMMANDS`
  (`security/command-routing.ts:77`) — it can never be auto-run-allow-listed.
  Those rules are about _user-authored_ commands and must keep working; the
  tool's own SSH transport has to be injected **below** the routing decision
  (at the spawn layer), so classification still sees the original command.
- The macOS seatbelt (`project-sandbox/config.ts`) is local-machine-specific
  and simply does not apply to remote execution. Off-macOS there is no OS
  sandbox anyway. The approval gate (`permission-gate.ts:294,510`) is
  host-agnostic and continues to run locally.
- Process-tree kill (`subprocess-kill.ts:34`) signals a local process group
  (`process.kill(-pid)`) — remote processes need their own kill path.
- Env scrubbing (`envForRendererChildProcess`,
  `exec/child-process-env.ts:42`) strips LLM/provider keys from child
  processes; SSH does not inherit env anyway, so remote env must be set
  explicitly (and must apply the same scrub-by-construction).

### Prior art and reusable pieces already in-tree

- **"Remote" is a taken name.** `src/main/services/remote/` is the cloud
  agent hand-off (Cursor / Anthropic Managed Agents over HTTPS). The new
  feature needs distinct naming — this plan uses **"SSH workspace"**
  (`src/main/services/ssh-workspace/`, settings keys `sshWorkspace*`).
- **ACP's injectable transport** (`AcpTransportFactory`,
  `acp/acp-client.ts:346`) is the in-repo precedent for swapping a stdio
  transport, and ACP sessions bind to a workspace purely via `cwd` — the same
  shape a remote-exec seam wants.
- **Secret storage is reusable as-is.** The `apiKey.<slug>` pattern
  (`storage/settings.ts:77` — `safeStorage` encryption with explicit
  plaintext consent) fits SSH key passphrases without new machinery. New
  settings register in `RENDERER_WRITABLE_SETTING_SCHEMAS`
  (`settings-writable.ts:99`) or `MAIN_ONLY_SETTING_SCHEMAS`.
- **Ports panel parsers are transport-agnostic** (`ports/port-scan.ts` parses
  `ss`/`lsof`/`netstat` text) — remote port discovery is "run the same
  command over SSH", which is exactly what issue #771 (tunnel-based port
  forwarding) anticipates.
- **No SSH library exists** (`package.json`: no `ssh2`/`node-ssh`; native
  deps are `node-pty` and the seatbelt runtime; Electron 43).

## Design

### Phase 0 — SSH auth for git on local checkouts

Goal: `git push`/`pull`/`fetch` over `git@…` remotes works from the agent's
shell and internal runners, with prompts surfaced in the Copse UI instead of
dying in BatchMode.

Moving parts:

1. **Askpass bridge.** A tiny helper (a Node script shipped in the bundle,
   invoked as `GIT_ASKPASS`/`SSH_ASKPASS` with `SSH_ASKPASS_REQUIRE=force`)
   that connects back to the main process over a one-shot local socket
   carrying a per-spawn nonce, and resolves via a modal prompt in the
   approval-dialog family (`src/renderer/views/approval-dialog.ts` pattern).
   Timeout ⇒ deny. The nonce/socket pair is minted per spawned command in the
   env-preparation step, so an arbitrary process cannot solicit prompts.
2. **Host-key policy.** Default `GIT_SSH_COMMAND` becomes
   `ssh -oStrictHostKeyChecking=accept-new` (setting:
   `sshStrictHostKeys: 'accept-new' | 'strict'`), with unknown-host
   confirmation routed through the same askpass bridge when strict.
3. **Env injection points.** Extend `prepareGitInvocation`
   (`command-runner.ts:41`) and `runGitBuffer` (`git-service.ts:219`) — drop
   the unconditional BatchMode when the askpass bridge is available — and add
   the same `SSH_ASKPASS`/`GIT_ASKPASS` vars to the shell tool's child env
   (`shell-tool.ts:306`) so `sh -c "git push"` can prompt too. The integrated
   terminal already has a real tty and needs nothing.
4. **Passphrase caching (optional, later).** Offer "remember passphrase"
   backed by the `apiKey.<slug>` secret store, feeding the askpass response;
   or simply document ssh-agent as the recommended path and detect
   `SSH_AUTH_SOCK` to skip prompting.

Sizing: small (days). No architectural change; fully local.

### Phase 1 — SSH connection core (`src/main/services/ssh-workspace/`)

The transport everything else rides on.

- **Client strategy — decision needed.** Two options:
  - **System OpenSSH + ControlMaster (recommended).** Spawn `ssh` with a
    per-host `ControlMaster=auto` / `ControlPath=<userData>/ssh/%C` /
    `ControlPersist=10m` control connection; every subsequent exec/SFTP call
    multiplexes over it (~10–30 ms per call vs 100 ms+ for fresh
    connections). Pros: the user's `~/.ssh/config`, agent, keys,
    `ProxyJump`, and `known_hosts` all work for free; no native dependency.
    Cons: Windows OpenSSH lacks ControlMaster (fallback: one long-lived
    connection driven in "server" style, or per-command connects), and we
    parse process output rather than a typed API.
  - **`ssh2` (pure-JS npm lib).** Typed API, real SFTP subsystem, works
    identically on Windows. Cons: reimplements config/agent/proxy handling,
    new supply-chain surface (cf. `docs/supply-chain-security.md`), keys read
    by our process (larger secret-handling surface).
  - Recommendation: **OpenSSH binary first** (matches the repo's
    shell-out-to-`rg`/`git`/`gh` philosophy), keep the interface narrow
    enough that an `ssh2` backend can be added for Windows later.
- **`SshConnectionManager`**: `getConnection(hostId)` → ensures the control
  connection, exposes `exec(argv|shellLine, {cwd, env, stdin, signal,
maxBytes})`, `execPty(...)`, and `sftp()` handles; watches liveness and
  emits connect/drop events (renderer banner + reconnect).
- **Host configuration**: a settings-backed list (`sshWorkspaceHosts`:
  `{id, label, host, port?, user?, identityFile?}`) plus a picker that offers
  `Host` aliases parsed from `~/.ssh/config`. Auth prompts (passphrase,
  host key, 2FA keyboard-interactive) reuse the Phase 0 askpass bridge.
- **Remote prerequisites probe**: on first connect run a capability check
  (POSIX shell, `git`, `rg`, `inotifywait`?, OS/arch) and surface a
  actionable report ("`rg` missing on host — searches will use `grep -r`
  fallback"). No server component is installed in v1 (see "Deliberately
  deferred" below).

### Phase 2 — execution seam (shell tool, background tasks, terminal)

- **`ExecutionTarget` abstraction** threaded through the four `spawn.ts`
  functions: `{kind:'local'} | {kind:'ssh', hostId, remoteRoot}`. In remote
  mode the sandboxed/unsandboxed branch collapses to a single path that
  rewrites the invocation to
  `ssh <mux-opts> <host> -- cd <root> && exec <cmd>` (argv carefully quoted;
  a shared `shellQuote` helper with tests). Because rewriting happens _below_
  `shellRunsOutsideSandbox`/`decideShellPermission`, the permission gate and
  `shell-scope` classification keep operating on the user's original command
  — `ssh` stays hard-external for _user-authored_ commands with no rule
  changes.
- **Process lifecycle**: remote commands run under `setsid` and report their
  remote PGID on stdout prelude (or via `echo $$`); `terminateProcessTree`
  grows a remote variant that runs `kill -TERM -- -<pgid>` (then `-KILL`)
  over the control connection. Local kill of the `ssh` client alone is not
  enough (orphaned remote processes).
- **Env**: never forward the local env. Build the remote env explicitly from
  a small allow-list (mirroring `envForRendererChildProcess`'s intent by
  construction) via `env KEY=VAL …` prefix — `SendEnv/SetEnv` require server
  cooperation, the `env` prefix does not.
- **Timeouts / output caps**: unchanged — `CappedOutputAccumulator` and the
  30 s default already operate on the local stream.
- **Terminal**: `spawnPtyInProjectSandbox` remote branch = node-pty spawning
  `ssh -tt <host> -- cd <root> && exec $SHELL -l` (local pty ↔ remote pty).
  Resize propagates via the tty naturally. Renderer untouched.
- **Background processes**: same wrapper; URL detection regexes keep working
  on streamed output, but a detected `localhost:3000` URL is on the _remote_
  loopback — usable only once issue #771's tunnels exist. Until then, tag
  remote-detected URLs as remote and don't offer to open them.
- **Worktree adoption bracket** (`shell-tool.ts:313,344`) reads the worktree
  via the fs layer to diff before/after a command — once Phase 3 routes fs
  through the same target, this stays consistent (both exec and fs hit the
  remote host).

### Phase 3 — filesystem seam (the long pole)

- **Introduce `WorkspaceFs`** (async interface: `readFile`, `readFileRange`,
  `writeFile`, `mkdir`, `rm`, `rename`, `stat`, `lstat`, `readlink`,
  `readdir`, `realpath`, `access`) with a `LocalWorkspaceFs` (current
  behavior) and `SshWorkspaceFs`. Funnel the audited call sites through it:
  - the `gateway*` layer (`sandbox-fs-client.ts`) — becomes
    "sandbox-worker | local | ssh" three-way,
  - diff-queue applies (`diff-queue.ts:389-464`),
  - agent file tools + `read-text-file.ts` (line-range reads map to
    `readFileRange`; over SFTP this is a seeked read, cheap),
  - `fs:*` IPC handlers and the file-search index walker.
- **`SshWorkspaceFs` transport**: SFTP subsystem over the control connection
  (openssh `sftp -b`/`scp -O` are awkward for programmatic use; prefer
  driving the raw `sftp` subsystem via a thin protocol client, or batching
  through `ssh host 'cat/test/mkdir/mv/rm'` exec calls in v1 — exec-based is
  simpler and fully sufficient for v1 volumes; measure before adding SFTP).
- **Path resolution goes async + target-aware.** `resolveWorkspacePath` and
  friends must lose their `*Sync` local calls. Plan: keep the pure lexical
  containment logic shared; perform realpath/lstat symlink checks through
  `WorkspaceFs`. This ripples into every caller (they are already in async
  contexts almost everywhere; `runGitBuffer`'s sync path must be converted).
  This refactor is mechanical but wide — it should land **first, against the
  local backend only**, as a no-behavior-change PR series.
- **Containment guards change meaning, not necessity.** On a remote host the
  symlink-escape guards (`assertWorkspaceWriteTarget`) protect the _remote_
  account's files from a malicious repo — same semantics, different blast
  radius. Keep them.
- **Watchers**: `fs.watch` (`ipc/fs-watcher.ts:18`,
  `workspace-index-watcher.ts:20`) has no remote equivalent. v1: (a) piggyback
  on our own write path (every Copse-originated write already triggers
  `scheduleIndexRebuild` and `fs:changed`), (b) poll open-file mtimes over the
  connection at a modest interval, (c) optionally use remote `inotifywait`
  when the capability probe finds it. Degraded external-edit detection is an
  acceptable v1 trade-off; say so in the UI.
- **What stays local, untouched**: the thread store (`~/.copse/workspace/…`),
  settings/secrets, skills _user_ roots (`~/.claude/skills` etc.), global MCP
  config. **Project-level** instruction files (`AGENTS.md`/`CLAUDE.md`),
  `.cursor/rules`, project skills, and project MCP configs
  (`project-instructions.ts:61`, `skills-registry.ts:151`,
  `mcp-config.ts:124`) must be read through `WorkspaceFs` — and remote
  project MCP configs keep the existing untrusted-by-default gating
  (workspace trust must key on `(host, path)`, not path alone —
  `workspace-trust.ts`).

### Phase 4 — git and GitHub on a remote workspace

- **git runs remotely for free once Phases 2–3 land**: `runGit` already goes
  through `runCommand` (choke-pointed), so status/diff/blob/branch/commit and
  the worktree-backup primitives execute on the host where the repo lives.
  Two specific fixes: convert `runGitBuffer` (`git-service.ts:214`) from
  `spawnSync` to the async runner (also unblocks the async path-resolution
  refactor), and make `isGitAvailable` a per-target probe rather than a local
  `which git`.
- **`gh` should not be assumed on the remote host.** The backend selector
  (`decideBackendKind`, `backend/backend.ts:77`) gains a rule: SSH workspace
  ⇒ prefer the **`api`** backend (local `fetch` + token), falling back to
  local `gh` CLI where the needed data is repo-independent. The repo slug
  still comes from `git remote get-url origin` (now executed remotely).
- **Phase 0's askpass bridge does not reach a remote host's git**. Remote
  `git push` auth uses the _remote_ machine's agent/keys (typical for a dev
  box), or SSH agent forwarding as an explicit opt-in setting
  (`sshWorkspaceForwardAgent`, default off — forwarding grants the remote
  host use of local keys and is a real security decision).

### Phase 5 — search

- **v1: degrade to remote `rg`.** The grep tools already shell out with
  `cwd = root`, so they route through the exec seam unchanged when `rg`
  exists remotely; the capability probe reports when it doesn't (fallback:
  `grep -rn` template, worse but functional). The in-memory file index
  (`file-index.ts`) builds from `rg --files` output — same story.
- **Semantic index: defer.** The gortex daemon runs against a local cwd with
  state in `userData` (`semantic-index.ts:226-242`). Options, in order of
  preference: (1) v1 = disable semantic search for SSH workspaces
  (`search_codebase` falls back to the indexed-grep path it already has),
  (2) later = provision the pinned gortex binary onto the host
  (arch-matched, checksum-verified, same pinning discipline as
  `scripts/fetch-gortex.mts`) and run the daemon remotely with a synthetic
  HOME under `~/.cache/copse/`, (3) never = mirror files locally (rejected:
  defeats the point for big repos).

### Phase 6 — UX, project model, and the panes

- **Project model**: `Project` gains `sshHost?: string`
  (`renderer/controller/projects.ts:237` — dedup key becomes
  `(sshHost ?? '', path)`), and the main-process mirrors
  (`workspaceRoot`/`activeProjectId` storage, `getActiveProjectRoot`) carry
  the target. `canonicalWorkspaceRoot` (`workspace.ts:21`) gets a
  target-aware async variant; the allowed-roots allowlist keys on
  `(host, path)`.
- **Open flow**: "Open remote folder…" — pick a host (from
  `sshWorkspaceHosts` / `~/.ssh/config`), then a minimal remote directory
  browser built on `WorkspaceFs.readdir` (the native `dialog.showOpenDialog`
  at `register-handlers.ts:197` is local-only).
- **Settings**: new "SSH hosts" section in
  `renderer/views/settings-dialog.ts` (nav button + `data-section` panel +
  mount, same pattern as the Remote-agents fieldset at :316); host CRUD,
  strict-host-key toggle, agent-forwarding opt-in, passphrase storage using
  the existing key-host mount pattern.
- **Status surfaces**: footer indicator `⚡ user@host`, disconnect banner
  with reconnect action, and capability warnings (no rg / no watch).
- **External editors** (`editors/editor-launcher.ts:55`): opening a local
  editor on a remote path is meaningless; either hide the affordance for SSH
  workspaces or hand off to editors' own remote schemes
  (`vscode-remote://ssh-remote+host/path`) where detected.
- **Ports panel**: remote enumeration = run the same `ss`/`lsof` commands
  over the exec seam and tag results as remote; actual tunneling
  (`ssh -L`) is issue #771's scope and slots on top of the connection
  manager (`-O forward` on the control connection makes tunnels cheap).

## Security & trust model changes

- **Blast radius moves to the remote account — mostly an improvement.**
  Malicious repo content (hooks, symlinks, poisoned build scripts) executes
  on the remote host, not the local machine; this is directionally the same
  isolation story as issue #712 (container boundary). The seatbelt does not
  apply remotely; classify every remote workspace like a non-macOS local one
  (approval-gated, no auto-run except the trusted-command allow-list, which
  stays valid because classification runs on the original command text).
- **New assets to protect**: SSH credentials (delegated to ssh-agent/OpenSSH
  where possible; passphrases via `safeStorage` if stored at all), host-key
  trust decisions (recorded in the user's own `known_hosts` by OpenSSH —
  don't build a parallel store), and the askpass bridge (nonce-gated,
  per-spawn, deny-on-timeout).
- **Don't leak local secrets remotely**: explicit env allow-list on remote
  exec (never inherit `process.env`); LLM keys never leave the main process
  today and that invariant must hold.
- **Approvals stay local and unchanged**: the permission gate, diff queue,
  and write approvals all run in the local main process regardless of where
  the bytes land.
- **`ssh` command classification is untouched** for user-authored commands;
  the transport wrapper is injected at the spawn layer, after routing.

## Moving-parts checklist

| #   | Subsystem       | Change                                                                                            | Key files                                                                                                                                                            |
| --- | --------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | git auth        | askpass bridge, host-key policy, drop forced BatchMode                                            | `exec/command-runner.ts:41`, `github/git-service.ts:219`, `tools/shell-tool.ts:306`, new `ssh-workspace/askpass.ts`                                                  |
| 1   | connection      | `SshConnectionManager`, host settings, capability probe                                           | new `src/main/services/ssh-workspace/`, `storage/settings-writable.ts:99`                                                                                            |
| 2   | exec            | `ExecutionTarget` through the 4 spawn fns; remote kill; env allow-list; remote PTY                | `project-sandbox/spawn.ts:84,126,181,265`, `exec/subprocess-kill.ts:34`, `exec/terminal-service.ts:94`                                                               |
| 3a  | path resolution | async + target-aware resolve/containment (local-only first, no behavior change)                   | `services/workspace.ts:21,128,203,240,286` + all callers                                                                                                             |
| 3b  | fs              | `WorkspaceFs` interface; route gateway, diff-queue, file tools, read-text-file, index walker      | `project-sandbox/sandbox-fs-client.ts:87-135`, `services/diff-queue.ts:389-464`, `tools/file-*.ts`, `services/read-text-file.ts:138`                                 |
| 3c  | watching        | write-driven refresh + polling fallback (+ optional inotifywait)                                  | `ipc/fs-watcher.ts:18`, `search/workspace-index-watcher.ts:20`                                                                                                       |
| 3d  | project config  | remote reads for instructions/skills/MCP; trust keyed on (host, path)                             | `project-instructions.ts:61`, `skills/skills-registry.ts:151`, `mcp/mcp-config.ts:124`, `security/workspace-trust.ts`                                                |
| 4   | git/gh          | async `runGitBuffer`; per-target git probe; prefer `api` GitHub backend                           | `github/git-service.ts:214,296`, `github/backend/backend.ts:77`                                                                                                      |
| 5   | search          | remote `rg` via exec seam; disable semantic index (v1)                                            | `search/file-index.ts`, `search/indexed-grep.ts`, `search/semantic-index.ts`                                                                                         |
| 6   | UX              | project model `sshHost`, open-remote flow, settings section, footer, editor handoff, remote ports | `renderer/controller/projects.ts:237`, `ipc/register-handlers.ts:197`, `renderer/views/settings-dialog.ts`, `editors/editor-launcher.ts:55`, `ports/host-scan.ts:19` |

## Suggested landing order

1. **Phase 0** (independent value; builds the askpass/host-key muscle).
2. **Phase 3a** — the async, target-aware path-resolution refactor against
   the local backend only. Widest ripple, zero behavior change, unblocks
   everything; do it before any SSH code exists.
3. **Phase 1 + 2** — connection manager + exec seam + remote terminal. At
   this point a "remote terminal + agent shell on host" MVP is demoable, but
   file tools still local ⇒ gate the mode behind an experimental flag.
4. **Phase 3b–3d + 4** — the fs seam, remote config reads, git pane. This is
   the coherence point where the feature can be enabled for real use.
5. **Phase 5 + 6** — search degradation polish, settings/UX, ports.

## Testing strategy

- **Unit**: a `FakeSshTransport` implementing the connection-manager
  interface (echoing scripted exec results), mirroring how `MockLLMProvider`
  and `mockGitHubBackend` are used today. All `WorkspaceFs` implementations
  run one shared conformance suite (local tmpdir vs fake-ssh vs — in CI —
  real loopback).
- **Integration/e2e**: a loopback `sshd` fixture on the Linux CI runner
  (key-only auth on `127.0.0.1:2222`, chrooted test home) driven by the
  existing WebdriverIO harness; specs cover open-remote-folder, file
  edit+approve round trip, terminal echo, git status, disconnect/reconnect.
- **Quoting/escaping**: property-style tests for the `shellQuote` remote
  wrapper (filenames with spaces/quotes/newlines are the classic corruption
  vector for `ssh host -- cmd`).

## Deliberately deferred / rejected

- **A remote server component** (VS Code-server-style helper binary doing
  multiplexed fs+exec+watch over one channel). Rejected for v1: it is the
  single biggest cost in VS Code's architecture (per-arch builds,
  bootstrap/upgrade lifecycle, security of an installed daemon). The
  exec/SFTP approach is slower per-op but has zero remote footprint;
  ControlMaster keeps latency acceptable. Revisit only if real-world latency
  demands it.
- **Windows-host support (remote side)**: v1 requires a POSIX remote.
  Local-side Windows works via per-command connections (no ControlMaster) or
  a later `ssh2` backend.
- **SSHFS/local mirroring**: hides the remote boundary from the code but
  fights every containment guard (paths stop being canonical), performs
  poorly, and adds a system dependency users must install.
- **Semantic index in v1** (see Phase 5).

## Open decisions

1. OpenSSH-binary vs `ssh2` transport (plan assumes OpenSSH; revisit at
   Windows support).
2. Exec-based fs vs raw SFTP subsystem for `SshWorkspaceFs` v1 (plan assumes
   exec-based; measure).
3. Whether Phase 0 stores passphrases at all, or documents ssh-agent as the
   only remembered path.
4. Agent forwarding default (plan: off, explicit opt-in per host).

## Related issues

- **#771** — remote (tunnel-based) port forwarding: builds directly on the
  Phase 1 connection manager; its "remote-side enumeration over the agent/SSH
  channel" is Phase 6's ports work.
- **#712** — container isolation boundary: an SSH workspace is another
  instance of "the agent's blast radius is a machine that isn't the user's
  laptop"; egress/credential decisions should stay consistent with that
  design.
