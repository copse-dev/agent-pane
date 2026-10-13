# ACP registry discovery

Task brief (2026-10-01), on `b1c62baff` with the curated-catalog changes in this
worktree. The follow-up explicitly adds runtime registry browsing to the scope.

Acceptance criteria:

- Settings offers an explicit registry browser with search, refresh and useful
  loading, empty and failure states. Opening Settings alone does not fetch it.
- Any valid registry entry can appear without a code change. Entries are marked
  unverified by Copse; the reviewed catalog and auto-setup presets stay separate.
- Discovery fetches the fixed public stable index with time/size limits, decodes
  untrusted JSON, and checks executable presence without launching processes.
  A package runner on PATH does not establish that its package is installed.
- Selecting an entry opens an editable, disabled custom-agent draft. The user
  reviews its command before adding/enabling it. Registry environment values,
  permission modes, icons, install actions and sandbox grants are never imported.
- Unit tests cover malformed metadata, hostile fields, bounded fetching, caching
  and filesystem-only detection. Renderer tests and a focused WebdriverIO visual
  eval cover browsing through the real Settings entry point and manual review.
- Run focused tests, build, oracle and the full check. Record exact evidence and
  remaining gaps here. Locked installers and automatic registry execution remain
  out of scope; no credential inspection or paid vendor probes are required.

The upstream [registry format](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md)
and [registry README](https://github.com/agentclientprotocol/registry/blob/main/README.md)
document the stable index at
`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`.
Distribution metadata identifies binary targets or npm/PyPI packages; package
names do not reliably identify installed executable names.

## Completion evidence (2026-10-01)

Validated with Node 24.20.0 and pnpm 10.34.5, on the uncommitted worktree based on
`b1c62baff`. The curated-catalog task's native preparation remains applicable;
this follow-up changes no dependencies. The IPC parser and lint corrections
were approved and applied before the checks below.

- `pnpm test -- acp-registry-discovery acp-registry-browser providers-section acp-agents-section api-protocol`:
  all 67 tests passed. Log: `.tmp/acp-discovery-approved-focused.log`.
- `pnpm run gen:api-protocol`: manifest regenerated, additive channel at protocol
  version 32. The focused protocol tests confirm no drift. Generation log:
  `.tmp/acp-discovery-protocol.log`.
- `pnpm run build`: passed after the final style correction. Log:
  `.tmp/acp-discovery-style-build.log`.
- `pnpm run check`: the final local attempt passed every static gate, including
  typecheck, type coverage, lint, formatting, generated-site consistency,
  dead-code detection, oracle integrity and e2e syntax/exclusion checks. Its unit
  phase encountered environment failures and was stopped with exit 130 after
  progress stalled. Log: `.tmp/acp-discovery-local-final-check.log`; artifacts:
  `.tmp/test-run-MtGRRe`. This is not a green full gate.
- `pnpm run oracle -- --explain`: broad coverage, requiring the full tier.
  Log: `.tmp/acp-discovery-oracle-selection.log`.
- `pnpm run test:e2e -- --spec tests/e2e/acp-registry-discovery.e2e.ts --spec tests/e2e/acp-auth-error.e2e.ts`:
  all four tests across both specs passed on the Copse macOS host. Log:
  `.tmp/acp-discovery-style-e2e.log`.

The native test starts with no registered agent, opens Settings, verifies no
registry request occurs before Browse, searches, exercises a failed refresh and
recovery, and reviews a draft with a blank command/environment and locked-off
Enabled control. It saves the agent disabled and confirms it is absent from the
model picker. Only after explicit enablement and model detection does the local
ACP fixture start. The test then selects it and completes a prompt. This proves
the real Settings → draft → enable → model picker → agent-turn path, with the
HTTP response and ACP agent supplied at test boundaries. It does not certify a
third-party distribution, authentication method, billing model or sandbox.

The read-only public-index probe (`node .tmp/verify-acp-registry.mjs`) loaded 41
entries, skipped none and identified 14 direct executable names. No matching
executables were found on the host PATH. Copilot, OpenCode and Qwen appeared as
registry entries; this does not promote them to reviewed integrations. The probe
did not install, launch or authenticate any agent. Log:
`.tmp/acp-discovery-live-index.log`.

Visual review passed for the
[registry browser](../tests/e2e/screenshots/acp-registry-browser.png) and
[fixture turn](../tests/e2e/screenshots/acp-registry-fixture-turn.png): search,
Unverified status, package information and review actions are readable, and the
completed response appears in the transcript. The revised
[review form](../tests/e2e/screenshots/acp-registry-review.png) and
[disabled Enable control](../tests/e2e/screenshots/acp-registry-review-enable.png)
also passed visual review: the complete review note, blank command, arguments,
disabled checkbox and Add agent action are readable in their respective views.
The decorative border is gone; the note uses the existing field-hint styling.

## Remaining validation gaps

The earlier full run caught a decorative border on the registry draft note.
That rule was removed. The final focused command
`pnpm test -- accent-rails acp-registry-discovery acp-registry-browser` passed all
14 tests (`.tmp/acp-discovery-style-focused.log`). The rebuilt app
(`.tmp/acp-discovery-style-build.log`) then passed all four tests in
`pnpm run test:e2e -- --spec tests/e2e/acp-registry-discovery.e2e.ts --spec tests/e2e/acp-auth-error.e2e.ts`
without a concurrent full-check load (`.tmp/acp-discovery-style-e2e.log`). This
also demonstrates the earlier authentication-error timeout did not reproduce;
it does not prove the cause of that timeout or establish a green broad suite.

The earlier complete Copse-host unit run passed 11,845 of 11,847 tests
(`.tmp/acp-discovery-final-check.log`, artifacts `.tmp/test-run-aDf7Py`). Besides
the corrected style test, it failed `packages/review/src/stage0.test.ts`,
“runs trusted pnpm preparation against a read-only content store”: preparation
returned `failed` instead of `passed`. That preparation test passed in the final
local attempt, so the failure was not consistent across executors. No baseline
regression or clean full gate is established.

The final Copse-host full-check request timed out before creating its log; an
identical retry also did not start and was cancelled. The local executor ran all
static gates successfully, but its unit phase reported denied ASRT Unix-socket
listeners, nested native sandbox and home-path operations, and additional
provider/review test failures. It stopped advancing at the sandbox integration
fixtures and was interrupted with exit 130. These results require a working host
runner to resolve; the unit suite is not validated by this restricted run. An
isolated preparation diagnostic also stopped before preparation because Git
could not create a workspace-local fixture's `.git/hooks` directory; see
`.tmp/acp-review-prep-diagnostic.log`.

No remote e2e host or registry is configured. The local broad command
`pnpm run test:e2e -- --bail 1` selected all 337 specs, passed `accent-color.e2e.ts`,
then stopped at `acp-auth-error.e2e.ts`: its beforeEach hook exceeded 30 seconds;
ChromeDriver reported a 20-second renderer response timeout. The remaining specs
were not run. Logs: `.tmp/acp-discovery-broad-e2e.log` and
`.tmp/acp-discovery-broad-driver.log`. Local accent screenshots were copied to
`.tmp/acp-discovery-broad-screenshots/` and the unrelated tracked references
restored. Both the registry spec and authentication-error spec passed in the
subsequent isolated rerun. Its unrelated authentication screenshots were retained
under `.tmp/acp-discovery-auth-screenshots/` and tracked references restored. The
other broad-suite specs remain unverified; passing that rerun does not establish
a green broad suite.
