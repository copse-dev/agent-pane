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
does not claim parity for private repository setup, PR creation, token-level
streaming, approval-required tools, or automatic background recovery. Recovery
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
