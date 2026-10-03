# Curated ACP catalog review

Task brief (2026-10-01), starting at `b1c62baff`.

Follow-up: the user subsequently requested [generic registry discovery](acp-registry-discovery.md).
That explicitly expands the runtime-browsing scope below; it does not promote
OpenCode or Qwen to reviewed integrations or auto-setup presets.

The goal is a small, evidence-backed expansion of the device-agent catalog. A new
entry must have a documented ACP stdio launch, installation and authentication
instructions, platform/prerequisite guidance, explicit billing caveats, and a
conservative sandbox profile. Settings must add it through the real product form,
then expose it in the model picker. Protocol fixtures establish Copse wiring;
only an approved authenticated vendor run establishes live compatibility.

Review GitHub Copilot CLI, OpenCode and Qwen Code independently. Keep manual
catalog entries separate from auto-setup presets. Do not execute registry entries,
inspect credentials, infer permissions from registry metadata, or implement runtime
registry browsing or locked installers. Installation and live/paid probes use
explicit approval paths.

Validation: catalog, auto-setup, sandbox resolution, Settings and picker tests;
a focused WebdriverIO screenshot; the repository preparation check, test oracle,
full `pnpm run check`, and build. Record live-provider gaps separately. The
registry snapshot and drift-report tooling are absent at this base revision.

## Candidate evidence

### GitHub Copilot CLI — manual catalog entry

- Distribution: `npm install -g @github/copilot`. The npm metadata query on
  2026-10-01 returned version `1.0.90`, with the `copilot` executable supplied by
  `npm-loader.js`. The [installation guide](https://docs.github.com/en/copilot/get-started/cli-quickstart)
  requires Node.js 22+ for npm installation. GitHub documents macOS, Linux and
  Windows (PowerShell/WSL); this review does not establish cross-platform runtime
  compatibility. Use a current release; an older installation may lack ACP.
- Launch: `copilot --acp --stdio`, using the documented
  [ACP stdio server](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server).
  ACP remains public preview. No `--allow-all`, tool approval bypass, TCP listener,
  or default permission-mode override is added.
- Authenticate interactively with `copilot login`, or explicitly configure
  `COPILOT_GITHUB_TOKEN`. The [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)
  documents fine-grained tokens with Copilot Requests permission, not classic PATs.
  This review reads documentation, never local credential files. macOS keychain
  access under Copse confinement is not established; no keychain grant is added.
- GitHub-hosted inference uses the user's Copilot entitlement and applicable usage
  limits/billing. Organization policy may disable CLI access. There is no promise
  of unlimited or free use. [BYOK](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)
  can use a separate provider without GitHub login; that provider controls billing.
  Copse therefore leaves `acpPlanProvider` unidentified for this agent and does
  not enroll it in subscription routing or estimate free capacity.
- Sandbox: `github.com` and `api.github.com` cover documented authentication and
  account APIs; `*.githubcopilot.com` covers the vendor's plan-dependent model
  hosts. These come from the [GitHub allowlist reference](https://docs.github.com/en/copilot/reference/copilot-allowlist-reference),
  not ACP registry metadata. No general GitHub wildcard, package registry,
  arbitrary provider, telemetry, voice/model-download or GHE tenant hosts are
  granted. BYOK/GHE/custom endpoints require an explicit agent sandbox override.
- Home allowances are `.copilot`, `.cache/copilot` and `Library/Caches/copilot`,
  matching the documented [configuration/cache locations](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference).
  Nondefault `COPILOT_HOME`/cache locations need explicit overrides. No extra
  system scratch paths or macOS service exception is granted; the child receives
  Copse's workspace-owned `TMPDIR`. A live trace must establish whether more is
  needed before any expansion.
- Manual support only: no `preset`, `autoInstall` or `installPackage`. Opening
  Settings must not install, register, upgrade or probe Copilot automatically.
  The displayed install command is guidance, not an automatic action.
  The provider panel now scans only when selecting a manual/custom agent. This
  fixes the observed unrelated preset-upgrade prompt on the Copilot entry path.
  Selecting a preset later still runs auto-setup, even after a manual agent scan.

### OpenCode — deferred

[ACP documentation](https://opencode.ai/docs/acp/) documents `opencode acp` over
stdio. The older [installation documentation](https://dev.opencode.ai/docs)
lists `npm install -g opencode-ai`, macOS/Linux packages and Windows npm/WSL.
The newer [v2 documentation](https://opencode.ai/v2/docs) instead lists
`npm install -g @opencode/cli`, requires a native-binary postinstall, and says
Windows package managers are unsupported. A release-specific launch and platform
check is needed; do not combine those two distribution contracts into a preset.
No numeric minimum Node version is established by these pages for the npm wrapper.

Authentication is provider-dependent (`/connect` or `opencode auth login`).
[Provider documentation](https://opencode.ai/docs/providers/) describes API keys,
custom base URLs and `~/.local/share/opencode/auth.json`; we did not open that file.
The OpenCode/Zen account is not evidence that every model uses a subscription:
API/provider billing applies to the selected connection. Model metadata refreshes
can contact `models.dev`, and provider/plugin packages can introduce further
startup network requirements. No broad provider/package-registry domains or home
root are granted to make that work. An exact release, provider, state/cache paths
and confined startup/turn trace are still needed before adoption.

### Qwen Code — deferred

The [quickstart](https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/)
documents `npm install -g @qwen-code/qwen-code@latest`, Node.js 22+, and
macOS/Linux/Windows installation. The [architecture guide](https://qwenlm.github.io/qwen-code-docs/en/developers/architecture/)
documents `qwen --acp`. Run `qwen` and use `/auth` to configure a provider.

The [authentication guide](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)
states that Qwen OAuth's free tier ended on 2026-04-15. Do not advertise free OAuth
or infer a subscription from the executable. Alibaba Coding Plan uses a dedicated
endpoint and subscription key; Token Plan and standard/third-party API keys have
usage billing. The region and selected auth method matter. Documented Coding Plan
hosts include `coding.dashscope.aliyuncs.com` and
`coding-intl.dashscope.aliyuncs.com`; the guide places settings under `.qwen`.
Those are candidate-specific facts, not a grant for all Alibaba domains. No home
or scratch profile is shipped without a release-specific confined probe. Qwen is
not installed or authenticated here and remains available through the custom
agent form, without a curated support claim.

## Verification record

The worktree started with Node `24.20.0` and pnpm `10.34.5`. The repository
readiness check failed before source changes and again after the approved frozen
install and `prepare:native`: `package.json` declares Electron `44.4.3` alongside
electron-chromedriver `44.4.2`, and `check-prepared-worktree.mts:49` requires equal
package versions. Preparation completed but did not resolve that declaration
mismatch. No dependency or lockfile change is part of this catalog batch. The
native worktree-preflight tools are not exposed in this session; the repository's
declared readiness command is used instead.

An isolated, lifecycle-disabled install of `@github/copilot@1.0.90` completed.
`copilot --help` lists `--acp` and `login`. The standard capability probe then
successfully ran `copilot --acp --stdio` on macOS arm64 with an empty inherited
environment except PATH/TMPDIR and an isolated Copilot profile/cache. It negotiated
ACP v1, created a session, advertised 21 models, three modes and HTTP MCP support.
No prompt or authentication was sent. The probe is unsandboxed and therefore
does not prove this catalog's confined runtime or any paid inference behavior.
Local artifacts: `.tmp/acp-copilot-probe.log` and
`.tmp/acp-copilot-capabilities.{md,json}`.

The focused checks passed:

- `corepack pnpm test -- acp-known-agents`: 6 tests passed.
- `corepack pnpm test -- acp-auto-setup acp-agent-registry acp-agents-section providers-section`:
  73 tests passed (`.tmp/acp-catalog-focused.log`). After the manual/preset UI
  correction, `corepack pnpm test -- providers-section` passed all 21 tests
  (`.tmp/acp-catalog-providers.log`).
- `corepack pnpm run build`: passed (`.tmp/acp-catalog-build-final.log`).
- `corepack pnpm run oracle -- --explain`: HIGH confidence; all changed files
  mapped (`.tmp/acp-catalog-oracle-verified.log`).
- `corepack pnpm run test:e2e -- --spec tests/e2e/acp-catalog-entry.e2e.ts`:
  1 test passed on macOS (`.tmp/acp-catalog-e2e-entry.log`). It starts with no
  registered agent, adds Copilot through Settings, checks the stored command and
  arguments, injects an ACP fixture through the supported Command editor,
  detects models, selects the entry under Browse all, and completes a prompt.
  It also follows the real dirty-checkout confirmation when needed. This proves
  the application entry path, not a live Copilot model turn.

Visual review passed for the saved
[setup form](../tests/e2e/screenshots/acp-copilot-manual-setup.png),
[model picker](../tests/e2e/screenshots/acp-copilot-model-picker.png) and
[fixture turn](../tests/e2e/screenshots/acp-copilot-fixture-turn.png): command and
billing text fit without clipping, the new entry is selectable, and the reply
appears in the transcript. No agent registration is seeded by this spec.

The approved live behavior probe also completed on macOS with Copilot 1.0.90:
`corepack pnpm run probe:acp:behavior -- --agent github-copilot-cli --prompt 'Reply with exactly ACP_OK. Do not use tools, read files, or modify anything.' --timeout 30000 --out .tmp/acp-copilot-live`.
The workspace-local Copilot installation was placed first on PATH and automatic
updates were disabled. The CLI used its normal authentication; no credential file
was inspected. The report records `end_turn`, agent-message and usage updates,
and zero file writes, tool calls or permission requests. This runner does not
retain answer text, so it does not assert the exact `ACP_OK` response. Artifacts:
`.tmp/acp-copilot-live.{log,md,json}`.

Remaining runtime limits: both real-vendor probes ran outside Copse confinement.
The catalog's domain/home profile, macOS keychain access, BYOK/GHE overrides,
permission-request behavior and Linux/Windows runtime remain unverified. The
fixture proves Settings-to-picker-to-turn wiring; the vendor probe separately
proves a prompted ACP session completes. This is manual preview support, not an
auto-setup or all-platform certification.

`corepack pnpm run check` completed with exit 1. Every static gate passed;
the unit suite passed 11,834 of 11,835 tests. The remaining failure is
`packages/review/src/stage0.test.ts`, “runs trusted pnpm preparation against a
read-only content store”: preparation returned `failed` instead of `passed`.
The log is `.tmp/acp-catalog-check-complete.log`; retained test artifacts are
`.tmp/test-run-ZXH3kY`. This review does not claim a green full gate or a proven
baseline failure. A follow-up isolated diagnostic was submitted through the host
command tool, but that request timed out after 300 seconds without a diagnostic
log. The underlying preparation error therefore remains unresolved. The final
documentation-only formatting check hit the same tool timeout; source formatting
had passed in the full gate before these evidence notes were added.
