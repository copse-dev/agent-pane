# Deferred thread worktrees (prototype)

Status: **Prototype, opt-in per project** (`worktreeMode: "on-write"`). The default
(`always`) is unchanged. Extends [`thread-worktrees.md`](./thread-worktrees.md): isolation is
still decided at the first message, but the checkout is created only when the thread first
needs to write.

## Why

Every isolated thread pays for a worktree before its agent sees the prompt: a fetch of the
default branch, a set of sandboxed Git probes, and a full `git worktree add`. In this repository
(about 5,000 tracked files) `worktree add` alone took 2.0–2.3 s warm and 9.1 s cold on the
maintainer's M1 Max. It leaves a branch and a directory behind whether or not anything was
written.

On that machine on 2026-09-26, `~/.copse/worktrees` held 119 GB across 168 thread worktrees:

- **This repository (160 worktrees):** 24 were clean with no commits beyond `origin/main`.
  That means they never wrote anything, or everything they wrote was merge-committed upstream.
- **Other projects (8 worktrees):** 5 were clean and titled like questions ("tell me about what
  is happening here", "without making changes can you review this").

The saving in cruft is therefore project-dependent (roughly 15% here, most of it in Q&A-heavy
projects). The latency saving applies to every thread, because agents read before they write.

## Behaviour

At the first message in an `on-write` project, with an automatic checkout choice and a native
(non-ACP) model:

1. The policy decides `worktree` exactly as `always` does. The transaction resolves the base
   branch, including a picked branch, and persists
   `deferredWorktree: { baseBranch, requestedAt }`. Nothing is allocated, and the project
   checkout is not switched.
2. The turn resolves a `ThreadExecutionContext` rooted at the project checkout with
   `checkoutMode: 'shared'` and `deferredWorktree` set. Consumers that only read treat it as
   shared.
3. The system prompt tells the agent the checkout is read-only and names `request_write_access`.

During a deferred turn:

- **Reads, search, git inspection, network reads, and CI/PR inspection** run against the
  project checkout, uncommitted work included.
- **`run_shell`** runs in the ordinary project sandbox profile with every checkout write removed
  (`withoutCheckoutWrites`). It keeps reads, tmp, scratch, and no network. It has no
  unsandboxed route: the expected-block escalation and reactive retry are suppressed, and
  `spawnShellInProjectSandbox({ readonlyCheckout })` throws rather than run unsandboxed or with
  the sandbox unavailable. A failing command gets a one-line hint to request write access.
- **Any tool that may write** (`toolNeedsWritableCheckout`) allocates the worktree first, in the
  tool registry before the permission gate, then runs as it would in an eager worktree thread.
  This covers edits, commits, `run_background`, preparation, unknown tools, non-read-only MCP
  tools, and `run_shell` commands routed outside the sandbox. The default is to allocate, so an
  unlisted tool costs an allocation, never safety.
- **`request_write_access({ branch_name })`** allocates explicitly and names the branch from the
  agent's description (`copse/<slug>-<id>`). The anonymous-branch rename after the title then
  leaves it alone.

On allocation, `ensureWritableThreadCheckout`:

1. Snapshots what the turn was reading: the project `HEAD` and its dirty paths.
2. Allocates through the same manager and seeding rules as an eager thread. Seeding is decided
   from fresh inspection, because the turn read the live dirty work.
3. Persists `worktree` and `gitBranch`.
4. Re-roots every bound copy of the turn at once, through `adoptUpgradedThreadExecutionContext`.
   A deferred context resolves through the upgrade map, so the loop, subagents, and the ACP
   bridge all follow.
5. Starts indexing the new root.
6. Streams a `thread_checkout` chunk so the renderer re-roots its file tree, changes pane, and
   branch chip mid-turn.

After the switch, file tools treat an absolute path into the project checkout as the same
relative path in the worktree (`setExecutionRootAliasLookup` in `workspace.ts`, registered by the
execution context and scoped to the turn's own root). Agents carry absolute paths across the
switch; without this they would get `Path outside workspace`. Shell commands are not rewritten.
In the shell, that path still reads the user's checkout, and the switch notice says so. The
rewrite applies to every worktree turn, not only deferred ones: in any worktree turn the project
checkout was never a valid file-tool target.

The model-facing result (or a system reminder on the tool call that triggered an implicit
allocation) states:

- the new root and branch;
- that the user's checkout is no longer this thread's code;
- which files differ between the commit it read and the worktree base, to re-read before editing;
- which uncommitted files it saw that were not carried over.

## Invariants

1. A deferred thread never writes the user's checkout. This is enforced at the registry
   (allocate first), the diff queue (`DEFERRED_CHECKOUT_BLOCK_MESSAGE`), and the sandbox profile
   and spawn guard.
2. Nothing in a deferred turn runs unsandboxed against the user's checkout.
3. When in doubt, allocate. Deferral may cost an extra worktree; it may not weaken isolation.
4. A thread never returns to deferred once it owns a worktree. A stale upgrade-map entry can
   therefore never misroute a later turn.
5. ACP agents, remote models, and explicit worktree choices allocate eagerly. An ACP turn on a
   thread that deferred under a native model allocates before its session sees a root.
6. Container runs refuse a deferred thread rather than snapshot the user's checkout.

## Evidence

- `src/main/project-sandbox/readonly-checkout-sandbox.test.ts`, against the real macOS seatbelt:
  - reads, `git status`/`log`, and `$TMPDIR` writes succeed;
  - overwrite, create, and commit in the checkout fail and leave it unchanged;
  - the same `touch` succeeds in the ordinary profile (positive control);
  - an unsandboxed read-only request throws.
- `src/main/services/deferred-worktree.test.ts`:
  - transaction deferral and its eager exceptions;
  - idempotent allocation;
  - the context swap across nested bindings;
  - the drift report;
  - the classifier;
  - a real-repository allocation that names the branch from the agent, carries the dirty work,
    and leaves the user's checkout on its branch with its edit.
- `src/shared/git/worktree-policy.test.ts` pins `on-write` in the policy matrix and in the
  `settledCheckoutMode` lockstep check.
- `src/main/services/tool-registry.test.ts`: in a deferred turn, a write tool attempts
  allocation before its own code runs (and fails with it), while an inspection tool runs
  untouched.
- `tests/e2e/thread-deferred-worktree.e2e.ts`: a real Electron turn against a fixture model.
  - A question turn reads the checkout, stays on `main`, and creates no worktree or branch.
  - The next turn calls `request_write_access` and `write_file`. The branch chip switches
    mid-turn to the agent-named `copse/readme-usage-abc123`. The model's tool result names its
    new worktree. The edit lands only in the worktree, and the user's checkout is unchanged.
  - Screenshots: `thread-deferred-worktree-reading.png`, `thread-deferred-worktree-writing.png`.

## Known gaps before this could become the default

- **No setting UI.** The only switch is the project's persisted `worktreeMode`, as for `never`
  today. The composer chip still previews "worktree" (the eventual truth). While deferred, the
  branch chip shows the project checkout's branch, and nothing yet says "reading your
  checkout".
- **ACP agents allocate eagerly.** Deferring them needs an ACP session to resume in a new cwd
  without losing the conversation. That is tracked separately under
  [`acp-session-continuity.md`](./acp-session-continuity.md).
- **Approval keys include the root**, so a session-scoped approval granted before the switch is
  asked again after it.
- **Live checkout, not a pinned snapshot.** The deferred turn reads whatever the user's checkout
  holds, which may move between turns. The drift report covers the switch, but not a user
  editing mid-turn.
- **Read-only shell without an OS sandbox.** On Windows every `run_shell` allocates (there is
  nothing to contain it), so deferral saves less there.
- **Real-model evidence.** No agent-loop eval yet shows how often a real model calls
  `request_write_access` first versus stumbling into an implicit allocation, or answers
  questions without allocating. That eval decides whether this is worth making the default.
