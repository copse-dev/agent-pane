# Dynamic read-sandbox relaxation (follow-up to read-access grants)

**Status: Implemented.** Design companion to the read-access approval work on the
`claude/read-access-sandbox-warning-xh18ei` branch, now built on
`claude/read-outside-sandbox-relaxation-impl`. The sections below are kept as the
design record; **[What was actually built](#what-was-actually-built)** at the end
notes where implementation diverged from this plan — including a correction to
the diagnosis below.

## The gap this follow-up closes

The read-access feature (this branch) is a **permission-gate** improvement: a
command that only reads accountable paths outside the project gets a narrower
"Allow read access outside of the project?" prompt and a thread-scoped in-memory
grant (`read-outside-project.ts` → `read-outside-grant.ts`). But with the project
sandbox active, the approval has a side effect that undercuts its own wording:

- The grant only answers the **prompt**. Nothing about it changes how the command
  is then routed or confined.
- Off macOS there is no seatbelt to hit, so the read grant genuinely contains the
  case; with one active the two mechanisms fight: the user granted "read only,
  still contained" and the runner still lands on "run fully unsandboxed".

So a user answering the read-access prompt still ends up with a full sandbox
escape — not what they approved. The fix is to make the grant also **relax the
seatbelt** for the paths it named, so an approved read runs inside the sandbox
with just those files readable.

The branch/PR should hold this PR's current state for where the sandbox doesn't
apply, and land this relaxation to reach parity: the same read UX on macOS and
everywhere else.

## Why a seatbelt relaxation is possible and safe

- `workspaceSandboxOverlay` is built per spawn (`spawn.ts`), and `spawn.ts`
  already accepts an optional `sandboxConfig` override (`opts.sandboxConfig`).
  `portBindingSandboxOverlay` (`config.ts`) is the existing precedent: it starts
  from `workspaceSandboxOverlay` and relaxes one axis (loopback binding) under an
  explicit per-workspace grant. Read relaxation is the same shape on the
  filesystem axis.
- macOS seatbelt is deny-then-allow: a **more-specific `allowRead`** under a
  `denyRead: [homedir()]` overrides the broad deny for exactly those paths — the
  same mechanism `gitConfigReadPaths()` and the chat-store read already rely on.
- Because each command builds a fresh overlay, a per-command grant is naturally
  ephemeral: no relaxation can leak into a later command that wasn't granted it.

## Design

### A relaxed overlay for granted reads

Add a filesystem relaxation that, given a set of read targets, returns an overlay
with those targets added to `allowRead` (and nothing else widened):

```ts
// project-sandbox/config.ts
export function readAllowedSandboxOverlay(
  workspaceRoot: string,
  readTargets: readonly string[],
): Partial<SandboxRuntimeConfig>
```

It starts from `workspaceSandboxOverlay(workspaceRoot)` and extends
`filesystem.allowRead` with every target plus `${target}/**` for directories. It
touches nothing else — no new `allowWrite`, no network. Mirrors
`portBindingSandboxOverlay`.

### Route the granted command to the relaxed overlay

`runShellOnce` / `spawnShellInProjectSandbox` need to pick the overlay. The
cleanest seam: `resolveReadOutsideProject` already returns the granted status —
thread the resulting targets to the spawn. Concretely:

1. `checkShellPermission` / the shell tool ask the gate; when
   `analyzeReadOutsideProject` is eligible **and** the thread holds the grant
   (`hasReadOutsideProjectGrant`), the gate returns `allow` **and** returns the
   granted `targets`.
2. The shell tool passes those targets into `spawnShellInProjectSandbox` as a
   `readGrant` option.
3. `spawnShellInProjectSandbox` uses `readAllowedSandboxOverlay(cwd, targets)`
   instead of the plain `workspaceSandboxOverlay(cwd)` for that one spawn.

The first-time prompt (no grant yet) keeps today's flow: the user is asked, the
grant is stored, and the _current_ command can be re-evaluated with the grant so
it runs relaxed immediately rather than only on the next occurrence.

An important ordering guard: this must only fire when the decision's routing is
the sandboxed/contained path. A command that is genuinely `external` (network
needed) still runs unsandboxed as today — the read relaxation is not a network
or full-escape lever.

### Unrelaxed paths that must not widen

- **Writes stay out.** The relaxation adds `allowRead` only. A grant that would
  let a later _write_ to a granted path still prompts normally.
- **Credential and breadth checks still apply.** `sensitiveTargetReason` /
  `breadthBlocker` already refuse `.env`, `~/.ssh`, `~/.aws`, the whole home dir,
  and the filesystem root at eligibility time — those never reach the overlay.
- **Recursive reads keep their caveat.** A granted directory read can traverse
  into a file that would have been refused as a direct target. The prompt's
  warning already states this (it is unchanged); the relaxation must not silently
  widen a recursive grant beyond what the prompt described.
- **Not a blanket "no sandbox".** No path rejects the seatbelt; the relaxation
  only narrows the read deny for named targets.

### Eligibility, once containment exists

The shape allow-list and the seatbelt were proving the same thing twice. Once a
command is going to run contained, the checks that exist to show _from the text
alone_ that nothing but a read can happen are redundant — the kernel shows it
directly — so `analyzeReadOutsideProject` takes `contained` and drops two of
them:

- the **head allow-list** (`READ_ONLY_SHELL_BASENAMES` / `EXTRA_READ_ONLY_HEADS`),
  the main source of prompt fatigue: an unknown binary under the overlay reaches
  the named paths, the workspace, no network, and no outside write;
- the **exec flags** (`find -exec`, `fd -x`, `rg --pre`), whose child inherits
  the same seatbelt.

Everything else holds unconditionally, for reasons that survive containment:

- **Target checks** (`sensitiveTargetReason`, `breadthBlocker`) decide _which
  paths the overlay opens_. The overlay is built from this analysis, so they are
  the only thing between a named `~/.ssh/id_rsa` and an `allowRead` rule for it.
- **Write checks** (write flags, redirects, non-read `git` subcommands) stay
  because the seatbelt permits writes _inside the workspace_ — a contained
  `sort ~/x -o out.txt` really writes, and the prompt's footer says approving
  grants no writing.
- **Wrappers and expansions** (`sudo`/`env`/`xargs`, `$(…)`, `$VAR`) stay: they
  make the target derivation itself unsound, and the overlay is derived from it.

Relaxing heads widens what reaches the analysis, so the containment it assumes
must be real for the whole command: `contained` additionally requires
`externalOnlyForOutsidePath`, the same predicate the execution half applies.
Without it an unrecognised head carrying a URL (`curl https://x --config
~/.curlrc`) would read as a plain out-of-project read, and the tool — which
declines to contain a network command — would then run it fully unsandboxed on
that answer. That guard also keeps `find -exec` refused (it reads as dynamic
execution), so the flag relaxation is the belt and this is the braces.

The relaxation is scoped to the **up-front gate**, where approving means a
contained run. The post-failure "Run outside sandbox?" path passes
`contained: false`: approving there drops the very containment the relaxed checks
lean on.

### Decision-logging parity

The durable decision log (`decisions.jsonl`) already records `scope: external-read`
with `remembered` and the paths at stake. The relaxed run should keep that scope
and source (`read-outside-grant`), and should record the seatbelt relaxation as a
first-class fact rather than only via the prompt answer — so an audit shows both
that read access was granted and which paths the sandbox was actually widened to
for that command.

## Alternatives considered (and rejected)

- **Welcome the full unsandboxed retry.** That is the status quo; it contradicts
  the read prompt's "does not allow ... network access" wording and is exactly the
  fatigue/scope creep this follow-up removes.
- **Make the whole workspace unsandboxed for a granted thread.** Too broad; a read
  grant says nothing about writes or network. This would silently remove the only
  boundary the sandbox provides.
- **Classify read targets and pre-allow them in every overlay.** A static allow of
  common home paths in `workspaceSandboxOverlay` would grant reads that were never
  approved, and would undo the deliberate "deny home reads" default.

## Risks / open questions

- **Prompt → run gap:** bridging the first-time prompt to a relaxed current-command
  run adds gate→tool plumbing (`resolveReadOutsideProject` returning targets, the
  shell tool threading them into the spawn). Needs the same
  "gate and tool agree" guarantee that `routeShellCommand` / `shellRunsOutsideSandbox`
  currently provide — the decision and the execution overlay must come from the same
  raw command analysis.
- **Sandbox-fs-client parity:** `sandbox-fs-client.ts` (the read gateway for
  `fs:*` IPC) uses `fsWorkerSandboxOverlay`; reads there are separate from
  `run_shell`. Relaxation scope should be explicit about which surface it affects
  (shell commands only) and whether the gateway needs the same treatment later.
- **Symlink/canonicalization:** `canonicalizeWorkspaceRoot` collapses symlinks for
  the workspace root; granted home targets (`~/foo` → `/Users/me/foo`) should be
  canonicalized the same way or the `allowRead` may not match the kernel path.

## Out of scope (separate follow-ups)

- Relaxing **writes** to a granted area (a write grant would need its own shape,
  prompt, and threat model — track separately if wanted).
- Persistent, cross-restart read grants (today the ledger is in-memory and dies
  with the process; that is a deliberate property, not a gap).
- Applying relaxation to the `fs:*` read gateway (see Risks).

## What was actually built

### Correction: the failure was worse than this plan described

The plan assumed an approved read ran through `spawnShellInProjectSandbox` under
the unrelaxed overlay, got denied by `denyRead: [homedir()]`, and was then offered
the escape. Reading the code, that is not what happens on the up-front path.

`analyzeShellCommand` returns `external` for **any** out-of-workspace path, so
`shellRunsOutsideSandbox` is already true before the command is spawned, and
`run_shell` routes it to the plain `/bin/sh` branch. The approved read never met
a seatbelt at all — it ran with full writes and full network, silently
contradicting the prompt's own footer ("It does not allow writing, installing, or
network access"). The escape was not a fallback after a denial; it was the first
and only thing that happened. The retry path (`maybeRetryUnsandboxed` →
`promptUnsandboxedShell`) had the same ending by a different route: the standing
grant answered the escalation with `true`, and the retry ran unsandboxed.

The plan's conclusion was right and its fix is the right fix. Only the mechanism
in "The gap this follow-up closes" was wrong, so that section has been trimmed to
what the code actually does.

### The seam, and why no gate→tool plumbing was needed

The plan's main open question was how to thread granted targets from
`resolveReadOutsideProject` through to the spawn without the decision and the
overlay drifting apart. That plumbing turned out to be unnecessary.

`analyzeReadOutsideProject` is a **pure function of the raw command and the
execution root** — the same two inputs the shell tool already has. So the tool
re-derives the targets itself, exactly as it already re-derives the
sandboxed/unsandboxed split through `shellRunsOutsideSandbox`. Nothing is passed
between gate and tool, so there is nothing for them to disagree about.

- `readOutsideProjectGrantTargets` (`read-outside-project.ts`) — the execution
  half of the analysis: resolved absolute paths when the command is an
  accountable read, else null.
- `externalOnlyForOutsidePath` (`shell-scope.ts`) — the second guard. A read
  shape that also carries any network signal, hard or fuzzy, is refused:
  containing it would break it, and a read grant is not its approval.
- `shellReadGrantTargets` (`command-routing-config.ts`) — layers the host gates:
  no sandbox means nothing to relax, and an explicitly trusted allow-listed
  command keeps the unsandboxed routing the user deliberately gave it.
- `readAllowedSandboxOverlay` (`project-sandbox/config.ts`) — one axis only, as
  planned.
- `spawnShellInProjectSandbox` takes `readGrantTargets` (paths), **not** a
  `sandboxConfig` (a whole profile) like its sibling. The caller names paths and
  the spawn builds the overlay, so the option can only ever widen reads.

### The grant is spent by containment

One case the plan did not anticipate. If a relaxed run still hits the sandbox,
`maybeRetryUnsandboxed` fires and the standing grant would have auto-approved the
full escape — reopening the exact hole this closes, now with no prompt at all.
`promptUnsandboxedShell` therefore takes `readGrantApplied`: a command already
contained with everything the grant named does not get to spend the grant a
second time on leaving the sandbox. It falls through to the real "Run outside
sandbox?" question.

### Resolved open questions

- **Symlink canonicalization** — done. Targets are `realpath`'d the way
  `canonicalizeWorkspaceRoot` treats the workspace root; a target that does not
  exist yet is canonicalized through its parent.
- **Ancestor traversal** — not in the plan, but required. Seatbelt resolves a
  path component by component, so `denyRead: [homedir()]` stops the walk before
  the leaf allow is consulted. Each ancestor is allowed as a literal path with no
  `/**`, following the `worktreeDiscoveryRead` precedent.
- **`sandbox-fs-client` parity** — still out of scope, as the plan proposed. This
  affects `run_shell` only.
