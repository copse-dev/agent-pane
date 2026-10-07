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
