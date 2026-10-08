# OpenAI cloud agent prototype

Base: `2b0302a0fb8eca8f4c22b79b394aa09b4c433c74`.

## Task brief

Offer an API-billed OpenAI hosted agent alongside Cursor and Claude. Acceptance:
create a hosted session, show progress/results, continue it after reopening Copse,
recover saved output after stream loss, confirm cancellation, and retrieve artifacts.
The first coding probe uses a public fixture repository and returns a patch.

Use the existing OpenAI key setting, never ChatGPT OAuth. The initial patch-only implementation is superseded by the Git transport brief below.
The current implementation uploads an exact working-tree snapshot, imports returned
commits locally, and leaves authenticated push/PR creation to the existing host flow.
Credentials, Git configuration and history are not uploaded. Computer use and
self-hosted execution remain excluded.

Auth, persisted state, remote cancellation, artifact paths, and usage accounting are
the critical boundaries. API sessions retain data in the US and do not support ZDR.
Copse currently has no global ZDR-only setting (the existing switch is OpenRouter
routing only); label this provider's retention explicitly rather than applying that
unrelated switch. Never silently fall back to a different execution/billing route.

Validate the REST contract against the installed OpenAI SDK and official docs;
exercise it using injected fetch fixtures, run the full `pnpm run check`, and run
a focused model-picker visual eval. Live tests require an available Platform key;
none is bound to this execution environment at the start of the task.

References:

- https://developers.openai.com/api/docs/guides/agents-api/quickstart
- https://developers.openai.com/api/docs/guides/agents-api/sessions
- https://developers.openai.com/api/docs/guides/agents-api/environments/files

## Evidence

Implemented the fixed-origin beta REST client, subscribe-before-submit event
stream, saved-turn/item recovery, idempotent pending submissions, cancellation
confirmation, bounded artifact downloads, and cumulative-usage deltas. Integrated
the provider with Copse's dispatcher, model picker, native thread checkpoints,
command output, and remote-agent link store. No new runtime dependency.

Validation on 2026-10-06:

- 76 focused tests pass, including six new API/adapter tests. Coverage includes
  follow-ups, lost submission responses, failed streams, confirmed/unconfirmed
  cancellation, structured tool results, nullable reasoning status, key changes,
  corrupt checkpoints, and hostile artifact paths/sizes.
- The focused browser WebdriverIO picker test passes. Inspected the captured
  `tests/e2e/screenshots/openai-cloud-agent-picker.png`: the complete prototype,
  billing, and retention label is visible and the option selects successfully.
  This environment has Chromium 151 and ChromeDriver 152; the visual run used a
  temporary driver wrapper with `--disable-build-check`. Native Electron testing
  could not start because Xvfb is absent; its configured package source is blocked.
- Renderer typecheck, both type-coverage thresholds, dead-code reachability,
  oracle invariants, and demo-site synchronization pass. E2E exclusion inventory
  passes with existing overdue-review notices.
- Production and demo builds pass, as do focused source lint and the probe's help
  command. Repository formatting reports one unchanged file,
  `docs/plans/model-roles-and-defaults.md`; all prototype files are formatted.
- `pnpm run check` is blocked by the unchanged
  `packages/llm/src/lm-studio-provider.test.ts:23` TS2554 error. Remaining gates
  were invoked independently. The full unit suite also encounters unrelated
  sandbox/process/container test failures in this environment; this is not a
  clean full-suite acceptance result.

No live API call or billable task was made: no Platform key is bound, and
`api.openai.com` is outside this environment's network allowlist. The standalone
probe's help/build path is verified; actual hosted execution, public-repository
patch generation, and production retention/billing behavior still require a live
smoke test. Usage is token accounting, not a complete container/tool invoice.

See [usage and limitations](../remote-agents.md#openai-prototype). The prototype
does not claim parity for token-level streaming or automatic background recovery.
Host function support added below covers GitHub/CI reads and approved PR creation. Recovery
after reopening currently requires resending the pending message. Local deletion
does not delete the remote session; the standalone probe supports explicit remote
deletion of its own checkpointed session.

## Git transport implementation brief

Acceptance: provision the exact thread working-tree snapshot through a bounded Git bundle and deterministic setup; verify the base before inference; export committed and uncommitted guest changes with the container carry-out helper; validate ancestry and import on the host without GitHub credentials in the guest. Persist terminal output before downloading so retry never repeats inference. Refuse adoption into a changed or dirty checkout and retain output for retry. Existing Create PR performs authenticated host push. Follow-up tasks provision fresh snapshots. Validate with real Git round trips, mocked API transport and the full local check; live API testing requires credentials unavailable on this host.

### Git transport completion evidence

Rebased onto main `8e6db4dd29d476eb134b1c11c68c7935c227d782` and resolved the
protocol-version collision as version 48. The app now uses Files uploads and
verified setup, the shipped hosted Git worker, durable terminal/export checkpoints,
container commit adoption and the existing host Create PR path. Fresh follow-up
snapshots replace the old clone/revision prompt helper.

- Focused API, adapter, real-Git transfer, cancellation, guest carry-out and build/type
  invariant suite: **44 passed, 1 existing platform skip, no failures**. Covers
  binary additions/deletions, dirty/ignored local file preservation, unrelated ancestry, missing
  export recovery, failed download recovery without resubmission/double usage, and
  fresh local code on follow-up.
- Container suite: **42 passed, 3 failed**. The new serialized snapshot-race test
  passes. All three failures reproduce on untouched main (**41 passed, 3 failed**):
  this host cannot create `/home/agent/.copse`, preventing preparation and Docker
  recorder setup. No assertions were skipped or weakened.
- Production build, focused type-aware lint, dead-code check, formatting and diff
  checks pass. Protocol comparison reports 12 existing provider shape changes,
  version **47 → 48**.
- Full `pnpm run check` stops at unchanged
  `packages/llm/src/lm-studio-provider.test.ts:23` (TS2554). The full suite therefore
  did not complete. No live hosted request or GitHub push from a hosted task was
  tested: this environment has no Platform key. This change is main-process data
  plumbing with unchanged renderer DOM; prior picker/Save-dialog visual evidence
  and limitations remain applicable.

Snapshot input is capped at 50 MiB; return bundles at 200 MiB. An initial commit is
required; submodules and LFS object contents are unsupported. Dirty original input
must be committed locally before adoption. Unrelated/merged guest history is
retained but not automatically applied. Export-only recovery may incur an extra
model turn. The draft is not promoted by this implementation.

## Image-input follow-up brief

Acceptance: the default hosted model accepts composer images without the text-only
warning; submit native `input_image` blocks, including image-only messages. Bound
and validate inline image data before provisioning, persist pending image inputs
for exact recovery, and reject a resend with different images. Carry recent prior
images into fresh sessions within the attachment budget. Verify transport and
recovery with fixtures and the composer with a focused browser screenshot.

The reported 50 MiB snapshot failure is a separate implementation limit: the
provider's per-file copy cap was applied to the entire project. Replace the single
file with 32 MiB parts and deterministic reassembly before the existing Git-base
check. Respect the 50-file provisioning count (49 parts plus the worker), clean up
partial uploads, and test an actual Git bundle exceeding 50 MiB without dropping
files. This is a transport change, not an increase to the provider's per-file cap.

### Image and multipart completion evidence

Native image inputs now replace the prototype's text-only restriction for the
default GPT-6.1 Sol route. Pending images use asynchronous atomic checkpoints;
changed-image resends are rejected and admitted turns recover without replay.
Recent prior attachments fill unused slots on fresh sessions. The five-image /
20 MiB attachment budget is Copse's bound, not an API capability claim.

Source bundles now stream into 32 MiB uploads (up to 49 parts plus the worker),
then reassemble before the existing commit verification. Partial-upload failures
clean up completed parts, and source-file deletion tolerates an already-deleted
file. The real-Git regression provisions a 51 MiB incompressible working tree;
files are not excluded to fit the old limit.

- Focused OpenAI API/adapter/image/upload/Git transfer/cancellation, model-option
  and main-process read-invariant tests: **79 passed, no failures or skips**.
- Focused browser composer spec: **1 passed** on Chromium 151. Inspected
  `tests/e2e/screenshots/openai-cloud-agent-image-input.png`: attachment thumbnail,
  selected GPT-6.1 Sol and Send button visible; no image-incompatibility banner.
  The unchanged picker reference was retained rather than accepting caret drift.
- Production and demo builds pass; focused type-aware lint passes. Full
  `pnpm run check` still stops at the unchanged LM Studio TS2554 error noted above.
- Live API vision/provisioning remains unverified without a Platform key. The
  larger whole-project budget is 1568 MiB; each API file stays below its 50 MiB cap.

## HTTP 400 diagnostics brief

The screenshot cannot identify the rejected endpoint or parameter because the
client discards upstream errors. Decode bounded structured error responses and
include the operation, safe provider reason/code/parameter and request ID without
exposing keys or raw response bodies. Cover creation, upload and malformed/oversized
errors. Do not claim the underlying live 400 is fixed without its response detail.

Diagnostics validation: 22 focused API/adapter/recovery/upload tests passed; the four new
error tests also passed after lint cleanup. Production build, focused type-aware lint,
formatting and diff checks passed. Full `pnpm run check` still stops at the unchanged
LM Studio test TS2554. This changes error data through the existing error card, with no
renderer/DOM changes. The live HTTP 400 remains unconfirmed without its provider detail.

## GitHub archive provisioning brief

Replace full snapshot provisioning with a host-authenticated GitHub archive redirect,
pinned to a locally known remote commit, plus a binary local-working-tree overlay.
Reject LFS attributes/pointers and submodules before requesting a URL or creating a
session. Never forward GitHub authorization to the archive URL. Validate the restored
Git tree and synthetic commit before inference; keep existing export/adoption semantics.
Bound uploaded overlay plus bootstrap below 50 MiB. Expired URLs fail setup without
inference and must be recoverable with fresh provisioning. Test real Git restoration,
private redirect handling, LFS refusal, tampering and aggregate bounds. No live OpenAI
acceptance can be claimed without a provider-key test.

Archive completion evidence: production build and focused type-aware lint passed.
37 focused API/adapter/Git-transfer/cancellation/error/invariant tests passed; the
final archive-only run passed all 5 tests including a subsequent oversized-overlay
regression. The real 51 MiB archive test restores unpushed/binary/deleted/executable/
symlink/untracked changes and verifies the exact Git tree and commit. Adapter tests
cover zero network requests for LFS and fresh provisioning after setup failure.
Full `pnpm run check` still stops only at the existing LM Studio TS2554. No renderer
or DOM changes. Live private GitHub redirect/OpenAI provisioning remains unverified:
this environment has no provider credentials and its network policy excludes the API
hosts. No billable call was made.

## Setup failure diagnostics brief

A live archive session failed during environment setup; the displayed error does not
prove URL expiry. Accept the documented `ready` transition, capture redacted provider
setup errors from environment events/polling, and report status and session identity
instead of diagnosing expiry. Preserve stage-specific bootstrap failures without
printing archive URLs, Git output or credentials. Test transition handling and
redaction. Do not claim the live failure reproduced without provider evidence.

Setup diagnostics validation: focused tests cover the ready transition, direct and
SSE provider errors, secret/URL redaction, stage-specific worker failures, setup retry
and cancellation recovery. Production build and focused lint passed. Full check still
stops at the unchanged LM Studio TS2554. The live failure is not reproduced; this
fixes premature failure on ready and exposes available provider evidence without
asserting that expiry caused the user's failure. Existing error DOM is unchanged.

## Empty sandbox diagnostic brief

The provider now reports only “The environment failed to connect”; this does not
identify a repository bootstrap failure. Add a standalone `--setup-only` probe
that requires a fresh checkpoint, creates an empty hosted environment, waits for
connection, and never sends an inference task or repository files. Retain its
checkpoint on success/failure for explicit deletion and provider support. Reject
conflicting task modes before making API requests. Document how the result
distinguishes baseline startup from repository provisioning; no live success may
be claimed without a provider-key run.

Diagnostic completion evidence: the bundled CLI help and a subprocess smoke test
with an intercepted fetch boundary passed. The smoke test rejected unexpected API
requests and covered empty connection, connection failure, retained checkpoints,
fresh-state refusal, conflicting modes and deletion after either outcome. Focused
ESLint and formatting passed. Full check still stops at the existing LM Studio
TS2554. This is CLI-only; no renderer changes or live provider calls. The user's
startup failure remains unresolved pending the empty-sandbox control.

## Repository diagnostic brief

The user's empty sandbox connected and was deleted successfully. Add one no-inference
repository diagnostic using the same snapshot and hosted bootstrap as the app. Catch
bootstrap failures only in this diagnostic, expose fixed status filenames through the
environment files API, and report the furthest setup stage without URLs, credentials
or raw command output. Keep production setup fail-closed. Persist diagnostic state
and uploads for explicit cleanup; forbid inference on diagnostic checkpoints. Cover
real bootstrap failure/success markers and CLI cleanup/guards. A live run still
requires the user's local provider credentials.

Repository diagnostic completion evidence: 40 focused tests passed, including
real Git/archive restoration, app recovery, CLI mode/checkpoint guards, worker
marker redaction and cleanup after successful setup, failed setup, failed
connection and a failed cleanup retried explicitly. Production build, standalone
probe/worker bundling, focused ESLint, formatting, diff and dead-code checks passed.
Snapshot preparation and environment-file construction are shared with the app;
only the diagnostic wraps setup failure, and it cannot submit inference. No DOM
changes. Full check still stops at the unchanged LM Studio TS2554. Live repository
provisioning remains unverified here; the user's empty-sandbox success is the only
new live provider evidence.

## Hosted proxy download brief

Live repository diagnostics reached the worker and failed during download before
an HTTP status, with Node 22, fetch and HTTPS_PROXY present. Native Node 22 fetch
does not automatically use HTTPS_PROXY. Replace the guest download transport with
curl, preserving the sandbox proxy/CA environment, TLS verification, no redirects,
240-second deadline and 2 GiB streaming bound. Pass the signed URL on stdin rather
than argv; retain only safe HTTP/curl failure codes. Verify a real HTTPS download
through a local CONNECT proxy with a trusted test CA, refusal of redirects and
certificate failures. Do not claim the live private archive succeeded yet.

Proxy download completion evidence: 9 focused archive/diagnostic tests passed.
The new test uses a real curl subprocess, authenticated local CONNECT proxy and
TLS server to verify archive bytes, exact Git tree/commit restoration, absence of
origin authorization headers, redirect refusal, untrusted-CA refusal and safe
HTTP/curl error codes. Production build, focused ESLint, formatting and dead-code
checks passed. Full check stops only at the existing LM Studio TS2554. The live
failure is consistent with missing Node proxy support, but a hosted retry is still
needed to establish that no further provisioning issue remains. No DOM changes.

## Hosted repository links brief

The user confirmed hosted snapshot verification and working inference, then found
that `/workspace/repo/docs/plans/...` links fail locally. Teach the existing
owner-scoped workspace resolver the hosted checkout prefix so both saved and new
messages resolve against the current thread checkout. Keep traversal/symlink
containment checks and exact-path semantics; never map outputs or neighboring
sandbox directories. Test files missing from the index, checkout ownership,
missing-file basename collisions and invalid paths. This is main-process path
resolution only, with unchanged renderer/DOM.

Hosted link completion evidence: all 16 resolver tests passed, including an
unindexed plan in the owning checkout, rejection in another checkout, absent
ownership context, missing-file basename collisions, neighboring sandbox paths,
traversal and escaping symlinks. Focused lint and formatting passed. Full check
still stops at the unchanged LM Studio TS2554. No IPC shape, renderer or DOM
change; existing click handlers retain line/column handling. Live click testing
in the user's desktop remains unverified here.

## Host function bridge brief

Expose registered GitHub/CI read tools and a narrow gh_pr_create function to OpenAI.
Dispatch only pending required_actions for the active turn through Copse's registry
with the owning thread and existing approval gate. Persist call results before
acknowledging them to OpenAI; never treat history items as pending calls. PR calls
queue typed title/body/draft data and return queued, not created. Only a completed,
imported hosted turn can execute that queue locally. Save execution intent before
mutation; ambiguous interrupted writes must never auto-replay. Preserve queued PR
recovery even after Git import, block a different prompt while recovery is pending,
and show the local result in the transcript. Test unsupported tools, call replay,
changed arguments, import ordering, denial, cancellation, and restart boundaries.
No local shell/files exposed; GitHub credentials remain local. Reuse existing tool
cards and validate their queued/result states visually.

### Host function implementation

The session advertises a curated `agent.tools` catalog. Only `required_actions`
for the active turn are dispatched; historical items never trigger execution.
Copse saves results before posting `agent.session.input.tool_result`, with a stable
idempotency key. The registry retains thread identity, readonly checks, permission
gates and hooks. No localhost server or public callback URL is required.

`gh_pr_create` accepts only title, body and draft. Its immediate result says queued;
the hosted agent must export and finish. After successful Git import, Copse asks
for the normal local approval and uses the same PR service as Create PR, including
pushing the whole current branch and linking the PR. The final result appears as a
local tool card and transcript text, not a second inference call. Follow-up context
contains that result. Failed/cancelled hosted turns cannot publish.

Requests, intent and results survive restart. Resend the previous prompt to finish
recovery. If a crash happens during a GitHub write, Copse reports an uncertain
outcome and does not automatically repeat it; check GitHub before requesting again.
Read calls may be retried if execution completed but its result was never saved.

API references: [functions](https://developers.openai.com/api/docs/guides/agents-api/tools/functions)
and [hosted files](https://developers.openai.com/api/docs/guides/agents-api/environments/files).
The turn-end artifact boundary is why PR publishing is deferred.

### Host bridge completion evidence

- 22 focused API/adapter/queue/registry tests pass. They cover saved-result replay,
  wrong-turn/changed-call refusal, import failure before publication, queue deduplication,
  crash ambiguity, cancellation, narrow arguments, thread identity and permission denial.
- Production/demo builds, focused type-aware lint, formatting and dead-code checks pass.
- Full `pnpm run check` stops at the unchanged LM Studio test TS2554. Full lint also
  reports an unchanged ACP test `no-meaningless-void-operator` error. Separately running
  the full unit suite produced 13,570 passes, 20 failures, 9 cancellations and 24 skips;
  failures are in sandbox/process/toolchain/container and other pre-existing test files.
  This is not a clean full-suite result and those failures were not suppressed.
- The host PR demo checks the imported-change message, expanded tool arguments and
  PR result in the existing renderer. No new renderer component or permission policy.
- No live provider function call or authenticated GitHub publish was run in this
  environment. A live smoke test must still confirm OpenAI admission, queued acknowledgement,
  normal approval and the final GitHub link.

## Waiting-state and Retry recovery fix brief

The live trace reached `gh_pr_create`, but the adapter's fallback rejected a waiting
turn. Turn and session reads are separate snapshots: waiting without a matching
session status is not proof of an unsupported action. Dispatch only current
`required_actions`, regardless of the status label; keep polling when waiting has
no pending details, retaining cancellation/deadlines and refusing unknown actions.
Never infer pending calls from historical items. Export-only recovery must return
an explicit refusal for host functions instead of abandoning a waiting call.

The existing Retry button submits the standard interrupted-turn continuation.
Recognize that exact shared instruction only as recovery of an existing checkpoint,
reuse its original prompt/images/hash, and keep unrelated new prompts blocked.
Do not create a fresh hosted task from the recovery instruction or replay a completed
PR write. Test status skew, delayed action visibility, replay after lost delivery,
unknown actions, UI continuation recovery, original image preservation and no-checkpoint
refusal. Existing UI/DOM remains unchanged; validate the renderer Retry dispatch contract
and the adapter together through their shared instruction.

Recovery of an already submitted turn reads its session even if the environment has
disconnected; setup readiness only gates initial admission. This preserves terminal
output/artifact recovery after the hosted sandbox stops.

Completion evidence: 57 focused API/adapter/host-tool/renderer recovery tests pass.
They reproduce waiting with no details, pending actions under `in_progress`, stale
waiting after result delivery, unknown/wrong-turn/changed-call refusal, saved-result
replay, image-preserving Retry, disconnected recovery, no duplicate submission/PR,
and export-only function refusal. Production build, focused type-aware lint,
formatting, diff and dead-code checks pass. Full `pnpm run check` still stops at the
unchanged LM Studio TS2554. No renderer DOM/copy/layout changed: the existing Retry
component tests exercise the click and shared continuation contract; the adapter
regression consumes that same instruction. No live provider call was made here.

## Picker catalog and retention brief

Replace the verbose OpenAI cloud heading with the existing row retention icon,
labelled No ZDR with an accessible tooltip. Keep billing in the existing billing
badge. Offer every OpenAI chat model in Copse's catalog, default Sol first, retain
unknown current selections without duplication, and preserve image capability for
known models. The API accepts a string model ID but documents no exhaustive Agents
compatibility enum: catalog inclusion is not a live eligibility guarantee. Validate
model choices/key gating, selected fallback privacy and a focused browser screenshot.

Completion: 80 focused model-option/picker tests and the focused WDIO browser spec
pass. Inspected the expanded catalog with row retention/billing icons and the image
attachment composer. Demo build, focused type-aware lint, formatting and diff checks
pass. Full check still stops at the unchanged LM Studio TS2554. The 11 choices come
from the existing OpenAI chat catalog, not live per-account Agents eligibility; no
billable compatibility probes were run.
