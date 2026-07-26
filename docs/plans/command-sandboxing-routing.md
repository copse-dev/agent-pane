# Command sandboxing routing

**Status: Resolved (safe core shipped).** The trusted-command allow-list landed in
[#700](https://github.com/copse-dev/agent-pane/pull/700). The
richer read/write/container tier model below is designed but deferred — see
"Why the tiers were deferred".

## Motivation

Today a shell command gets one of two fates (`permission-policy.ts` →
`decideShellPermission`), derived from a 3-way heuristic verdict in
`shell-scope.ts`: auto-run inside the seatbelt (`sandbox`/`ambiguous`), or prompt
and run unsandboxed (`external`). That's coarse in one costly direction: some
commands genuinely **cannot** run inside the workspace sandbox (they need the
host toolchain, code signing, or vendor endpoints — `xcodebuild` is the canonical
case) yet are entirely safe for a trusted project. Under the binary model they
hit `external` and prompt on every invocation — pure prompt fatigue, which trains
users to disable the gate (violating principle #3 in `docs/threat-model.md`).

## What shipped: a trusted-command allow-list

A per-user list of command **basenames** the user trusts to run **unsandboxed
with no prompt**. Configured in Settings → Local models → "Trusted commands"
(one name per line). The allow-list is honoured **only** when:

- **auto-run is enabled** (the global toggle), AND
- **the workspace is trusted** (`isWorkspaceTrusted` — the same gate that keeps a
  cloned repo's MCP servers inert; a freshly-cloned untrusted repo can carry a
  list but never gets its commands auto-run), AND
- the command passes the eligibility rules below.

### Eligibility (`resolveCommandRouting`)

A command runs unsandboxed-no-prompt (`allow`) only when **every** condition holds
— otherwise it `defer`s to the existing gate, which sandboxes or prompts exactly
as before (purely additive: nothing that auto-runs today starts prompting):

1. No command substitution, subshell grouping, or backticks (``/[`(]/`` — over-broad
   on purpose; a false positive only means "use the normal path"). This catches
   `$(…)`, `` `…` ``, and process substitution `<(…)`/`>(…)`.
2. No destructive-in-sandbox pattern on the whole command (`rm -rf`, fork bombs,
   pipe-to-interpreter, …) — reuses `dangerousInSandboxReasons`.
3. **Every** top-level segment (split on `&&`/`||`/`;`/`|`/`&`, quote- and
   escape-aware) is either:
   - an explicitly **trusted** command (basename in the list), whose waiver
     applies to that segment only; **or**
   - a **trivially-safe prep** command (`mkdir`, `cd`, `echo`, `pwd`, `printf`,
     `true`, `false`, `:`, `basename`, `dirname`) that itself shows **no**
     network/outside-workspace signal under `analyzeShellCommand` (verdict must be
     `sandbox`) and is not destructive.
4. At least one segment is actually trusted (else nothing needs to escape the
   sandbox — it runs contained via the normal path).
5. No segment's head is an interpreter/shell/remote-exec tool (`sh`, `bash`,
   `node`, `python`, `ssh`, `sudo`, `find`, `xargs`, `awk`, …). Trusting one of
   those would turn a single grant into an unbounded escape, so the list entry is
   ignored.

### Why this is safe (and how it differs from the first attempt)

The first implementation resolved a compound command to the **most-permissive
tier across its segments** and ran the whole line there. That was unsound: a
`sandbox`-verdict segment like `npm test` is only safe _because the seatbelt
denies it network + home_. Running the whole line unsandboxed because a sibling
was `allow` meant `npm test && xcodebuild` executed an arbitrary repo test script
**unsandboxed with full network** — the exact thing the design claimed to
prevent.

The allow-list model closes that:

- The trust waiver is **per-segment**. A sibling `curl` / `git push` / `npm test`
  is neither trusted nor trivially-safe → the whole command `defer`s → the normal
  gate sandboxes or prompts it. Nothing sandbox-dependent runs unsandboxed.
- Analysis is **never** skipped for a co-segment (`xcodebuild <(curl evil)` →
  substitution gate → defer → normal gate prompts on `curl`).
- Interpreters can't be trusted, so `bash`/`node`/`sh` on the list are ignored.
- Honoured only in a **trusted workspace**, so a cloned repo can't benefit.
- The gate (does it prompt?) and the tool / todo-verification (does it run
  unsandboxed?) call the **same** `routeShellCommand` on the **same raw command**,
  so the prompt decision and the execution context cannot disagree.

## How it's wired

- `src/shared/command-routing.ts` — renderer-safe types + text (`parse`/`format`/
  `sanitize`) for the allow-list; `TRUSTED_COMMANDS_SETTING`.
- `src/main/services/security/command-routing.ts` — pure `resolveCommandRouting`
  (allow/defer), quote- and escape-aware `splitSegments`, `shell-quote`-based
  `commandHead`, the safe-prep and non-trustable sets.
- `src/main/services/security/shell-argv.ts` — the lexing primitives shared by all
  three analyzers: segment splitting, wrapper unwrapping, and the interpreter,
  script-suffix, and inline-code-flag tables.
- `src/main/services/security/command-routing-config.ts` — `routeShellCommand`
  (auto-run + workspace-trust gating, cached allow-set) and `shellRunsOutsideSandbox`,
  the single unsandboxed-decision helper shared by the tool and todo checks.
- `permission-gate.ts` — trusted fast path returns `true` (no prompt) on `allow`.
- `shell-tool.ts` / `todo-verification.ts` — `shellRunsOutsideSandbox(command)`.
- Settings: `trustedShellCommands` (validated by `trustedShellCommandsSchema`) +
  the "Trusted commands" fieldset.

## Guarded YOLO: explicit one-turn broad execution

Issue #1249 adds a separate, high-friction mode for a user who deliberately wants
routine local, network, outside-workspace, or privileged shell work to proceed
without scope prompts. It does **not** change standard-mode defaults or the trusted
command list.

- The user enables it from the composer overflow and confirms a host-owned warning.
  The capability is held only in memory, belongs to one thread, is consumed by its
  next agent turn, and expires after that turn, after 15 minutes unused, or on app
  restart. It is never restored from settings or migrated data.
- While active, `run_shell` and `run_background` still use the macOS project sandbox
  where it can contain the command. Commands which require host/network scope run
  unsandboxed; Linux and Windows always report that no OS sandbox is active. The
  persistent composer strip and shell/background output state the actual containment.
- Every effective command passes `shell-harm.ts` **after** blocking-hook rewrites. The
  deterministic host verdict is authoritative: `allow` auto-runs, `prompt` requires a
  one-time confirmation which cannot be remembered, and `deny` cannot be approved.
  Missing assessment fails closed. Trusted commands, ACP clients, hook outcomes,
  classifier output, and `expects_sandbox_block` are routing inputs only and cannot
  downgrade the verdict.
- **The harm gate is a denylist, and a denylist is not a security boundary.** It
  recognises forms we have thought of. It cannot recognise the ones we have not, and
  a determined or compromised agent can express destruction in ways no pattern list
  enumerates. Treat it as a guardrail against plausible accidents, not as protection
  against an adversary. The only real containment is the OS sandbox, and Guarded YOLO
  exists precisely to step outside it — so on Linux and Windows, and for host-scope
  commands on macOS, **there is no containment left and this list is all that stands
  between the agent and the machine.** Enable it only where you would accept the
  agent running arbitrary commands: a disposable VM, a container, a machine whose
  loss you can absorb. Cursor's equivalent mode has been bypassed repeatedly in
  public (CVE-2026-22708, `&&` chaining, shell built-ins); ours handles those
  particular forms, which is evidence the class is hard, not evidence we have won.
- What the analyzer does cover: it resolves home/workspace paths and symlinks, splits
  compound commands, unwraps pass-through wrappers (`env`, `sudo`, `timeout`, `nice`,
  `xargs`, …) including options whose value is a separate argument (`sudo -u root …`),
  and inspects command/process substitutions (`$(…)`, backticks), `eval` bodies,
  `find -exec` payloads, interpreter bodies, and readable script files, across common
  Unix, macOS, PowerShell, and Windows forms.

  Hard-denied: erasure of the filesystem root, home, workspace, or a system tree
  (`/etc`, `/usr`, `/System`, `C:\Windows`, …) — with or without `-f`, since `rm -r`
  deletes just the same; the same targets reached by recursive
  `chown`/`chmod`/`chgrp`/`chattr`/`takeown` or by relocation (`mv`, `rsync --delete`),
  which destroy access without deleting anything; raw-device destruction, including
  verbs that name no `/dev` node in a recognised form (`wipefs`, `blkdiscard`,
  `sgdisk --zap-all`, `cryptsetup luksFormat`); truncating redirects into a system
  tree and any write to a host credential file (`/etc/sudoers`, `/etc/shadow`);
  destruction of backups and recovery state (`vssadmin delete shadows`, `tmutil
delete`, `journalctl --vacuum-*`, `bcdedit … recoveryenabled No`); disabling host
  security controls (`csrutil disable`, `setenforce 0`, `Set-MpPreference -Disable*`);
  account and registry-hive removal; signals that take out the whole session
  (`kill -9 -1`, `pkill -u`); host shutdown and fork bombs; and attempts to rewrite
  the permission surface.

  Prompted: bounded deletion, `dd` overwrite of an existing path, forced symlink
  replacement, `crontab -r`, writes landing on credential/startup paths (`~/.ssh`,
  `~/.bashrc`, …) whether by redirect, `tee`, `cp`, or `install`, relocation of a
  workspace tree out of the workspace, destructive version-control operations
  (`git push --force`, `git branch -D`, `git reflog expire`, `git update-ref -d`,
  `git filter-branch`, `git stash clear`, `git checkout .`, `git gc --prune=now`),
  interpreter deletion whose target cannot be resolved, destructive targets a
  different tool substitutes at run time (`xargs -I{}`), opaque scripts, dynamic
  destructive paths, and resource-exhaustion signals.

  Explicitly **not** modelled, and left as open scope rather than oversight: anything
  whose blast radius is remote rather than local — `aws s3 rm --recursive`,
  `terraform destroy`, `kubectl delete namespace`, `gh repo delete`, `dropdb`,
  `redis-cli FLUSHALL` — and exfiltration of local secrets over the network, which
  this mode deliberately permits (credential scrubbing covers the child environment,
  not files on disk). Also unmodelled: system package removal (`apt-get remove
--purge libc6`), which can brick a host but whose safe forms are too common to
  prompt on.

- Lexing, wrapper unwrapping, and the interpreter/script/inline-flag tables are shared
  with the other two analyzers via `shell-argv.ts`. The wrapper list it exposes for
  _routing_ is deliberately narrower than the one for harm analysis: seeing through
  `sudo` is always right when asking "what damage can this do" and always wrong when
  asking "which binary did the user authorise".
- Each decision appends a `permission_decision` line to the thread spine with the
  original/effective command, original/effective mode, actual sandbox state, harm and
  policy verdicts, reasons, and user response. ACP-native tool bridge calls use the
  same recording window.

This is a prompt-reduction tool, not a complete security boundary. Deterministic
analysis cannot prove arbitrary programs benign, an allowed executable can contain
unknown behavior, and platforms without the macOS sandbox expose the user's full
account. The short-lived explicit capability, truthful containment UI, credential
scrubbing, and non-bypassable catastrophic checks reduce risk; they do not make
untrusted repositories safe to run.

## Why the tiers were deferred

The original exploration proposed `read`/`write`/`container`/`allow` tiers. A code
review found the tier machinery added risk without proportional value in v1:

- **`write`** is identical to today's default overlay — a no-op as a user setting.
- **`read`** (a read-only seatbelt overlay) is a genuine tightening, but the
  redirect detection was unreliable and a read-overlay write-denial escalated the
  retry to _fully unsandboxed_ — a defense-in-depth regression. Deferred until the
  write-capability detection lives in the shared analyzer.
- **`container`** had **no backend** (macOS seatbelt only), yet was frozen into
  the persisted schema, preload types, Settings copy, and an invented
  `allow`+`container` incompatibility rule. Speculative API over user-persisted
  settings. Deferred until a real runner exists.

Only `allow` (the trusted list) carries real, safe value today, so that's what
shipped. The tier vision remains valid as future work.

### Remaining follow-ups

- A real cross-platform runtime backend, then reintroduce the `container` tier with
  validated semantics. Capability reporting, network/credential mediation, and local /
  cloud sequencing are owned by
  [`execution-runtime-security.md`](execution-runtime-security.md); do not freeze a
  persisted tier until an enforcing backend and conformance suite exist.
- A read-only overlay tier once write-capability detection is modelled in
  `shell-scope.ts` (shared by the analyzer and the tier), with a sandboxed
  (not unsandboxed) failure fallback.
- `run_background` currently always sandboxes; extend the allow-list to it if a
  trusted long-lived task is needed.
- A focused WebdriverIO e2e for the new Settings fieldset (per `AGENTS.md`).

### Shipped follow-ups

- **"Always trust this command" tick box on the escalation prompt** (prompt-once →
  add to the list). Both "run outside sandbox?" prompts — the up-front external
  escalation and the post-failure unsandboxed retry — offer an "Always allow
  `<binary>` in trusted projects" checkbox when a single eligible binary resolves
  (`trustableCommandHead`: one simple command, no compound/pipeline/substitution,
  not an interpreter, not destructive). Ticking it appends the basename to
  `trustedShellCommands`, so future runs pass through `routeShellCommand` and run
  unsandboxed with no prompt. This is the single grant path — there is deliberately
  no separate per-invocation "remembered command" store; every remembered grant is
  re-evaluated by the per-segment router at use time, so a later
  `xcodebuild && curl evil` cannot be laundered by a prior `xcodebuild` grant. Only
  offered in a trusted workspace (`offerableTrustedCommand`).
