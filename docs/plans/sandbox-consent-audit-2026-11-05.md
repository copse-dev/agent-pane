# Sandbox regressions and consent parity, 5 November 2026

## Task brief

Users report that recent sandbox tightening blocks ordinary development and that asking for
permission does not reliably change the outcome. Audit the existing PR work before adding
exceptions, distinguish missing consent from missing execution support, and fix a reproducible
case without restoring broad home access.

Audited source: locally cached `origin/main`, `2f9717038` (5 November, 17:04 UTC).
The original checkout was at `4eaa5962b`; implementation uses an isolated checkout at the newer
cached base. Live GitHub API and browser access were unavailable. PR existence and merge
observations below come from local commits, branch tips and deployment commit messages;
they do not establish current review, CI, open/closed or merge status on GitHub.
This session also cannot bind loopback sockets or obtain sandbox-escalation approval; those host
constraints limit validation and are distinct from Copse's own permission implementation.

Core acceptance criteria were stated before product implementation; review added package-safety
and explicit-policy checks:

1. An approved outside background command runs outside containment in standard mode.
2. An eligible trusted-command route also works without enabling Guarded YOLO.
3. A narrow outside-read approval adds only the command's named read targets; it grants no
   writes or general network access and does not widen subsequent unrelated commands.
4. Declined and Blocked calls never reach spawn. Ordinary local tasks remain contained.
5. Existing loopback consent composes with narrow reads. Missing OS containment still prompts.
6. Background installs retain the foreground package firewall, lifecycle-script policy and
   fail-closed handling of a missing launcher.
7. Each tool's Always ask setting suppresses its trusted outside route, so execution agrees with
   the boundary the approval dialog described.

Scope: background execution routing and its existing permission UI. No new blanket grants,
agent-process escape, auto-continuation, hook response semantics or persisted settings.
Risk: high, because permission and execution routes must agree. Focused policy/spawn tests,
a focused Electron screenshot spec, the oracle and the mandatory full check are required.

## Findings and disposition

### 1. Approved background commands still run contained

**Reproduced and fixed here.** `checkBackgroundProcessPermission` already calls the shell gate,
but `startBackgroundProcess` previously set `unsandboxed` only when the sandbox was disabled or
Guarded YOLO was active **and** normal shell routing selected outside execution. Standard-mode
consent could therefore display "Run outside sandbox?", receive approval, and still launch the
same command inside containment. Existing trusted-command grants had the same mismatch.

The fix uses the same `shellRunsOutsideSandbox` and `shellReadGrantTargets` functions as
`run_shell`. The model receives no new `unsandboxed` parameter. The existing gate remains the
authority. The focused regression tests first failed on the unchanged implementation, then passed
with the fix. The OS wrapper is injected; approved outside writes use real disposable fixture
files. This proves routing, not real Seatbelt or bubblewrap enforcement.

The background path also lacked foreground package preparation. Before enabling its approved
outside route, the existing preparation is shared between both runners so background installs
do not lose the package firewall or JavaScript lifecycle-script suppression. Authorization and
metadata still use the raw command; only the spawned command is wrapped.

Review also reproduced an existing foreground mismatch between Always ask and trusted-command
routing: the gate suppressed trusted auto-approval, but the runner could still select the trusted
outside route after a contained prompt. Shared routing now honors the selected tool's explicit
override. The background regression and tests cover this before enabling standard outside runs.
A later review found the gate still routed a background start on `run_shell`'s setting while the
runner used `run_background`'s, so Always ask on `run_shell` alone hid a trusted background escape
from the gate's decision record and from Guarded YOLO's tier screening. The gate now routes on the
tool being run; regressions in `background-command-routing.test.ts` and `tier-screening.test.ts`
failed before that change.

### 2. Background tasks cannot explicitly request a runtime escape

**Still open; separate follow-up.** The `run_background` schema has no `expects_sandbox_block`.
Its runner also lacks `run_shell`'s verified-failure retry and operation-denial cache. An opaque
local script that discovers a network, device or filesystem need only after startup can still
fail with no equivalent background consent path. The fix in this branch covers routes already
approved by the ordinary shell gate; it does not close this larger gap.

Add a shared, host-owned escalation decision for foreground and background starts. Preserve
exact raw-command approval, cancellation, tool overrides, thread ownership, worktree allocation
and package policy. Do not silently restart a partially completed task or create a second
completion wake. A failed task should offer a new approved attempt with an explicit task identity
or a suitable up-front request. This needs lifecycle tests before implementation.

### 3. An ACP private shell cannot leave the agent-process sandbox

**Confirmed architectural limit.** `respondToAcpExecutePermission` returns an ACP option after
the shell gate; it does not own the command's spawn. The agent then executes under the same
spawn-time Seatbelt/bubblewrap boundary. Approving `dangerouslyDisableSandbox`, or a Codex
escalation request, cannot remove that inherited outer boundary.

The existing solution is a host-owned execution path, not more approval options:
[PR #4014](https://github.com/copse-dev/agent-pane/pull/4014) routes ACP `terminal/*` through
the real native `run_shell` gate and runner. Bridged MCP `run_shell` uses the same route.
Both can obtain an outside execution after consent. The adapter must actually use one.
Do not execute a command in the permission callback and then also return `allow_once` to an
adapter that will execute it again.

[PR #4153](https://github.com/copse-dev/agent-pane/pull/4153), cached tip `8b49d4521`, refuses
Claude's ineffective private-shell escape and points at the bridge. It is useful recovery
guidance, not a generic execution broker for every ACP agent. Its commit is absent from the
audited main base. Adapters without a usable bridge/terminal path still lack parity.

### 4. A missing bridge looks like a sandbox problem

**Existing work; do not duplicate.** Issue #4142 has two relevant cached branches:

- `c016b6cc6`, for #4144: verify that the agent called `tools/list` before claiming Copse tools
  are mounted; show the unavailable state and suppress unusable guidance otherwise.
- `f60c81240`: clear only Copse's stale entry in Claude's thread-owned MCP authentication-failure
  cache before starting a fresh bridge. User-selected configuration directories stay untouched.

These are absent from the audited base. A configured MCP URL is not proof that the adapter
connected. Without the bridge, steering the model to `mcp__copse__run_shell` cannot recover
access. Test cold start, resumed session, killed agent, expired bridge and disabled tool.
No additional filesystem or domain exception repairs a missing tool transport.
Cached branch `e35d1761b` also addresses displaying proposed-thread approvals over the source
conversation. Check that existing work before diagnosing an unseen prompt as a hard sandbox deny.

### 5. Native file/search tools do not use shell outside-read consent

**Confirmed gap; older draft exists.** Native `read_file` and `list_dir` resolve paths through
workspace guards. Search tools are similarly root-bound. A standing shell read grant does not
make those tools accept an outside path, and their handlers do not offer the same read prompt.

[PR #3869](https://github.com/copse-dev/agent-pane/pull/3869), described as draft in #4109's
merged commit, addresses external native reads. Its implementation is absent from the audited
base. The cached branch carries unrelated historical changes and needs careful refresh; port the
scoped reader rather than replaying the entire stale diff. In particular, preserve the current
prohibition on recursive ancestor read grants. Test symlinks, root identity replacement,
credential targets, conversation-store access and revocation.

### 6. ACP file callbacks are a separate outside-read gap

**Confirmed by source.** `readTextFile` in `acp-agent-service.ts` uses `resolvePathWithinRoot`
followed by `fsp.readFile`. It is distinct from native `read_file` and from the shell grant path.
Finishing #3869 alone does not automatically give `fs/read_text_file` the same consent behavior.
Route this callback through the same bounded, host-owned scoped reader once that reader is
available. Keep outside writes on a separate exact-operation approval path.

### 7. Closing whole-home access exposed legitimate runtime dependencies

**Known compatibility risk, not evidence to reopen home.**
[PR #4109](https://github.com/copse-dev/agent-pane/pull/4109), merged into the audited base,
removed an accidental recursive home read grant. Its commit explicitly calls out custom agent
installs such as `~/.npm-global/bin` as a possible compatibility regression. The permitted base
now consists of workspace/toolchain paths plus explicit per-agent state and auth locations.

Reproduce each failing install layout before changing the preset. If an installed agent cannot
read its executable/package runtime, add the narrow canonical runtime path read-only, with
symlink and whole-home guards. Adding it to `homeDirs` would grant writes as well, so it is not
the right generic runtime exception. Credential directories require their own deliberate auth
capability; unrelated project data should use scoped consent.

### 8. Temporary-directory disagreement is a real configuration regression

**Existing fix; do not duplicate.**
[PR #4152](https://github.com/copse-dev/agent-pane/pull/4152), cached tip `a73780a29`, pins
ASRT's wrap-time `CLAUDE_CODE_TMPDIR` in every process initializing `SandboxManager`.
Setting only the child's environment was insufficient because ASRT baked a different `TMPDIR`
into its wrapped command. The branch includes an actual-ASRT test and is absent from the audited
base. This should use the existing writable scratch capability, not request extra user consent
or make all of `/tmp` writable.

### 9. GitHub auth/config denial is different from network denial

**Existing mitigation; partial.**
[PR #4150](https://github.com/copse-dev/agent-pane/pull/4150), represented in the cached preview
history by `335ea4691`, improves guidance when private `gh` cannot read `~/.config/gh` after
#4109. Prefer host-owned `gh_pr_*`, `gh_api_read`, CI tools and `git_fetch`; these already use
the host's authorization and controlled request construction. Opening `api.github.com` alone
does not make the private agent's credentials readable.

For unsupported operations, use the host shell's exact-command consent. Granting the private ACP
process session-wide egress is a different capability from approving one operation. Required
model/auth endpoints may need narrow preset updates supported by an actual failure; blocked
telemetry or a convenient CLI is not sufficient evidence for broad wildcard egress.
The separate [PR #4151](https://github.com/copse-dev/agent-pane/pull/4151), cached as `2574e610a`,
identifies Claude's failed organization check as a stale sign-in. That needs auth recovery rather
than a broader sandbox exception.

### 10. Retry leases reduce prompts only after an execution route exists

**Existing foreground work; not a fix for every route.**
[PR #3905](https://github.com/copse-dev/agent-pane/pull/3905), merged, offers bounded exact-command
outside retries after a verified sandbox block. Cached
[PR #4117](https://github.com/copse-dev/agent-pane/pull/4117) extends script retry grants to
different arguments under a task-scoped proof; its `a11948249` implementation is absent from
the audited base. Neither grants a private ACP child a new spawn context, adds a background
request field, nor authorizes native file tools.

Do not solve repeated prompts by letting an ACP `execute` approval remember every command of
that kind: #3996/#4068 deliberately removed that authority. Preserve explicit Blocked/Always ask,
hook and read-only policy, cancellation and unattended-container restrictions.

## Consent decisions

| Need                                                               | Appropriate authority                                               | Ask again?                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Same exact outside background command just approved                | Honor the existing shell decision                                   | No second consent merely to make the approved route work                               |
| Accountable read of named non-credential paths                     | Thread-scoped read grant and per-spawn read overlay                 | New paths or invalidated identity ask again; no writes/network                         |
| Opaque task needs broader host files/processes/devices/network     | Exact-command outside execution, or a narrower supported capability | Yes, unless covered by an explicit valid grant/lease                                   |
| Local dev-server listener                                          | Separate loopback-only binding grant                                | Existing project consent may apply; no general egress                                  |
| Agent executable/runtime cannot load                               | Narrow read-only runtime dependency after reproduction              | No new data consent for an already selected installed runtime; broader data still asks |
| Agent login/refresh endpoint                                       | Named per-agent auth/network capability                             | Changing session-wide access needs an explicit settings/consent decision               |
| Another conversation, credential, outside write or host GUI        | Its existing operation-specific gate                                | A file-read grant or ordinary Always allow is insufficient                             |
| Tool explicitly Blocked, hooks deny, or policy forbids host escape | Explain that policy; keep the refusal                               | A generic request for more permission must not bypass it                               |

## Follow-up PR order

1. Land the already prepared bridge availability/cache and scratch fixes after their required
   runtime evidence. Review #4153 as a Claude-specific explanation and recovery improvement.
2. Land the focused background approval-routing fix with real sandbox/Electron evidence.
3. Refresh #3869 and extend its scoped reader to ACP filesystem callbacks.
4. Add background up-front escalation and explicit failed-task recovery through a shared host
   decision. Test native calls, bridged calls and ACP terminals against the same consent matrix.
5. Test real adapters on macOS/Linux plus Windows/SSH prompt behavior. Only add narrowly
   reproduced runtime/auth exceptions; retain the whole-home restriction.

## Validation record

The focused regression uses the real permission gate and background runner with injection at the
OS sandbox wrapper. The Electron case is added to `outside-sandbox-approval-copy.e2e.ts` and must
both create the outside fixture file after approval and capture the existing consent dialog.
Final command results and remaining host/runtime gaps are recorded in the PR handoff.

Final local results:

- `pnpm run check:local`: passed, including all type checks, type coverage, lint, format,
  reachability, oracle, exclusion inventory and accessibility baseline checks. The existing
  exclusion inventory still reports reviews due; this is not a waiver for missing coverage.
- `pnpm test -- background-command-routing prepare-shell-command background-process
  supervised-background-process shell-tool safe-install package-firewall-launcher permission-platform
  command-routing-config read-outside-grant acp-terminals src/main/services/security/permission-gate.test.ts`:
  324 tests, 323 passed, 1 skipped, no failures. The first background regression run failed four
  routing cases before the fix; the additional Always ask case also failed before its fix.
- `pnpm run build`: passed on the final product source.
- `pnpm run check`: an earlier candidate passed all static gates, then its full unit run encountered
  blocked fixtures and stopped making progress; it was interrupted. This is **not** a full-check
  pass on the final source. A clean-base rerun of `build-invariants`, `ci-workflow-invariants`,
  `screenshot-hydration` and `acp-terminal-loopback` gave 141 passes and 20 failures, confirming
  pre-existing fixture failures including denied loopback listeners and native execution.
  The other broad-run failures have not all been triaged.
- `pnpm run test:e2e -- --spec tests/e2e/outside-sandbox-approval-copy.e2e.ts` and
  `pnpm run test:e2e:markdown`: both stopped during baseline hydration with `ENOTFOUND` for the R2
  baseline host, before Electron launched. No screenshot was captured or visually reviewed.

Use the repository's **draft/cloud-validation exception** for this handoff: focused checks and the
final local static gate passed, but the required full unit, real-sandbox and visual evidence remain
deferred. GitHub/network access is unavailable, so there are no cloud run links and no claim of
completed cloud validation. Keep the proposed PR draft until the required full check and focused
visual/runtime evidence pass. No independent review has been performed.

The initial handoff remained staged because the local signing key and SSH agent were unavailable.
Publication now uses the connected GitHub service, and the changes were rebased onto main
`e51f15b2089a7e28cbab57126ac1b609c24fc41b`, which includes #4153. The audit and initial validation
above remain a record of the original `2f9717038` baseline; the PR description pins the published
source and records its updated validation and outstanding cloud/runtime gates.
