# Image generation

Copse's `image_gen` tool works independently of the model selected for the conversation,
including a ChatGPT plan model. Each request tries:

1. Enabled Codex ACP, unless image generation was explicitly disabled for it.
2. Other enabled coding agents marked **Use for image generation** in their Settings options,
   in saved configuration order.
3. The configured OpenAI API key, only after a separate approval for that image.

Image input capability is not evidence of image generation. Codex's recognized launcher has a
catalog default; custom agents must be explicitly enabled for generation. A custom command merely
named with the Codex id does not receive that default. The agent must have its own working native
image-generation capability. No adapter is installed or signed in automatically by this tool.

Coding agents use their own account, billing and usage limits. This is not a promise of free
images: a runner may consume purchased credits. The API fallback uses OpenAI's Images API and
is billed separately from ChatGPT plan usage. Its approval names this cost boundary and includes
runner errors. Declining a runner permission, declining the fallback, an explicit provider refusal, or stopping
the parent turn ends the route chain. A runner failure can try the next eligible runner; if none succeeds and no
API key exists, the tool reports the failures without claiming success.

Each runner gets a fresh, disposable ACP session with no Copse native-tool bridge, so it cannot
recursively call this router. It runs in disposable scratch with the configured process sandbox and asks for its tool
permissions. Existing coding sessions and histories are not reused. The result must contain PNG
bytes, inline or in the exact workspace scratch file requested by Copse; a text success report or
an arbitrary returned path is insufficient. Copse saves a durable copy in its generated-images
profile directory and returns the bitmap inline. Scratch files and sessions are cleaned up.

Local coding-agent routing is unavailable in SSH workspaces and unattended container turns.
These contexts can still reach the separately approved API fallback through the normal approval
system. The Codex nested-sandbox helper limitation remains unchanged.

## Acceptance and validation

Implementation base: `bca1bf085` (27 November 2026). Scope is routing, capability configuration,
and the explicit fallback; it does not add image editing or change sandbox policy.

Focused tests cover route order, eligibility, failures, approval denial and cancellation, plus a
real in-memory ACP session delivering a PNG. `tests/e2e/image-gen-routing.e2e.ts` runs a fixture
ACP child through the real tool, verifies the inline bitmap, changes the capability setting, and
captures the explicit API fallback approval before declining it. These fixtures spend no model
or image API allowance; live provider availability remains account- and adapter-dependent.

Local validation on macOS with Node 24.22.1:

- Build and the full TypeScript check pass; changed-file lint and formatting pass.
- 103 focused unit/component checks pass, including the copy scanner.
- Both Electron cases pass; the bitmap, routing setting and API approval screenshots were inspected.
- After rebasing onto `151d3d114`, `pnpm run check` passed all static stages and ran 20,011 tests:
  19,996 passed, 12 skipped and 3 failed. The two coverage-gate failures (area rows and retained
  floors) and one checkup failure (a host window-crash record) reproduce on a clean, separately
  installed checkout of `bca1bf085`; those test files are unchanged by the rebase. No new failures
  were observed. The build and both focused Electron cases also passed again after the rebase;
  the setting and approval screenshots exactly match the inspected evidence copies.

Live validation on 27 November 2026 also passed on macOS using the implementation above,
an isolated desktop profile, the native ChatGPT plan provider (`gpt-6.2-sol`) and real
`@agentclientprotocol/codex-acp` 2.12.0 (Codex CLI 0.171.0). One composer request produced one
`image_gen` call and a valid 1254 × 1254 PNG (2,139,860 bytes), displayed inline and saved durably.
The [reviewable evidence](evidence/image-generation-routing/README.md) includes the live result,
runner setting and API approval screenshots. The Codex rollout confirms a native
`image_gen__imagegen` call. No OpenAI API key was configured;
both API-key environment variables were blank for the app and runner. No paid API fallback or
runner approval was requested. The thread analyzer passed. Evidence is retained locally under
`.tmp/image-live/` (thread export, generated PNG, screenshots, driver and report).

The stock eval host rejects plan inference, so this check used normal desktop mode with its
instance lock and the same isolated profile, authenticated through supported browser login.
Two preliminary harness attempts stopped before image generation: the eval-host restriction and
a corrected model-filter interaction. The successful run signed out its isolated plan registration,
removed runner scratch and left the disposable project Git-clean; its processes were stopped.

The real Codex trace still contains `sandbox_apply: Operation not permitted` for shell and
`node_repl` helpers. Native image generation succeeded despite those helper failures; this is
not evidence that nested sandboxing is fixed. This single-account check establishes one successful
route, not general provider availability or reliability. No paid Images API request was made.
