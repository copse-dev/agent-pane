# Isolated Copse desktop through Apple container

**Status: experimental native and ACP implementation on `main`.**
[PR #4127](https://github.com/copse-dev/agent-pane/pull/4127) merged on November 3, 2026
at `2332b795b08b9169b52db55cf7556913a6d1d800`. The separate host-child prototype remains
parked in [#4118](https://github.com/copse-dev/agent-pane/pull/4118); its host-control exception
and warning-window UI are not part of this implementation.

The final PR head, `3173996f48b197b5137f3f6b84ba6f66e0d119df`, passed
[check, build, all nine Electron shards, and CI Passed](https://github.com/copse-dev/agent-pane/actions/runs/41554659236).
Full release validation was skipped. The macOS-only isolated-desktop spec is excluded from Linux CI;
passing those shards does not establish the Apple VM journey. On-device evidence is recorded below.

## Safety contract

Assume the agent completely controls the child and approves every dialog. Every resulting
GUI action, shell command and subprocess must remain within the disposable guest. A fresh
profile or temporary working directory on the host is insufficient. There is no automatic
Docker, shared-kernel or host fallback for this path.

The intended desktop is Linux Copse in Apple container's per-container VM, not a macOS VM.
Host Copse and unrelated host applications remain unavailable to guest GUI input. No home,
credentials, SSH agent, engine socket, display socket or execution broker is mounted or
forwarded. Direct host and external networking is disabled. Model inference uses the bounded
host-inference channel; arbitrary host commands must never be part of that channel. Inputs
and exported artifacts need their own explicit transfer policy.

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
residuals in `thread-in-container.md` still apply. The product adds image identity pinning and
orphan reconciliation below. Resource-exhaustion probes remain additional work; this preflight
alone does not establish the product boundary.

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
This original smoke image had no model credentials or inference channel. The GUI may display normally while
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

## Landed implementation

The `isolated_copse` tool uses a thread-owned session service, fixed Apple VM transport,
and a private guest Unix-socket relay to host inference. Start requires fresh,
non-rememberable consent naming the pinned model and 100,000-token / 15-minute limits.
Guest provider selection refuses every other model. No credentials are copied into the guest.

Input is serialized, bounded and timed out. Stop, parent cancellation, expiry, blocking the
tool, thread cleanup and application shutdown revoke authority before deletion. Failed deletion
remains visible and retryable. Shutdown awaits deletion within the existing quit deadline.
ACP bridge calls bind desktop lifetime to the captured owning turn/session, independently
of an individual HTTP response. Bridged starts require an explicit supported host model.

The image builder writes an owner-controlled digest receipt after successful build and image
inspection. Before starting a created VM, the transport verifies its stopped configuration,
Linux arm64 platform and actual image descriptor against that receipt. A mutable tag is not
sufficient. Startup writes a host-only lease and labels the VM with a random ownership nonce.
Startup and the next Start reconcile expired or dead-parent leases, refuse mismatched labels,
and retain failed deletion for retry. The guest controller has its own 15-minute deadline.

## Build and run

The Apple container service must already be running. Build and verify the prerequisite,
then build the desktop using the profile that will launch it:

```bash
COPSE_CONTAINER_ENGINE=apple node scripts/run-thread-container.mts --build-only --no-acp-agents --image copse-desktop-probe:local
pnpm run probe:apple-desktop --image copse-desktop-probe:local
COPSE_DIR="$HOME/.copse" node scripts/build-apple-desktop.mts
```

The desktop commands support both `/opt/homebrew/bin/container` and
`/usr/local/bin/container` through a restricted PATH. Pin errors report the exact receipt
path/profile and cause. A freshly seeded guest skips provider onboarding because the approved
session provider is already configured; Finish must not replace it with Balanced.

## Accepted on-device evidence

These are distinct observations, not claims of general isolation or model reliability.

| Journey                           | Recorded evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containment preflight             | November 1: Apple container 1.6.1, macOS 27.0.1 arm64; all ten required observations and positive controls passed, then teardown completed. Run `copse-desktop-probe-4aec20cc-9b60-4cce-b382-334170ac20b2`.                                                                                                                                                                                                                                                                                                               |
| Native consent and VM             | Both focused WDIO cases passed: rejection/copy/layout, and approval → real VM → 1280×800 screenshot → Stop. `isolated-desktop-approval.png` and `isolated-desktop-approved.png` were inspected.                                                                                                                                                                                                                                                                                                                           |
| Child-approved host escape denial | Final-base VM `dbe25745-a7e1-4804-a065-f84fd2e259d4`: child-approved shell received ENOENT for a synthetic host file and ECONNREFUSED for a host service; guest scratch and host nonce-service positive controls passed. Cancellation revoked control and deletion succeeded. No paid inference.                                                                                                                                                                                                                          |
| Orphan recovery                   | Final-base VM `8946b9a0-db7a-46e2-89e9-b6299672aad7`: fixture parent received SIGKILL; product recovery removed the nonce-labeled VM and its lease, verified absent afterward.                                                                                                                                                                                                                                                                                                                                            |
| Real GUI inference                | November 2, session `3e808e45-81fc-440d-a44e-d1f8abe0e20c`: fresh guest skipped provider onboarding; New Project created `default-model-test`; composer defaulted to session; first greeting received `Hello!` without opening the model picker. Optional ACP package installation was rejected. Stop deleted the VM. Screenshots were inspected. Current controller was transferred into the existing trusted Linux image. [Producer record](https://github.com/copse-dev/agent-pane/pull/4127#issuecomment-6577707251). |

The producer's local full unit run exhausted its 30-minute deadline after 16,425 passes,
75 failures and 11 cancellations. A clean-base comparison reproduced the remaining failures
and dirty-checkout assumptions after fixing the new copy assertion. That local run was not
complete; the final PR's passing clean-runner CI above supplies the static/unit merge evidence.
The final-base focused desktop/ACP/pin/recovery suites passed 106 tests; subsequent setup fixes
passed 34 focused tests, `check:local` and the host build.

## Combined ACP acceptance follow-up (November 5, 2026)

Base: `b524afbe8f6109050bb79637b28bfeb771bd7b8a`.
The focused macOS spec is `tests/e2e/isolated-desktop-approval.e2e.ts`; its independent
scripted ACP executable is `tests/fixtures/isolated-desktop-acp-agent.mjs`.

Required observable acceptance in one Electron session:

1. Start a registered ACP process through Copse and receive its real native HTTP bridge.
2. Reject an unauthenticated request, initialize with the supplied bearer credential,
   and discover `isolated_copse` through `tools/list`.
3. Invoke the registered tool and accept the real non-rememberable consent UI naming the model.
4. Start the trusted Apple VM and return a real 1280×800 PNG through a later HTTP request,
   after the Start response has closed.
5. Stop/delete the VM, then refuse another screenshot because session authority is gone.
6. Save and inspect the consent UI, actual guest PNG and completed ACP reply.

Run with the existing trusted desktop image and freshly built host/controller:

```bash
pnpm run build
pnpm run test:e2e -- --spec tests/e2e/isolated-desktop-approval.e2e.ts
```

**Passed on device:** all three cases passed in 17.8 seconds (WDIO session
`a926ce53b25fab82f801f1f6b524a2b4`), including the complete authenticated ACP journey above.
The Start response closed before Screenshot; the later request still reached the live VM.
Stop returned successful deletion and a subsequent screenshot was refused. The focused
bridge/desktop/preflight/pin suite passed 73/73 tests, zero skips, outside the shell sandbox
so its real loopback HTTP servers could bind. The host build and e2e TypeScript check passed.

Captures under `tests/e2e/screenshots/` were inspected:

- `isolated-desktop-acp-approval.png`: the pinned model, budget, isolation/stop disclosures
  and both decision buttons are readable without clipping; no remember control is shown.
- `isolated-desktop-acp-guest.png`: the real 1280×800 Linux Copse window is rendered with
  its first-run product announcement. The PNG crossed the authenticated MCP response.
- `isolated-desktop-acp-complete.png`: the ACP completion reply is visible and the parent
  composer is idle after deletion and revocation.

The reused trusted Linux image was `sha256:b6af5af8bfed9d8af6ac6bd15d1359299334f1e76bd9c74c6fead137bffaa97a`
(built November 2). The controller came from the current host build. These macOS captures
are local evidence, not replacement Linux screenshot baselines. Logs are
`.tmp/isolated-gui-e2e.log` and `.tmp/isolated-gui-focused-host.log`.

The scripted ACP agent tests integration without paid inference. It does not substitute for
the separate real-model GUI observation above. The combined ACP acceptance gap from #4127
is closed for this tested image/controller combination.

## Follow-up validation

- `pnpm run build`: passed. All `check:local` stages passed, including all TypeScript
  projects, type coverage, lint, formatting, dead-code, oracle, exclusions and accessibility.
- `pnpm run oracle -- --explain --base HEAD`: HIGH, all four changed files mapped;
  the one selected Electron spec passed. `HEAD` is the fetched main base recorded above;
  the shared local `origin/main` ref was older.
- `pnpm run check` completed its static stages; its sandboxed unit attempt was stopped
  after launching the complete unit suite separately with host loopback access. The original
  sandboxed focused bridge run hit `listen EPERM`; the host focused rerun passed 73/73.
- Host `pnpm test`: 17,007 tests; 16,993 passed, 13 failed, one skipped, zero cancellations.
  This is not a zero-failure full gate. No new failure was identified after comparison:
  - Clean base reproduced the Stage 0 read-only pnpm-store assertion, macOS Bash empty-array
    protocol assertion, and all six `/var` screenshot-review safety failures (182/190 passed).
  - Both small-gate assertions pass on clean base and fail with the same `subset` versus
    `skip` mismatch after one inert untracked `src/main` file (11/13 passed). They assume
    an empty checkout while calculating coverage from the live diff.
  - Base reproduced the temporary-directory permission assertion (179/180 passed) and
    Git sandbox/signing failure (6/7 passed).
  - Apple build-output cleanup passed on clean base and on isolated current-tree retry
    (21/21); its suite-load failure did not recur.

The test and documentation changes do not modify product code. Logs are retained under
`.tmp/isolated-gui-{check,units-host,base-tests,base-dirty,base-permissions,base-git,apple-output-retry}.log`.
The original PR's clean-runner CI is linked above; this follow-up has not yet run PR CI.

## Remaining limits

- This is an experimental Linux GUI in a per-container Apple VM on a local Apple silicon Mac.
  There is no host GUI, macOS guest or Docker fallback.
- The macOS-only runtime journey needs on-device execution; Linux CI cannot cover it.
- Reusing a trusted Linux app image with a fresh controller establishes that combination,
  not an image rebuilt from the follow-up's current source.
- Configuration checks and synthetic escape denials do not establish resistance to VM escapes.
  Resource-exhaustion behavior and longer real coding sessions need further measurement.
