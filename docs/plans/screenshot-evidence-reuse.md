# Screenshot evidence reuse: rendering-input identity

Status: **Proposed, shadow mode**. Compiled 15 October 2026 against main
`82d60dc`. Item 3 of the recovery throughput plan proposed in
[#3770](https://github.com/copse-dev/agent-pane/pull/3770) ("Reuse evidence when
rendering inputs are unchanged"). This document audits what already reuses
screenshot evidence, defines a rendering-input identity, and says how to measure
it. It changes **no** gate, status, label, publisher or acceptance path. Reusing
a render across runs stays unimplemented until the measurement below clears its
threshold and a separate policy change lands.

## Why

Every CI e2e shard re-renders the reference PNGs its specs own. On a small PR
most of those renders are expected to be pixel-identical to the committed
baseline, and the ones that are not are mostly anti-aliasing noise
(`filter-screenshots.mts`). Reusing a completed render is only sound if we can
say, from recorded inputs alone, that nothing which reaches the pixels changed,
and if we can show that identical inputs really do produce identical bytes on
the runners we use. Neither is known today. The first is a definition problem;
the second is an empirical one. This plan supplies the definition and the
instrument, and defers the decision.

## Part 1: what already reuses evidence

The recovery plan noted that "some baseline-only acceptance already reuses
completed source evidence". The table names every such mechanism on `main`,
what it reuses, what binds that reuse to its source, and what it does **not**
cover. None of them is a rendering-input identity, and none transfers a review
decision to a different head.

| Mechanism                                                                                                                                                                                               | Evidence reused                                                                                                                                                                                                            | Bound to                                                                                                                                                                                                                                                                                                                                 | Not covered                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Screenshot-only escape** (`ci.yml` `precheck` plan step)                                                                                                                                              | The parent run's e2e result. When the HEAD commit changes only `tests/e2e/screenshots/manifest.json` and `README.md`, the plan is `mode=skip` and no e2e shard is dispatched.                                              | The commit's own diff (`HEAD^..HEAD`). The aggregate `CI Passed` accepts `skip` only with zero shards and still requires `precheck`, `check`, `build` and R2 baseline verification (`scripts/ci-gate.test.ts`). A declared stack tip is excluded and always runs the full suite.                                                         | Nothing checks that the accepted hashes came from a successful run on the parent of this commit, that the parent run's inputs equal this head's inputs, or that the PNGs the manifest now names were rendered from this source. It is a diff-shape rule, not an identity. It also skips e2e for a manifest edit made by hand.                               |
| **Manifest and R2 object model** ([#3739](https://github.com/copse-dev/agent-pane/pull/3739); `scripts/lib/screenshot-manifest.mts`, `scripts/screenshot-storage.mts`)                                  | Immutable PNG bytes. Git carries `name → {sha256, bytes}`; R2 stores `screenshots/sha256/<hash>.png`. Hydration (`screenshot-hydration.mts`) restores a baseline from cache or R2 and verifies hash and length before use. | Content: a manifest entry is bound to bytes, and `verifyScreenshot` fails closed on a mismatch. `screenshots:accept --from <ref>` copies entries from a candidate ref's manifest only after downloading and verifying every object.                                                                                                      | Provenance. An object key says what the bytes are, not which run, runner, source tree or spec produced them. Two different heads that render the same bytes share one object; the manifest cannot say whether a hash is "fresh for this head". Acceptance verifies integrity, never origin.                                                                 |
| **Review packets and receipts** ([#3741](https://github.com/copse-dev/agent-pane/pull/3741); `docs/screenshot-review-packets.md`, `scripts/screenshot-review.mts`, `lib/screenshot-review-records.mts`) | A reviewer's classification of one image pair (`before`, `after` hashes and dimensions) as intentional, drift, instability, breakage or unresolved.                                                                        | An evidence fingerprint over repository, PR, mode, base, head, compare and run, plus a per-item key over the pair. `collect` verifies the compare commit has exactly one parent (the head), changes only screenshot evidence, and that the run is successful current-head CI.                                                            | Rendering inputs. A receipt whose pair matches but whose fingerprint differs is shown as **revalidate**, never recorded; the packet is explicitly "not an approval service" and never writes a status. Equal pair bytes at a different base/head/run are, by design, insufficient. It cannot tell why two renders differ (source, fixture, runner, font).   |
| **Stack coverage attestation** ([#3766](https://github.com/copse-dev/agent-pane/pull/3766); `scripts/screenshot-stack.mts`, `docs/testing-strategy.md` "Reviewing a small PR stack once")               | One combined tip render and one explicit tip decision, reused as the `Screenshot review` result of every lower PR.                                                                                                         | The declaration digest, each lower PR's **pinned full head SHA**, an ordered ancestor chain contained in the exact tip head, an open ready tip, and a `Stack coverage` status the publisher writes only after a successful full-suite run on that head. Every member is re-read after the status reads to reject racing pushes.          | Any head not pinned. A moved lower head, changed membership, or edited declaration cannot reuse the deferral. The attestation says "the tip rendered everything lower layers affect", not "lower layers render identically to the tip". It consolidates one review across PRs; it does not avoid a render.                                                  |
| **Bounded oracle refresh planner** (`docs/plans/ci-base-freshness.md` "Bounded oracle refresh planning"; `scripts/test-oracle.mts --refresh`, `lib/oracle-refresh.mts`)                                 | A previous validated run of an unchanged PR source head, when the target branch has advanced.                                                                                                                              | The previously tested base, candidate and **exact** source SHA must be ancestors of the fresh candidate and the source head must be byte-identical. The plan maps PR and base changes separately in immutable Git trees and returns `skip`, a capped explicit `subset`, or `review`. Global build/workflow/oracle inputs force `review`. | Pixels. It plans tests, including e2e specs, from the import graph, selectors and an IPC contract area; it does not know Electron, Chromium, fonts, runner image or capture configuration, and it never claims two renders are equal. No controller consumes it yet: "advisory impact evidence, not proof of semantic independence or merge authorization". |

Two conclusions follow. First, the only transferable artefacts today are
**verified bytes** (manifest/R2) and **pinned-head attestations** (stack); every
other reuse is a diff-shape shortcut or a human note that the next head must
revalidate. Second, every mechanism treats equality of PNG bytes or of source
paths as a prompt to look again, never as proof. The identity below keeps that
posture.

## Part 2: rendering-input identity (observe only)

`scripts/lib/screenshot-identity.mts` defines the identity;
`scripts/screenshot-identity.mts` records it; the `e2e` job in `ci.yml` uploads
one record set per shard as `screenshot-identity-shard-<n>` on every event that
runs e2e. Both workflow steps are `continue-on-error` and nothing reads the
artifact. `scripts/lib/screenshot-identity.test.ts` holds the contract tests.

### Inputs

For each spec in the shard, the identity covers six **disjoint** classes. The
mapping is the test oracle's own, exported rather than re-implemented
(`reachableFiles`, `extractSpecTokens` + `tokenMatcher`, `BROAD_PATTERNS`,
`listSourceFiles`), so the identity and the CI
selector cannot drift apart silently.

Output ownership uses parsed capture calls and their filename argument positions,
including constant filenames passed with additional arguments. It does not scan
selector strings, callbacks, fixture PNGs or unused table properties for names.
Direct native captures must target the named screenshot directory. Finite dynamic
writers that cannot be inferred this way are declared in
`scripts/lib/native-screenshot-outputs-audit.mts`: exact native spec, source digest
and output filenames. These cover the settings continuation pages, table-driven
captures, local wrappers and decoded guest/explainer PNG writes. There are no
wildcards or browser-only grants. A changed producer revokes its declarations;
re-audit its actual output paths before updating the digest or filenames. Tests
check the declarations against the current source and retain duplicate-owner
rejection. An unknown baseline PNG written after the marker still invalidates
every rendered flag; these declarations do not weaken that control.

| Class          | Contents                                                                                                                                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec`         | The spec file and every local file reachable through its import graph (helpers, seed data, `src/shared`, workspace packages, `.json` data).                                                                                                                                                                 |
| `fixtures`     | All of `tests/e2e/fixtures/`, `tests/e2e/scenarios/`, `tests/demo/` (the oracle's broad fixture inputs) plus any `tests/fixtures/...` or `tests/e2e/fixtures/...` path the spec or its imports name as a string literal; a literal directory contributes every file under it.                               |
| `renderer`     | Shipped `src/**` code, CSS and HTML that contains one of the spec's selector tokens (ids, classes, aria/title text, minus the oracle's stoplist), plus the broad renderer globals: `index.html`, the entry modules, the shared stylesheets, preload, shared store, `main/index.ts` and `main/ipc/index.ts`. |
| `assets`       | Everything under `assets/` (the bundled fonts, marks and icons `scripts/build.mts` copies into the renderer).                                                                                                                                                                                               |
| `dependencies` | `pnpm-lock.yaml`, `package.json`, `.nvmrc`, `.npmrc`, `tsconfig*.json`.                                                                                                                                                                                                                                     |
| `capture`      | `wdio.*.conf.ts`, all of `tests/e2e/helpers/` (viewport, device scale factor, framing, settled-layout waits), `tests/e2e/electron-shell/`, `scripts/run-e2e.mts` (virtual display geometry) and the broad build scripts.                                                                                    |

The runtime is a separate `environment` object: Electron version (installed
package), Chromium version (read from the Electron binary, checked against
ChromeDriver, exactly as `wdio.conf.ts` does), Node version, runner OS and
architecture, runner **image** (`ImageOS/ImageVersion` on hosted runners),
`COPSE_E2E_HEADLESS`, `TZ`, and a sha256 over the sorted `fc-list` output
(system fonts). The e2e launcher's harness state file
(`tests/e2e/electron-shell/.e2e-env.json`) and the baseline manifest are
excluded: the first is runtime state, the second is the expected output.

The mapping is deliberately a superset. An input that does not really reach the
pixels can only make two identical renders look different, never make two
different renders look the same. `check:oracle` already guards the selector
side; the identity inherits that guard.

### Identity

```text
identity = sha256(canonicalJson({
  version: 1, name, spec, environment,
  inputs: { class: { path: sha256(bytes) } }
}))
```

Keys are sorted recursively, so equal structures hash equally. Provenance (run,
attempt, head, base, runner name) and the resulting PNG are **not** in the hash:
the identity names what went in, the record says what came out.

### Record

One file per shard (`screenshot-identity/shard-<n>.json`):

```jsonc
{
  "version": 1,
  "provenance": { "repository", "run", "attempt", "job", "event", "shard": "3/8",
                  "checkout", "head", "base", "runner": { "name", "environment" } },
  "environment": { "electron", "chromium", "node", "os", "arch", "image",
                   "headless", "timezone", "systemFonts" },
  "marker": "valid" | "missing" | "invalidated",
  "files": { "<path>": "<sha256>" },
  "records": [{
    "name": "settings-panel.png", "spec": "tests/e2e/settings.e2e.ts",
    "identity": "<sha256>",
    "inputs": { "spec": [...], "fixtures": [...], "renderer": [...],
                "assets": [...], "dependencies": [...], "capture": [...] },
    "result": { "sha256": "<png sha256>", "bytes": 123456, "rendered": true } | null
  }]
}
```

`rendered` answers "did this shard's specs write the PNG, or is it the restored
baseline?". The `prepare` step hydrates baselines, then stamps a marker; the
launcher's own hydration skips files that already exist, so a PNG newer than the
marker was written by a spec. If **any** PNG no spec of the shard owns is newer
than the marker, something else wrote after it and `marker` becomes
`invalidated`: every `rendered` is `null` rather than a guess. A missing marker
(the prepare step failed) is `missing` with the same effect.

### Decoder

`parseIdentityRecords` is the only way in. It uses `safeJsonParse` with a strict
zod schema and then refuses: provenance that is missing, blank, malformed (a
non-commit SHA, a zero run id, a shard index past its total) or carries unknown
fields; an environment field that is missing; an input with no hash; a path
listed in two classes or escaping the repository; a spec absent from its own
`spec` inputs; a duplicate screenshot name; unsorted inputs; and any record whose
`identity` does not recompute from the listed hashes and environment. The CLI
runs its own output through the decoder before writing it.

### Tests

`scripts/lib/screenshot-identity.test.ts` builds an in-memory repository shaped
like this one and asserts, for one screenshot:

- the identity is deterministic and independent of key order;
- it does **not** change when the rendered bytes or the provenance change;
- it **does** change when each input class changes: the spec, an imported
  helper, a named fixture file, a file under a named fixture directory, renderer
  source holding one of its selectors, a broad renderer global, a font asset,
  the lockfile, the capture helpers, the wdio configuration, the launcher
  geometry, and each of the Electron version, Chromium version, runner image,
  system fonts, headless mode and timezone;
- it does not change for renderer source the oracle does not map to the spec
  (an unrelated view, another spec's selector, a new unreachable file);
- the marker semantics above hold (rendered, restored, missing, invalidated);
- two specs writing the same screenshot name is an error;
- the decoder round-trips a valid record set and rejects each forged or
  incomplete shape listed above.

### Known gaps

- **Self-hosted runner image.** Hosted runners expose `ImageOS`/`ImageVersion`;
  the `ci-runners` Docker image exposes no image identity, so a self-hosted
  record carries `self-hosted:unknown-image`. The `fc-list` digest and the
  Electron/Chromium versions still discriminate most of what an image changes.
  Stamping an image digest into the runner image is a follow-up before any
  cross-runner reuse.
- **Dynamic screenshot names and skipped specs.** The spec → screenshot map is
  the oracle's regex over `save*Screenshot(...)` calls. A spec that skips its
  capture in CI leaves the baseline in place; the marker then reports it as
  not rendered, which is correct, but a spec that computes a name the regex
  cannot see has no record. `check:oracle` liveness does not cover this case.
- **Hidden inputs.** Chromium's rendering also depends on GPU/software
  rasteriser flags, locale and the virtual display depth. The flags live in
  `wdio.conf.ts` and `scripts/run-e2e.mts` (hashed), but a runner-level change
  to the X server or Mesa would not move the identity. The measurement below
  exists to expose exactly this kind of unknown.

## Part 3: measuring before deciding

Records accumulate at 14-day retention on every pull request, merge-group and
nightly e2e run. The measurement is a read-only script over downloaded artifacts
(a follow-up, not in this change) that groups records by `identity` and reports:

1. **Determinism rate per identity**: among records with `marker: valid` and
   `rendered: true`, the share of identity groups with two or more renders whose
   `result.sha256` values are all equal, overall and per screenshot name.
   Groups with a single render are counted but not scored.
2. **Cross-runner rate**: the same statistic restricted to groups whose records
   span two or more `environment.image` values or `runner.environment` values,
   reported separately for hosted-only, self-hosted-only and mixed groups.
3. **Fuzzy agreement**: for groups that fail exact equality, the pixel distance
   `filter-screenshots.mts` would assign; this separates genuine
   non-determinism from the known anti-aliasing noise and must never be folded
   into the exact rate.
4. **Coverage**: the share of CI-rendered screenshots that have a record at all,
   and the share of records with `marker: invalidated` or `missing`; a high
   invalidated share means the marker design is wrong, not that renders are
   stable.
5. **Identity churn**: how often a screenshot's identity changes on `main` per
   week and which class drove it. If `renderer` or `capture` changes dominate,
   the superset mapping is too coarse for reuse to ever trigger and the
   proposal should stop here.

### Threshold to proceed

A reuse proposal may be written only when, over at least four weeks and at
least 200 scored identity groups per runner class:

- the exact determinism rate is **100%** within a runner class for every
  screenshot that reuse would cover (one counter-example disqualifies that
  screenshot, not the whole set);
- the mixed cross-runner rate is reported, and reuse is proposed only within a
  runner class unless that rate is also 100%;
- the `invalidated` + `missing` share is below 2%, so the rendered flag is
  trustworthy;
- the known gaps above are closed or shown not to matter in the data.

If the exact rate is below 100% within a class, the next step is to find and fix
the non-determinism (as the recovery plan did for framing and settled-state
waits), not to lower the bar. The anti-aliasing filter's thresholds are a review
aid; they are not a reuse criterion.

### What any later proposal must still respect

- **Equal PNG hashes alone are insufficient.** Two renders can agree by
  coincidence or because both are stale; only an identity match plus a
  measured determinism record for that identity says anything, and even then it
  says "we expect this render", not "this render is approved".
- **Equal source paths alone are insufficient.** The identity hashes bytes, not
  names; a reused record must carry the hashes it was computed from and the
  decoder must recompute the identity before anything trusts it.
- **Decisions stay tied to the landing head.** A screenshot review decision, a
  stack decision and `CI Passed` remain statuses on the exact head that lands.
  Reuse, if it ever ships, may skip a render; it may not copy a decision from
  one head to another, exactly as review receipts already refuse to.
- **The publisher gains no write tokens.** `screenshot-artifacts` keeps
  `contents: read`, the trusted publisher keeps its job token and its own
  verification of the parent head, and this change adds no token, status or
  branch write anywhere. An identity record is data a reader verifies, never a
  credential.
- **Fail closed.** A record the decoder rejects, an unknown image, an
  invalidated marker or a missing identity means "render", the same way an
  unmapped file means `full` in the oracle today.

## Relationship to the sibling steps

Step 1 measures candidate amplification in `screenshot-artifacts` and
`filter-screenshots.mts`; this change does not touch either and its artifact
lives beside, not inside, the candidate set, so the publisher's strict
candidate validation is unaffected. Step 2 (stack gates) and step 5 (gate
audit) are policy surfaces this document only references. Once the measurement
script exists and the first month of data is in, update this status and the
recovery plan's item 3 with the observed rates.
