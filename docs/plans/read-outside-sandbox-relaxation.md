# Dynamic read-sandbox relaxation (follow-up to read-access grants)

**Status: Proposed.** Design-only companion to the read-access approval work on
the `claude/read-access-sandbox-warning-xh18ei` branch. Nothing is implemented;
this plan records how the existing *prompt-level* read grant could be extended
into a real *seatbelt-level* relaxation so read commands stay contained instead
of running unsandboxed.

## The gap this follow-up closes

The read-access feature (this branch) is a **permission-gate** improvement: a
command that only reads accountable paths outside the project gets a narrower
"Allow read access outside of the project?" prompt and a thread-scoped in-memory
grant (`read-outside-project.ts` → `read-outside-grant.ts`). But on macOS with the
project sandbox active, the approval has a side effect that undercuts its own
wording:

- The grant only answers the **prompt**. The command itself still runs through
  `spawnShellInProjectSandbox` with the *unrelaxed* `workspaceSandboxOverlay`,
  whose `denyRead: [homedir()]` blocks every read under `$HOME`.
- When the seatbelt then denies the read, `runShellOnce` reports a sandbox
  violation, `maybeRetryUnsandboxed` detects it, and the command is offered the
  worst-case **"Run outside sandbox?"** escalation (`promptUnsandboxedShell`).
- Off macOS there is no seatbelt to hit, so the read grant genuinely contains the
  case; on macOS the two mechanisms fight: the user granted "read only, still
  contained" and the runner still lands on "run fully unsandboxed".

So a macOS user answering the read-access prompt still ends up with either a
blocked command or a full sandbox escape — neither is what they approved. The fix
is to make the grant also **relax the seatbelt** for the paths it named, so an
approved read runs inside the sandbox with just those files readable.

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
grant is stored, and the *current* command can be re-evaluated with the grant so
it runs relaxed immediately rather than only on the next occurrence.

An important ordering guard: this must only fire when the decision's routing is
the sandboxed/contained path. A command that is genuinely `external` (network
needed) still runs unsandboxed as today — the read relaxation is not a network
or full-escape lever.

### Unrelaxed paths that must not widen

- **Writes stay out.** The relaxation adds `allowRead` only. A grant that would
  let a later *write* to a granted path still prompts normally.
- **Credential and breadth checks still apply.** `sensitiveTargetReason` /
  `breadthBlocker` already refuse `.env`, `~/.ssh`, `~/.aws`, the whole home dir,
  and the filesystem root at eligibility time — those never reach the overlay.
- **Recursive reads keep their caveat.** A granted directory read can traverse
  into a file that would have been refused as a direct target. The prompt's
  warning already states this (it is unchanged); the relaxation must not silently
  widen a recursive grant beyond what the prompt described.
- **Not a blanket "no sandbox".** No path rejects the seatbelt; the relaxation
  only narrows the read deny for named targets.

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
