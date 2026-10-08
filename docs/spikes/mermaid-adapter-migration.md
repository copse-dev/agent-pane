# Mermaid adapter migration

## Task brief

Extract Copse's opaque Mermaid execution boundary into optional streaming-markdown
entry points, then consume it from Copse. Acceptance: inline and expanded diagrams
retain their appearance; only source and bounded dimensions cross the boundary;
SVG/image/CSS/font/fetch probes deliver zero requests; Electron blocks navigation.
Regular SVG rendering and changes to the parser's default adapter are out of scope.

Copse base: f6f125cbd. Upstream base: 4794b15 (streaming-markdown 1.2.1).
This touches security and dependency integration. Required checks: full Copse
`pnpm run check`, build, focused Mermaid visual/parity/security specs, markdown
regression specs; upstream typecheck/build, unit suite and real Chromium CSP tests.
The oracle reports broad coverage, so broader Electron coverage is also required.

## Ownership

- `diagrams/mermaid/isolated`: parent frame construction, validated private-port
  protocol, bounded source/geometry, readiness, cancellation and disposal.
- `diagrams/mermaid/frame`: strict Mermaid runner, source retry, one-shot child
  bootstrap and measurements. It runs only inside the separately bundled frame.
- `diagrams/mermaid/build`: Node-only HTML builder, fixed CSP and hash-pinned script.
- Copse: packaged URL, binary Pliant fonts, theme CSS, inert failure presentation,
  hydration timing, expanded view, Electron navigation guard and native API policy.

`src/renderer/mermaid-frame.html` is now a generated dist asset, not an app template.
`scripts/write-mermaid-frame.mts` delegates document construction to the package.
`tests/mermaid-render.ts` is the parent-placement parity fixture, never app code.

## Published dependency

Copse consumes `@copse/streaming-markdown@^1.3.0` directly. The optional isolated
adapter was merged in [upstream PR #277](https://github.com/copse-dev/streaming-markdown/pull/277)
and published in [v1.3.0](https://github.com/copse-dev/streaming-markdown/releases/tag/v1.3.0).
The temporary 1.2.0 package patch and its patchedDependencies entry have been
removed. Runtime imports use the released upstream API.

Fixed-origin hosting documentation/tests and optional cacheable bootstrap assets
are tracked separately in [upstream #279](https://github.com/copse-dev/streaming-markdown/issues/279).

CSP is not a complete egress firewall: Copse must retain its native navigation
control. The migration makes no new claim about WebRTC/speculative networking,
CPU isolation or cross-platform packaging. See upstream docs/ISOLATED-MERMAID.md
for the host deployment contract.

## Completion evidence (2026-10-08)

Adapter source: `10c08b3` in upstream PR #277. Its automatic base merge is
`1c00a66`; all six [upstream CI jobs](https://github.com/copse-dev/streaming-markdown/actions/runs/37772800466)
pass. Copse changes are staged on base `f6f125cbd`.

- Upstream `npm run typecheck`, `npm run build`, `npm run size`: pass.
- Upstream `npm run coverage:ci`: 1,292 passed, two performance tests intentionally
  skipped under instrumentation; coverage gate passes at 99.97%.
- Upstream `E2E_REQUIRE_BROWSER=1 npm run test:e2e`: eight passed in real Chromium.
- Copse `pnpm run build`: pass.
- Copse `pnpm test -- mermaid reviewer-actions type-predicate-inventory`: 32 passed.
- Copse `pnpm run test:e2e -- --spec tests/e2e/mermaid-diagram.e2e.ts --spec tests/e2e/mermaid-parity.e2e.ts`:
  18 passed across both specs, including zero probe requests and native navigation blocking.
- Copse `pnpm run test:e2e:markdown`: all six specs passed.
- Copse `pnpm run check`: all static gates passed; full units finished with
  13,595 passed and one failure in the unchanged
  `src/main/project-sandbox/config.test.ts` read-only checkout test. The focused
  sandbox rerun reproduces it: `/tmp/acp-sandbox-test-workspace/**` remains writable.
- Full `pnpm run test:e2e` was stopped after the unrelated
  `apple-project-suggestion.e2e.ts` reminder notice failed to appear. This is not
  a full-suite pass; the remaining broad Electron coverage is unverified.

The full unit run also detected a tracked-file mutation: the build helper reverted
to its pre-migration contents during the run. Its cause is not established. The
unexpected contents are preserved in `.tmp/mermaid-adapter-evidence/`; the staged
migration helper was restored afterward and the build/focused tests rerun.

All 12 installed adapter JS/declaration/source-map files match the upstream build
byte-for-byte (hashes recorded in `.tmp/mermaid-adapter-evidence/package-parity.json`).
Reviewed screenshots in that directory show matching parent/isolated flowcharts
and a readable expanded diagram with intact controls. Unrelated generated reference
screenshots were restored rather than included in this migration. This evidence was collected before upstream merged and published v1.3.0.
Regular SVG support and cross-platform Copse packaging remain outside this change.

## Published release migration follow-up

Acceptance: wait for the upstream release workflow and npm publication, consume
that released version directly, remove the temporary adapter patch and its fixture,
and verify the package exports, build, full static/unit gate, and focused Mermaid
and markdown Electron coverage against the published artifact.


### v1.3.0 completion evidence (2026-10-08)

- [Release workflow](https://github.com/copse-dev/streaming-markdown/actions/runs/37784389017): success; npm installation resolves v1.3.0 with all three isolated Mermaid exports.
- `pnpm install`: pass; only streaming-markdown changed in the dependency lock.
- `pnpm run build`: pass against the published package.
- `pnpm run check`: all static gates pass; 13,595 unit tests pass, one fails in
  the same unchanged read-only sandbox test recorded above. The tracked-file
  guard also observed screenshots written by the concurrent Electron tests;
  no source changes occurred. Generated screenshots were preserved as evidence
  and restored in the working tree after testing.
- Focused Mermaid Electron specs: 18 tests pass across two specs, including
  rendering parity, lifecycle, CSP resource probes, and native navigation blocking.
- `pnpm run test:e2e:markdown`: six specs pass on the standalone rerun. The first
  concurrent run passed five specs but failed the metadata content assertion;
  the complete standalone rerun passed without source changes.
- Reviewed flowchart parity and expanded-diagram screenshots: matching layout,
  readable labels and intact modal controls. Evidence and logs are under
  `.tmp/mermaid-adapter-evidence/release-1.3.0/`.
- Broad Electron suite and cross-platform packaging were not rerun for this
  release substitution; the earlier broad-suite gap remains.

The migration is staged locally. The release bridge patch is gone; no additional
upstream release or runtime migration is needed.
