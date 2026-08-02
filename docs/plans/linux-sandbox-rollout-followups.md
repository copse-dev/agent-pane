# Linux sandbox rollout — follow-ups

**Status: Active.** The rollout itself is done and on `develop`:
[#1440](https://github.com/copse-dev/agent-pane/pull/1440) (lift the macOS-only gate,
install `bubblewrap`), [#1441](https://github.com/copse-dev/agent-pane/pull/1441)
(`seccomp=unconfined` so bwrap can create a user namespace), and
[#1442](https://github.com/copse-dev/agent-pane/pull/1442) (`socat`, which ASRT needs for
its proxy sockets). `selected-pack-browser.e2e.ts` now passes on Linux for the first time.

This document records what turning the sandbox **on** exposed, because the rollout changed
a platform assumption that a number of call sites and specs had baked in. Each item below
is independent; none blocks the others.

**Items 1 and 3 are resolved** by [#1452](https://github.com/copse-dev/agent-pane/pull/1452);
they turned out to be one bug, and both entries are kept with their wrong turns intact because
the sequence of near-misses is the useful part. Items 2, 4, 5 and 6 stand.

## Why this list exists

Before #1440, `isProjectSandboxEnabled()` was unconditionally `false` on Linux. Code and
specs written against that were correct at the time and are now wrong in ways that only
show up on a runner with `bubblewrap` + `socat` present. Anything keyed on
`process.platform` as a proxy for "is there a sandbox" is suspect — that is now a
_capability_ question, and the app degrades quietly when the capability is missing, so the
answer differs between hosts rather than between operating systems.

Two specs already hit this and are fixed on the parent branch
(`terminal-display.e2e.ts`, `thread-terminal-rename-archive.e2e.ts`): both waited for an
"Open unsandboxed terminal?" prompt that correctly no longer appears, because
`decideTerminalPermission` returns `allow` once a sandbox exists.

## 0. What #1450 changed underneath this list

[#1450](https://github.com/copse-dev/agent-pane/pull/1450) landed on the parent branch after
this list was written, and it supplies a mechanism several items below were missing: on
Linux, bwrap **materializes** non-existent mandatory write-deny paths (`.bashrc`,
`.vscode`, …) as mount points in the real checkout, and keeps them there for the lifetime of
the sandboxed process. Because the fs worker was long-lived and writable, those mount points
persisted for the whole app session — and `git status` reports them as untracked files.

The fix splits the two roles: the persistent worker gets `fsServerSandboxOverlay` (no write
mounts at all, and `requestViaServer` now rejects `writeFile` outright), while writes go
through a short-lived worker with the writable overlay, so ASRT tears the mounts down when it
exits.

For **item 3 this is a finding, not a theory.** #1450 read the shard 2 failure artifact from
run `30721442684`: `git-changes-image.e2e.ts` timed out on both attempts because git reported
**14 unstaged entries** instead of the two seeded images, the extras being exactly those
protected paths (`.bashrc`, `.gitconfig`, `.vscode`). The Changes view rerendered until
WebDriver gave up. That artifact is the evidence this document kept saying was missing — the
proxy here blocks `blob.core.windows.net`, so every CI artifact this session was unreadable,
and the whole diagnostic-instrumentation detour in item 2 exists because of that gap.

For **item 1 it remains a candidate**, and only for half of that item — see below.

One cost worth knowing about: `invokeWorker` now calls `shutdownSandboxFsServer()` before
every write, so a save costs a worker spawn and the next read pays a respawn. The only
caller is the `fs:writeFile` IPC, reached solely from the editor's explicit Ctrl+S
(`context-panel.ts:267`) — one deliberate action, not autosave — so this is bounded. It
would stop being bounded if anything batched (a diff-queue apply, a multi-file refactor)
were ever routed through `gatewayWriteFile`.

## 1. Thread worktrees are invisible to the file tree and Changes pane — RESOLVED

**Evidence.** `thread-worktree-terminal.e2e.ts` fails twice on shard 8:

```
element (".file-tree .tree-row[title=\"worktree-only.md\"]") still not displayed after 30000ms
expected the worktree-only change in the Changes pane
```

The same spec's first case — "starts a new shell in the active thread worktree" — passes,
so the worktree exists and the terminal reaches it. Only the renderer's view of it is
missing.

**What has been ruled out.** The plumbing above ASRT is correct:

- the `fs:*` IPC handlers resolve `root` through `resolveThreadExecutionContext(projectId,
threadId)`, i.e. the thread's worktree root, not the project root;
- `getOrSpawn(root)` retires and respawns the worker when the root changes
  (`sandbox-fs-server.ts`), so no stale worker serves the wrong root;
- `fsWorkerSandboxOverlay` builds on `workspaceSandboxOverlay`, which has explicit
  linked-worktree handling — `commonGitDir/worktrees`, discovery reads, nested-root denies.

So the app asks for the right path with the right overlay, and the refusal happens inside
ASRT. The likely shape is that a path-allow the macOS seatbelt expresses declaratively does
not carry over to bwrap's bind-mount model, but **that is a hypothesis, not a finding.**

**Result on `654e3cd`, and a prediction that was exactly backwards.** This entry predicted a
partial fix in one direction — Changes pane green, file tree still red — reasoning that a
missing `.tree-row` is a `readdir` the gateway refused. The run inverted it:

```
✓ lists and previews files from the active thread worktree     <- was failing, now passes
✖ shows git changes from the active thread worktree            <- still failing
```

The file tree was the half #1450 fixed. The Changes pane is the half that survived. The
reasoning above is left in place because the error is the instructive part: "empty readdir
⇒ gateway denial" treated the gateway as the only thing that could produce an empty pane,
and the Changes pane never went through the gateway at all.

**The `[sandbox-fs]` denial log fired zero times** in that job — the instrumentation added in
item 2 to diagnose this item produced nothing, because it watches a layer that is not
failing. Recording that as a negative result rather than quietly dropping it.

**What the two survivors have in common.** With the file tree green, the remaining reds are
this one and item 3, and both are _git reading git's own admin state through bwrap_, not
filesystem-gateway problems:

- the Changes pane runs `git status` in the linked worktree, which must traverse
  `commonGitDir` — objects, refs, packed-refs, and the per-worktree admin dir;
- `git-changes-image` runs `git show <blob>`, which must read objects out of the same place.

That is the hypothesis this entry already named — a path-allow seatbelt expresses
declaratively not carrying over to bwrap's bind-mount model — and it now has support rather
than being a guess. Look at `gitAdminRead` in `config.ts`: it allows
`join(commonGitDir, 'worktrees')`, `objects/**`, `refs/**`, `config`, `packed-refs` and so
on, deliberately _not_ the common dir wholesale ("sibling worktree admin state, hooks, and
config remain outside the writable surface"). Seatbelt evaluates that as predicates per
access. bwrap has to realise it as mounts, and "this directory, but only these children"
is not a thing a bind mount expresses.

It also explains the asymmetry cleanly: plain working-tree reads under the worktree root are
one straightforward mount and now work, while anything that has to walk into the shared git
directory depends on exactly the fine-grained globs that do not survive translation.

**Do not** widen the allow-list speculatively. Four hypotheses about this stack have now been
wrong in their specifics — including this entry's own prediction and #1450's reading of item
3 — and guessing here means widening a security boundary on a hunch. The next step is to
observe what bwrap actually mounts for a worktree root, not to add paths until it passes.

**RESOLVED by [#1452](https://github.com/copse-dev/agent-pane/pull/1452).** The instruction
above — observe the mounts rather than widen the allow-list — was the right call, and what it
turned up inverted the diagnosis one last time. Nothing was missing from the allow-list. The
problem was the opposite of a refusal: section 0's materialization mechanism was correct, but
it is not only _stale_ mount points from a long-lived worker that show up. A command running
under a **writable** overlay realises that overlay's `denyWrite` entries as placeholder mounts
that are visible to _its own execution_ — so `git status` reports them while it runs, and
cleanup after the process exits is necessarily too late. The protected dotfiles were never
leaking past a boundary; they were being created by one. #1450 fixed the long-lived half of
this; #1452 fixed the same-command half.

The fix is `readOnlyWorkspaceSandboxOverlay()`: read-only Git operations get an overlay with
empty `allowWrite` **and** empty `denyWrite`. Read confinement is preserved — a read-only
command cannot mutate the checkout, so an empty write allow-list is already the boundary —
and no mount points are created at all. No allow-list was widened, in the end.

This also answers "what the two survivors have in common", though not as guessed. The shared
cause is real: this item and item 3 were one bug. But it is not fine-grained globs failing to
survive translation into mounts — reads never failed. And the two were not siblings. The
Changes pane's **missing** `worktree-only.md` was a _consequence_ of item 3's **extra**
entries: the list rerendered against a moving set, so the assertion never caught the row it
wanted. "Too few" was downstream of "too many".

Scoring this entry honestly: the hypothesis that bwrap's need to realise rules as mounts is
where the asymmetry comes from was right. Every consequence drawn from it was wrong.

## 2. Bound the `[sandbox-fs]` denial logging

Added on the parent branch to make item 1 diagnosable. It logs on **every** refused
gateway op, which is unbounded: a file-tree walk against a confined worker could emit
thousands of lines.

Circumstantial evidence that this matters: the shard 2 job log on `a69a7c5` was 22,517
lines against a normal ~1,000, and `git-changes-image.e2e.ts` — previously green and
unrelated to terminals or worktrees — timed out at 90s in that same run. Neither
observation is confirmed to be caused by the logging, and the flood (if any) sits in the
middle of the log where a tail cannot reach it.

**That theory is now dead**: #1450 established the timeout's actual cause from the failure
artifact (item 3), and it has nothing to do with this log. It was always the weaker half of
the evidence — the shard 4 red in the same run carried a normal ~1,100-line log.

This branch bounds the log regardless, because unbounded per-op logging in a hot path is
wrong independent of whether it caused that timeout. See the diff. Filed on hygiene, not as
a fix — and it is worth being explicit that it never was one.

## 3. `git-changes-image.e2e.ts` 90s timeout — RESOLVED

This entry said "RESOLVED by #1450" for one revision. **That was wrong**, and the correction
is the useful part of it.

#1450's description reported the shard 2 failure artifact from run `30721442684`: git saw 14
unstaged entries instead of the two seeded images, the extras being bwrap-materialized deny
paths (`.bashrc`, `.gitconfig`, `.vscode`). That is a real observation and #1450 genuinely
fixed the mount-point leak. It was promoted here to "resolved" on the strength of it —
before any run confirmed it. The run on `654e3cd` then timed out again, both attempts,
unchanged at 90s.

**The mount-point theory is now positively contradicted, not merely unconfirmed.** On that
same shard, in the same run, `git-changes.e2e.ts` — "lists staged and unstaged changes and
shows a diff" — **passes in 3.8s**. A checkout polluted with spurious untracked entries would
have to affect the spec whose whole subject is listing changes. It does not. Whatever is
wrong is specific to the _image_ path.

**What is specific to it.** Image previews do not read blobs through the fs gateway at all;
they shell out to git:

- `git-service.ts` `readGitBlobImage` → `runGitBuffer(['show', <spec>])`
- `runGitBuffer` → `spawnInProjectSandbox('git', …, { stdio: 'pipe' })`, so under Linux each
  call is a full bwrap + ASRT proxy setup, and the command is wrapped through a shell
- it then collects **binary** stdout by hand and resolves only on `close` (or rejects on
  `error`) — **there is no timeout on that promise**

So a sandboxed child whose exit or stdout-EOF never propagates hangs the caller forever. The
observed failure is a mocha-level "execution took too long", i.e. a hang, not a wrong
assertion — which is the shape that predicts. The spec clicks three images, each needing a
before and an after, so it makes several of these calls in a row.

Also observed: **zero `[sandbox-fs]` denial lines** in the shard 2 log. The fs gateway is not
refusing anything, which is further evidence the fs worker (the thing #1450 changed) is not
involved.

**Next step.** Establish whether it is a hang or merely slow before changing anything —
those want different fixes (stdio/exit propagation under bwrap vs. a bounded timeout plus a
cheaper path than one sandboxed spawn per blob). A timeout on `runGitBuffer` would convert a
hang into a missing image, which is better behaviour regardless, but adding it first would
destroy the evidence needed to tell the two apart.

The log-flood candidate (item 2) stays **ruled out**: the shard 2 log for this run has no
repeated lines at all.

**RESOLVED by [#1452](https://github.com/copse-dev/agent-pane/pull/1452) — and the
"positively contradicted" verdict above was itself wrong.**

The mount-point family of causes was right the whole time. What this entry actually refuted
was #1450's _version_ of it — placeholder mounts left behind by an earlier long-lived process
— and it was correct to refute that, because #1450's change measured as no movement. But it
generalised from "not this leak" to "not mounts at all". The real shape is that the mounts are
created by the current command's own writable overlay and are visible to it while it runs
(see item 1). Cleanup timing was never going to fix it, which is why both #1450 and the later
lease-lifecycle attempt moved the shard-2 timeout by 0.2s: 1m31.9s against 1m31.7s.

The `git-changes.e2e.ts`-passes-in-3.8s argument does not survive either. That spec asserts on
a list that tolerates extra rows; the image path both reads blobs and rerenders per change, so
the same pollution stalls one and not the other. The severity of the symptom differed, not the
cause.

The hang analysis below is unvindicated too. `runGitBuffer` does still resolve only on `close`
with no timeout, and that is worth fixing on its own terms — but it is not what made this spec
time out. All eight shards went green on #1452 with no timeout added.

Two things this entry got right and are worth keeping. The fs gateway was correctly ruled out
— zero denial lines, and the eventual fix touched neither the gateway nor the worker. And the
instruction not to add a timeout before distinguishing a hang from slowness was sound: doing
so would have converted a loud failure into a silently missing image and buried the actual
cause under a workaround.

## 4. Reference screenshots churn on every runner rebuild

Rebuilding the runner image regenerated **195** reference screenshots, most differing by
2–5% across unrelated screens — the signature of text rasterisation shifting, not UI
change. `ci-runners/Dockerfile` pins Node and the runner agent but not the apt packages, so
any rebuild can pull newer freetype/fontconfig and move every baseline at once.

Options, roughly in increasing order of effort:

- accept periodic mass refreshes as normal, and review them by sampling rather than
  individually;
- pin the font and rendering packages in the image so baselines only move deliberately;
- render reference screenshots in a dedicated pinned container rather than on whichever
  runner picks up the job.

The middle option is probably the right cost/benefit, but this is a judgement call about
how much baseline stability is worth.

## 5. `dist.tar` is uploaded after `test:demo`

In the `build` job, `tar -cf dist.tar dist` and its upload sit **after**
`npm run test:demo`. A flaky demo browser session therefore withholds the artifact that all
eight e2e shards download, and the entire e2e tier reports `skipped` rather than running.
This cost a full ~40-minute cycle during the rollout when a chromedriver session failed to
start.

Moving the tar + upload before `test:demo` (leaving `test:demo` still failing the job) makes
the artifact independent of demo-tier flake. The trade is that a build whose demo tier fails
would publish `dist.tar`, weakening "don't publish artifacts from a failing build" — which
is why this was left alone rather than changed unilaterally.

## 6. Sweep for other `process.platform` sandbox proxies

The two terminal specs were found by CI failing. A deliberate grep for
`process.platform !== 'darwin'` and `=== 'darwin'` across `tests/` and `src/` would find any
remaining site that means "is there a sandbox" and says "is this macOS". Cheap, and the
failure mode is silent — a spec that no longer asserts what it thinks it asserts.

**But the grep is not sufficient**, and `npx-approval.e2e.ts` (fixed on the parent branch)
is the proof. It failed with `Expected: "Run package command?" / Received: "Install Socket
Firewall?"` and contained **no platform check at all**. Its assumption was implicit: `npx`
is an _ambiguous_ external matcher, so with a sandbox present it auto-runs inside one
instead of prompting (shell-scope.ts, #500 option 1) — the spec had simply never run
anywhere that had a sandbox, and its dialog arrived for free.

That is the harder half of this item, and it has no grep. The tractable version: any spec
that waits on an approval dialog is a candidate, because whether a dialog appears at all now
depends on host capability. `autoRunSandboxCommands: false` (added to `seedEmptyProject` for
the fix) is the lever that makes such a spec deterministic without asserting a platform.

Worth knowing when reading a failure of this shape: the dialog a spec catches may not be the
dialog it waited for. `#approval-dialog` is a shared selector, so when the expected prompt
stops appearing, the next unrelated prompt — here Socket Firewall, raised much later by
`prepareCommand` — matches instead, and the diff reads like a wording regression rather than
a missing dialog.
