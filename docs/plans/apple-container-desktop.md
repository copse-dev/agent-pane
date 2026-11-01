# Isolated Copse desktop through Apple container

**Status: experimental native and ACP implementation; acceptance remains incomplete.** The host-child prototype is
parked in draft PR #4118 (commit `8db459469`). This work starts from `origin/main` and does
not carry forward its host Copse-control exception or warning-window UI.

## Safety contract

Assume the agent completely controls the child and approves every dialog. Every resulting
GUI action, shell command and subprocess must remain within the disposable guest. A fresh
profile or temporary working directory on the host is insufficient. There is no automatic
Docker, shared-kernel or host fallback for this path.

The intended desktop is Linux Copse in Apple container's per-container VM, not a macOS VM.
Host Copse and unrelated host applications remain unavailable to guest GUI input. No home,
credentials, SSH agent, engine socket, display socket or execution broker is mounted or
forwarded. Direct host and external networking is disabled. Future model inference needs a
bounded, explicitly reviewed channel using the existing host-inference design; arbitrary
host commands must never be part of that channel. Inputs and exported artifacts need their
own explicit transfer policy.

## First slice: containment preflight

`pnpm run probe:apple-desktop --image copse-worker:local --dry-run` prints its plan.
Remove `--dry-run` to create a short-lived probe from an existing Linux arm64 worker image.
Use `--help` for report output and deadline options. This needs the installed Apple container
CLI and its running service. It neither installs a system package nor starts a service.

The preflight reuses Copse's Apple engine detection but pins the engine to Apple. It creates
an unprivileged guest with a read-only root, dropped capabilities, resource limits and only
a private `/tmp` tmpfs. **No host directories are mounted at all.** It overrides the worker
entrypoint with `setpriv --no-new-privs` and a fixed Node probe. The host decodes `container
inspect` before start and refuses missing restrictions, forwarding, network attachments,
extra mounts, duplicate mounts or unexpected resources. Guest output is bounded and parsed
with a schema. Teardown runs on failure, cancellation and timeout; success is emitted only
after teardown succeeds.

Observable acceptance:

- Dry-run and help never contact an engine; unavailable Apple refuses without fallback.
- Inspect configurations with a host mount, network, privileged uid, added capability,
  SSH forwarding, nested virtualization or published socket refuse before guest start.
- A real guest reports uid 1001, no-new-privileges, no capabilities, read-only root, no
  virtiofs/9p host mounts, only loopback networking and no ambient credential variables.
- Scratch writes and a guest loopback connection succeed as positive controls; an external
  connection fails with an unreachable-network error. A timeout is not a passing denial.
- No report is accepted or published as success if a field fails or teardown fails.

This is a configuration and observation preflight, not proof against hypervisor escapes or
malicious images. Use a trusted Copse worker image. Existing container-runtime security
residuals in `thread-in-container.md` still apply. Image identity pinning, orphan reconciliation
and resource-exhaustion probes remain necessary before treating this as a product boundary.

## Experimental desktop smoke (validated prototype)

Observable acceptance: the real Linux Copse window maps at 1280×800, accepts a guest-only
Tab key, returns a bounded PNG over stdio, and the VM is deleted before the host saves
successful evidence. A screenshot alone does not establish DOM correctness or agent behavior.

- `pnpm run build` produces the branch app bundles.
- `node scripts/build-apple-desktop.mts` builds `copse-desktop:local` from explicit staging
  roots, the lockfile, Linux runtime dependencies and the preflight-tested worker base.
  Host `node_modules`, hidden files and symlinks are excluded or refused. No profile is copied.
- `node scripts/run-smoke-apple-desktop.mts` bundles the current branch controller, transfers
  it over bounded stdio into the guest, checks inspect before execution, and writes
  `.tmp/apple-desktop.png` only after successful teardown. Controller changes need no image
  rebuild. The transferred code executes only in the disposable guest.

The controller owns its Xvfb display and fresh `/tmp/copse` profile. It waits for renderer
DOM readiness before declaring the desktop ready and again before capture. Fixed screenshot/input
commands travel over stdio; no port, host X socket or clipboard is forwarded. Electron's
`--no-sandbox` is confined to this already isolated VM; this is never a host launch path.
The image has no model credentials or inference channel. The GUI may display normally while
model calls remain unavailable. Bounded request validation, build staging and link refusal
have focused unit coverage. The branch app build passed. After the background sandbox
blocked Apple container access, the user built `copse-desktop:local` successfully in host
Terminal (Linux arm64, 203.7 seconds). This includes the locked dependency install and
Linux native-module rebuild. Run `copse-desktop-probe-14b527dd-6c4c-4564-9ceb-7243ca37095d`
then found a window titled Copse, completed guest input and PNG transport, and deleted the
VM successfully. Visual inspection of `.tmp/apple-desktop.png` showed only the top bar and
empty workspace: the old smoke captured before renderer readiness, so this is a partial
startup result, not a visual pass. The controller now waits for a visible composer or first-run
setup dialog at the expected viewport over guest-loopback CDP. That port is never published.
The first strict run reached setup readiness, but then the smoke's Escape key dismissed
that dialog and wrongly required a composer in a profile with no project. The smoke now
uses Tab and accepts the normal welcome screen as well. These corrections have focused
coverage. On 2026-11-01, corrected run
`copse-desktop-probe-84e60e8d-fb64-4ff1-a7cc-a633781891ba` exited successfully,
reported title Copse and completed teardown. Visual inspection of the resulting
`.tmp/apple-desktop.png` confirmed the fully rendered first-run setup at 1280×800,
with visible keyboard focus on Scan environment after Tab. The DOM readiness assertion,
guest input, bounded PNG transport and VM deletion passed. This is developer-prototype
runtime evidence from before the product integration below.

## Product integration acceptance (2026-11-01)

- Starting an isolated desktop requires a fresh approval through the existing approval UI.
  The grant belongs to the invoking project/thread and never authorizes host GUI control.
- Screenshot, click, type and key actions reach only the owned VM; a different thread cannot
  address it. Requests are serialized, bounded and timed out; protocol failure revokes it.
- Stop, parent cancellation, expiry and application shutdown revoke input and model access
  before force-deleting the VM. Failed deletion remains visible and can be retried.
- Model inference uses a host-pinned provider with token/time limits. Guest-selected URLs,
  credentials and arbitrary host operations are unavailable through that channel.
- Unit tests cover ownership, cancellation during startup, protocol failures and revocation;
  focused real-runtime evidence must exercise the integrated tool before completion.

## Product implementation and pending validation

The implementation adds the `isolated_copse` tool, a thread-owned session service,
fixed Apple VM transport, and a private guest Unix-socket relay to the existing
host-inference protocol. Start requests fresh consent naming the pinned model and
100,000-token/15-minute limits. Input is serialized and bounded. Parent cancellation,
Stop, blocking the tool, thread cleanup and shutdown revoke authority before deletion;
failed deletion is retryable. Guest provider selection refuses every other model.

Seven new lifecycle tests pass, covering ownership, startup cancellation, malformed
messages, late replies, corrupt PNGs and failed-deletion retries. The 33 existing desktop
and inference tests also pass. Node TypeScript passed after these changes. The focused
approval WebdriverIO spec passed on the user's macOS host, as detailed below.

The registry import/registration and standalone guest bundle are now on disk. The integrated
branch build, all TypeScript checks and type-coverage gates passed. A focused desktop run
passed all 23 new Apple build, preflight and lifecycle tests; three Android transport tests
were cancelled because the sandbox denied their loopback fixture (`listen EPERM 127.0.0.1`).
The oracle reports broad coverage. All static gates passed across the full-check run
`dcf91800-1aa6-44ff-80cc-8d820f81f014` and focused exclusion/accessibility follow-up after
recording the macOS-only spec in the exclusion inventory. Shutdown now awaits VM deletion
within the existing quit deadline instead of allowing normal app exit to race it.

Full unit task `fa0759a4-ae9b-4bde-9e34-e48abeebd875` reached its 30-minute deadline.
Its saved report lists 16,269 passed, 70 failed, 11 cancelled and 31 skipped tests; the
worktree-manager suite consumed approximately 26 minutes. Logs include explicit sandbox
filesystem/process denials, but these are not established as baseline-only failures.
The full gate is not green. Evidence is `.tmp/apple-desktop-unit.log` and generated tests
under `.tmp/test-run-qcqPnO`. The new lifecycle suite passed within this full run.

The report also caught three change-related integration omissions: workspace-package import
boundaries, the smoke-inventory entry for the new service directory, and an ACP exposure
decision for the new tool. Focused revalidation passed the inventory assertion and ACP
exposure decision. All eight workspace-package invariant tests passed after correcting all
five prototype imports. Two small-gate empty-diff assertions still fail (`full` versus `skip`);
the test fixture sets `BASE_SHA=HEAD` and assumes an empty diff, but
`changedFiles` intentionally includes staged, unstaged and untracked files. This dirty
checkout therefore selects full coverage. That explains the local assertion mismatch;
a clean-checkout baseline has still not been run. The tool was initially native-only. The ACP bridge now binds desktop lifetime to the
captured owning turn/session, independently of the individual HTTP response. Bridged starts
require an explicit host model choice and still use the fresh non-rememberable approval.
A real HTTP bridge test checks response closure, turn cancellation and session cancellation;
its result is pending validation below.

On 2026-11-01 at 17:12 UTC, the user ran
`pnpm run test:e2e -- --spec tests/e2e/isolated-desktop-approval.e2e.ts` on the macOS host:
one spec passed, with the test taking 2.4 seconds. This exercises the real registered tool
and consent UI with a scripted mock turn, verifies the VM/model/budget disclosures and
non-rememberable grant, then rejects consent and completes the mock turn. It does not start
a VM. Screenshot `tests/e2e/screenshots/isolated-desktop-approval.png` was inspected: the
controls were visible, but the budget and stop instructions extended below the scrollable
body viewport. The copy was shortened with the model and budget first, and the spec now asserts the
entire body fits without scrolling. The final six-line copy passed the user's macOS run
at 17:21 UTC: one spec passed in 3.1 seconds, exit 0, WebDriver session
`ed99c391361d8495dae7a3712b874ccb`. Visual inspection of the resulting screenshot confirms
all six disclosure lines and both decision buttons are readable without clipping or
scrolling; no remember control is shown. This is a visual pass for the mock-driven
consent/rejection journey. Final build task `72fa3a3c-c8a5-4d5c-8c93-13e027448630` passed;
e2e typecheck passed in `00a87850-4464-4a98-a101-a3ddbaa77625`. Agent-side Electron launch
remains blocked by sandbox process/socket denials.

Product transport VM smoke passed on 2026-11-01 through
`node scripts/run-smoke-isolated-desktop.mts`, using the real `DesktopSession` and
`AppleDesktopTransport`. VM `copse-desktop-probe-7f052846-9216-4dfa-8865-bdcf197f8dc5`
reported title Copse, rejected another thread's access, acknowledged Tab, returned a
validated screenshot, revoked authority on parent cancellation and completed deletion.
Evidence `.tmp/isolated-desktop-transport.png` was visually inspected: the complete setup
screen includes the Approved parent session model provider. The harness refuses all model
requests, so this does not establish inference. It bypasses the consent service; the
consent/rejection journey has separate e2e evidence above.

Preparing that smoke exposed a guest-settings path defect, now corrected using
`copseUserDataDir`: settings belong under `/tmp/copse/user-data/`, not the profile root.
Build, all typechecks and all 31 focused desktop/package tests passed in task
`dc3d8e34-9120-4174-b99d-79a2687cd7f8`. The guest image was subsequently rebuilt
successfully with the current embedded app (image manifest
`sha256:439964b46b94546926aadba20853e85f89c13413d233a0e9a5003793ea0319d9`).

Static task `6502e33f-129b-4907-9805-2ea5739d39c9` passed syntax, all typechecks
and type coverage, then found two lint errors in the new smoke script. Both were fixed.
Resuming from lint in task `f2487a30-d703-41c7-bbda-f4c4c4f354ec` passed all lint shards,
formatting, demo-site consistency, dead-code reachability, oracle invariants, exclusion
inventory and accessibility-baseline checks. The full unit gate remains unresolved as
described above; static success does not waive it.

Real VM relay smoke `copse-desktop-probe-3001f137-3434-45cb-816e-d69a7c0c10ca`
passed through the product transport with a fixed mock host provider. A separate, fixed
guest fixture used the product guest provider to receive text, usage and completion over
the private socket and stdio relay. The host observed exactly one request and a positive
bounded token allowance. A freshly generated host canary existed during inference and
was absent at the same absolute path inside the guest. Parent cancellation revoked input
and VM deletion completed before evidence was saved. No real provider credentials or
model spend were used. A subsequent fixture revision explicitly requires uid 1001.
Its first run printed the success report for VM
`copse-desktop-probe-2b6e4b81-787a-440e-a532-43f226699453`, but the outer command
returned 143; that run is not counted as a clean command pass. A fresh run with
the same uid-1001 fixture, VM
`copse-desktop-probe-f9321807-d338-4ad7-ad5b-bbf267fae0ef`, completed with exit 0
and all relay, canary, ownership, revocation and teardown assertions passing. Task
`29bb0334-2017-46e0-beae-103fada02579` passed all typechecks, all 31 focused
desktop/package tests and formatting after the fixture changes.

This fixture is transferred through developer-only `container exec`;
it does not add a product command surface.

The `--gui` fixture now drives the guest renderer over guest-only loopback CDP.
It dismisses first-run setup, creates a fresh project through New Project, submits
a composer prompt and requires the mock response inside an assistant message. The host
asserts that the submitted prompt reached its pinned provider. Optional first-run agent
package installation is rejected; the fixture waits for no approval overlay and no
visible Stop button before capturing the result. VM
`copse-desktop-probe-4bacb60c-5b0f-411c-87cb-fb139b17dc0d` passed with exit 0.
Visual inspection of `.tmp/isolated-desktop-transport.png` shows the project, submitted
prompt and assistant response without an overlay. Ownership, canary absence, parent
cancellation and VM deletion also passed. This establishes a child GUI turn through the
mock host inference channel, without provider credentials or paid inference.

Approved tool-to-VM execution, self-approved child command
containment and orphan recovery remain outstanding. The canary observation above tests
a fixed guest fixture, not child-agent self-approval. No completed product feature or
merge readiness is claimed.

## Hardening and acceptance work in progress

The image builder now writes an owner-controlled digest receipt after successful build and
image inspection. Before starting a created VM, the product verifies its actual image
descriptor and Linux arm64 platform against that receipt. The local engine does not resolve
the tag's digest reference as an image name, so comparing the created, stopped container is
necessary to close the mutable-tag race. This engine shape was observed in a never-started
temporary container, deleted in a finally block.

VM creation also writes a host-only lease before the engine call and labels the VM with its
random ownership nonce. Startup and the next Start reconcile dead-parent or expired leases,
refusing mismatched labels and retaining failed deletions for retry. The guest controller
has its own 15-minute deadline. Four pin tests, two recovery tests and eight session tests
passed together (14 total). Separate supervised cleanup/lifecycle validation passed 13 tests.
The review fixed admission leaks after automatic deletion and ensured a VM deletion failure
does not prevent unrelated thread or app cleanup.

The approval e2e spec now includes approval acceptance, real VM start, a 1280×800 screenshot,
and explicit Stop in one scripted parent turn. It imports only the trusted developer build
digest into its throwaway profile. That new journey has not yet run.

The host build/pin log subsequently confirmed success despite its MCP timeout: index
`sha256:fc9e3dfa8d7f0200c4c43caa5483b70748c3c7a34c2f0837f23a8a5263520b1e`.
The containment fixture initially read the wrong LLM tool-result shape; typecheck identified
that fixture error, now corrected to `toolResults`. Runtime
`copse-desktop-probe-fb2b0e37-b9d8-4ee4-b69c-2d29a5d6f19c` then passed with exit 0:
a child-approved shell command received ENOENT for the synthetic host canary, wrote/read its
own guest scratch file, and received ECONNREFUSED for the host canary service. The service
had first passed a host-side connection with a private nonce. The child command's result
returned through the model channel; cancellation revoked control and deletion succeeded.
No host credentials or paid inference were involved.

Crash-recovery runtime `copse-desktop-probe-60f2ff4b-0981-4fc9-a0dd-f329c6b202e3`
passed with exit 0. The harness killed only its own fixture parent with SIGKILL, then product
recovery deleted the nonce-labeled VM and lease. Engine inspection and lease-file reads
confirmed both were absent.

The branch has been advanced from `8dac4b323` to current `origin/main`
`ec82b3024068c106f830e284e37580fdf306d9b9`. Copse blocked rebase because a failed rebase
would detach this managed checkout. With no branch commits to replay, a fast-forward merge
produced the same base history, preserving work through autostash. The one restoration
conflict in the standalone bundle list was resolved by retaining both upstream's search
worker and the isolated desktop guest. On that base, all 106 focused tests passed, including
the authenticated ACP HTTP lifetime test, image pin, recovery, lifecycle and package invariants.
The host build and complete `check:local` passed. The final-base Linux image was then built
and pinned at `sha256:49d956e6ae849be6ee9899c76de4d5cdd64ce29e9b8f9b6f1176e71591b1d70c`.
The containment journey passed again in VM `dbe25745-a7e1-4804-a065-f84fd2e259d4`, and
SIGKILL orphan recovery passed in VM `8946b9a0-db7a-46e2-89e9-b6299672aad7`.
Both approval WDIO tests passed (6.1 seconds) in host runtime after the earlier sandbox DNS
failure: rejection/copy/layout and approval → real VM → screenshot → Stop. DOM assertions
confirmed the returned image was 1280×800. Visual inspection of `isolated-desktop-approved.png`
confirmed the guest setup screen was displayed inside the parent tool result.

## Remaining acceptance before merge

1. Exercise authenticated ACP bridge, the real tool, approval and VM startup in one journey.
   Current coverage proves bridge lifetime and real native runtime separately.
2. Require full static and unit CI on a clean runner. Local baseline triage found no new
   failures after the copy fix, but the full local run exhausted its deadline.

## Current validation limits

The nine focused preflight tests pass, including pre-start rejection, cleanup after a lost
create reply, cancellation, and teardown failure. CLI help and dry-run pass. The full check
passed static gates after fixing a test assertion overload; its unit run is still incomplete
and has a host cache-write denial in the worktree-manager suite. It is not a green gate.

On 2026-11-01, the real probe passed on Apple container 1.6.1, macOS 27.0.1 arm64. The
user built `copse-desktop-probe:local` through the existing worker builder with no ACP
agents installed. Run `copse-desktop-probe-4aec20cc-9b60-4cce-b382-334170ac20b2` reported
all ten required observations and positive controls passing, and teardown completed before
success was emitted. Local evidence is `.tmp/apple-desktop-probe.json`. This validates this
configuration and these observations, not resistance to VM escapes or a complete desktop.

Final-base validation: 106 focused tests passed, all TypeScript projects and `check:local`
passed, and the host build passed. The mandatory `pnpm run check` was attempted; after
fixing lint errors its unit stage was run separately with full logging. That run reached
16,425 passes, 75 failures and 11 cancellations before its 30-minute deadline. The new
user-copy failure was fixed and its focused rerun passed.

A clean local clone of base `ec82b3024068c106f830e284e37580fdf306d9b9`, with its own locked
offline dependency install, reran 24 failing files: 490 passes, 72 failures and 9 cancellations.
The changed checkout rerun plus ACP/pin tests had 532 passes, 74 failures and 9 cancellations.
The failing test names matched except for two empty-diff small-gate assertions: both pass
on clean main and fail there after adding one unrelated untracked source file, demonstrating
their dirty-checkout assumption. The baseline Electron fixture initially lacked its binary;
rerunning with the installed host Electron binary reproduced the same `sandbox_apply`
denial. Other shared failures include filesystem/socket denials, watcher exhaustion, a
macOS Bash array error and `/tmp` safety checks. Logs and the comparison are under
`.tmp/isolated-desktop-{baseline,triage}-tests.log` and
`.tmp/isolated-desktop-baseline-controls.log`. A separate clean-main run of the exact
worktree-manager test also timed out after 180 seconds with the same denied cache-directory
write (`.tmp/isolated-desktop-baseline-worktree.log`). Local triage found no remaining new
failures, but the full run did not complete; required clean-runner CI remains a merge gate.

Runtime evidence covers child-approved synthetic host-file and host-service denial, image
identity checks and SIGKILL orphan recovery as described above. It does not establish
resistance to VM escapes. This draft must not be advertised as a completed isolated GUI feature.
