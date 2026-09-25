# Releasing Copse for macOS

How to publish signed, notarized macOS builds through Copse's public stable and
beta channels. Run the [general release checklist](release-checklist.md) for
every release; this document covers channel policy and macOS packaging.

The supported target is macOS 26 or newer on Apple Silicon (`arm64`) and Intel
(`x64`). Copse cannot use the Mac App Store or TestFlight because its shell and
PTY functionality is incompatible with the App Sandbox. Distribution is a
Developer ID-signed, Apple-notarized direct download with updates from the
public, binary-only
[`copse-dev/copse-releases`](https://github.com/copse-dev/copse-releases)
repository.

## Channel contract

The package version is the sole source of truth. The release workflow rejects
every other prerelease shape instead of guessing:

| Package/tag shape             | Copse channel | Update feed      | GitHub release |
| ----------------------------- | ------------- | ---------------- | -------------- |
| `X.Y.Z` / `vX.Y.Z`            | Stable        | `latest-mac.yml` | Normal/latest  |
| `X.Y.Z-beta.N` / matching tag | Beta          | `beta-mac.yml`   | Prerelease     |

Stable users receive only stable releases. Beta users receive newer beta
releases and may advance to a newer stable release. Neither channel permits a
downgrade. The shared classifier in
[`src/shared/release-channel.mts`](../src/shared/release-channel.mts) drives both
the packaged app and the release workflow so their routing cannot drift.

GitHub release assets must be anonymously reachable. `build.publish` therefore
points at `copse-dev/copse-releases`, not this source repository. The source can
remain private during beta testing; the binary repository and its release
assets are public. Verify every feed and installer from a signed-out browser.

## What the build produces

`electron-builder` emits the following files into `release/` for each
architecture. Release CI builds the architectures in separate jobs, so neither
package contains the other architecture's application or native helper:

| Artifact                                 | Purpose                                      |
| ---------------------------------------- | -------------------------------------------- |
| `Copse-<ver>-<arch>.dmg`                 | First-install disk image.                    |
| `Copse-<ver>-<arch>.zip` (+ `.blockmap`) | Payload and differential-update metadata.    |
| `latest-mac.yml` or `beta-mac.yml`       | Channel feed consumed by `electron-updater`. |
| `SHA256SUMS`                             | Checksums for every promoted artifact.       |

GitHub Actions always downloads each named CI artifact as an outer ZIP. During
pre-publication review, opening the architecture artifact therefore reveals the
DMG plus a second ZIP and its blockmap: the outer ZIP is only Actions' transport
wrapper, while the inner ZIP is the architecture-specific automatic-update
payload. A published GitHub Release lists the DMG and updater files separately;
a person installing Copse downloads only the matching DMG.

A stable build also mirrors its tested latest metadata into the beta feed so an
installed beta can advance to that stable version. The workflow publishes every
finalized macOS metadata file with the exact zip files it references.

CI fails an architecture job if either client-downloadable DMG/ZIP exceeds 230
MiB or the installed app exceeds 750 MiB. The two architecture artifacts remain
separate in Actions; a small third artifact carries the combined update feed,
portable checksums, and release notes. GitHub Releases expose the individual
files, so a client downloads only the DMG or ZIP matching its own architecture.

The app embeds `LSMinimumSystemVersion=26.0`, uses the hardened runtime, and
applies the entitlements in
[`build/entitlements.mac.plist`](../build/entitlements.mac.plist). CI verifies
the deployment target, signatures, notarization ticket, bundled-helper
architecture, update configuration, and packaged runtime before publication.

## Required credentials

The repository needs these Actions secrets:

| Secret                        | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `MAC_CSC_LINK`                | Base64-encoded Developer ID Application `.p12`. |
| `MAC_CSC_KEY_PASSWORD`        | Password used when exporting the `.p12`.        |
| `APPLE_ID`                    | Apple ID used for notarization.                 |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID.        |
| `APPLE_TEAM_ID`               | Apple Developer Team ID.                        |

`RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY` mint the narrowly scoped token
that publishes into `copse-dev/copse-releases`; the GitHub App must be installed
there with Contents write permission. `GITHUB_TOKEN` remains scoped to the
private source run and its Actions artifacts. The release workflow fails before
packaging if a required signing or notarization credential is missing.

## Publishing through CI

Only [the `Release (macOS)` workflow](../.github/workflows/release-mac.yml)
creates distributable artifacts, and only
[`Publish release artifacts`](../.github/workflows/release-publish.yml) creates
GitHub Releases from them. Local commands are deliberately non-publishing so
the signed, notarized, smoke-tested artifacts cannot be replaced by a separate
local build.

Releases are cut from `release`, not from trunk. `main` absorbs the day's
merges under the light CI tier; the daily promotion PR runs the full tier once
for the whole batch and is what the ruleset gates on. `release` is therefore the
only branch that is always in a state a release can be cut from.

The version in `package.json` is the trigger, and
[`Bump release version`](../.github/workflows/release-bump.yml) bumps it every
Monday. Publishing is the only routine manual step:

1. `Bump release version` opens a PR into `main` that sets `package.json` to the
   next beta (`0.1.0-beta.9` → `0.1.0-beta.10`; after a stable `X.Y.Z`, the
   next is `X.Y.(Z+1)-beta.1`) and runs
   [`scripts/release-bump.mts`](../scripts/release-bump.mts) to rename
   `CHANGELOG.md`'s `Unreleased` section to `## <version>`, open a fresh empty
   `Unreleased` above it, and drop the previous version's section. The PR
   auto-merges when `CI Passed` is green. The week is skipped, with a notice on
   the run, when the current version has not been published yet or `Unreleased`
   is empty. To hold a release, disable auto-merge on the PR; to change its
   notes, edit the `## <version>` section on the PR branch.
2. Let [the daily promotion](../.github/workflows/promote-develop.yml) carry
   `main` to `release`, or dispatch it early. Merging requires the full
   `CI Passed` tier.
3. [`Cut release tag`](../.github/workflows/release-cut.yml) sees the new
   version on `release`, creates `v<version>` at that exact commit, and starts
   `Release (macOS)`. A promotion whose version is already tagged is a no-op, so
   ordinary promotions cut nothing.
4. `Release (macOS)` re-checks the tag, the version match, reachability from
   `release`, and the tagged commit's exact `CI Passed` check — it will not
   accept a branch-tip, merge-ref, or unrelated successful run. It then builds,
   signs, notarizes, staples, verifies, and smoke-tests the package, then uploads
   two immutable architecture-specific Actions artifacts plus a small metadata
   artifact containing the combined feeds, checksums, and notes generated from
   the `## <version>` section of `CHANGELOG.md`. It does not create a GitHub
   Release.
5. Review and install-test the artifact for each architecture. When accepted,
   manually dispatch `Publish release artifacts` with the tag and successful
   `Release (macOS)` run ID. The publisher verifies the source workflow,
   successful conclusion, exact tagged SHA, checksums, and public target state,
   then creates a prerelease for beta or a normal/latest release for stable in
   `copse-dev/copse-releases`. It never rebuilds. GitHub artifact attestation is
   added automatically once the source repository is public; until then the
   signed build, immutable Actions artifact, and published SHA256 manifest are
   the integrity chain available on this GitHub Team plan. Publishing is what
   lets the next Monday's bump proceed.
6. Review the published GitHub Release notes and add known issues before
   announcing the release.

From bump to signed artifacts takes about a day: the bump merges on Monday,
that day's promotion runs the full tier, and the signed build waits for the
tagged commit's `CI Passed` before its roughly hour-long packaging run.

### Cutting a release by hand

Stable releases are never cut on schedule. To cut one — or any version other
than the next beta, such as a minor jump — dispatch `Bump release version` with
the version, or run `node scripts/release-bump.mts <version>` and open the PR
yourself. Complete [the release checklist](release-checklist.md) first,
including security review and GA-blocker handling. Do not edit `package.json`
alone: the release jobs fail closed when the version has no `## <version>`
section in `CHANGELOG.md`.

### Failed releases

A version is cut exactly once. If its release run fails, fix forward and bump to
the next version rather than re-cutting the same one: the publisher refuses to
replace an existing release, and downgrade is not a supported rollback. The
weekly bump waits for the failed version to be published, so abandoning one is a
manual bump: move the abandoned `## <version>` section's entries back into
`Unreleased` (the bump drops earlier version sections), then run
`node scripts/release-bump.mts`.

A manual dispatch of `Release (macOS)` accepts only an existing matching tag
reachable from `release`; it does not provide a bypass around those gates.

Private-repository artifact attestation requires GitHub Enterprise Cloud and
this organization is on Team. While the source remains private, both workflows
skip attestation rather than blocking beta distribution. After the source opens,
the publisher attests the same downloaded bytes before creating the release.

## Local validation

Both local distribution commands build `arm64` and `x64`, choose the feed from
`package.json`, and never publish:

| Command               | Signs | Notarizes | Publishes | Purpose                                  |
| --------------------- | :---: | :-------: | :-------: | ---------------------------------------- |
| `npm run dist:mac`    |  ✓\*  |           |           | Fast packaging and feed-generation check |
| `npm run release:dry` |   ✓   |     ✓     |           | Full signing/notarization rehearsal      |

\* `dist:mac` signs only when a Developer ID identity is available in the
Keychain. `release:dry` reads signing/notarization values from the environment;
it does not upload. `npm run pack:mac` creates a quick unsigned `.app` directory
for development and is not distributable.

Validate a signed app bundle rather than the enclosing DMG:

```bash
spctl -a -vvv -t install "release/mac-arm64/Copse.app"
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Copse.app"
xcrun stapler validate "release/mac-arm64/Copse.app"
```

After downloading an Actions artifact or the files from a GitHub Release into
one directory, verify every distributable byte from that directory:

```bash
shasum -a 256 --check SHA256SUMS
```

## Install and update behavior

New users download the architecture-appropriate DMG from the public GitHub
Release and drag Copse to Applications. On launch, and through **Copse ▸ Check
for Updates…**, the packaged app checks its selected channel. It prompts before
downloading and prompts again before restarting to install; updates are never
applied silently.

Before announcing either channel, exercise the real transition with installed
signed builds:

- Stable old → stable new succeeds; stable old does not see a beta-only release.
- Beta old → beta new succeeds.
- Beta old → newer stable succeeds.
- A lower version is never offered, even if its release was published later.

Auto-update wiring lives in
[`src/main/services/auto-update.ts`](../src/main/services/auto-update.ts) and is
active only in packaged macOS builds.

## Recovery and current scope

- Releases are forward-fix only. Preserve affected data and publish a newer
  corrective version; do not direct users to downgrade. See
  [recovery.md](recovery.md).
- Windows and Linux packages do not yet have an equivalent command-execution
  containment boundary and are not public distribution targets.
- The bundled `gortex` helper is `asarUnpack`ed and signed with the app. Verify
  semantic search in the notarized rehearsal; Copse can fall back to a system
  `gortex`/`vera` or plain search if the helper is unavailable.
