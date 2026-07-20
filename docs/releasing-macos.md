# Releasing Copse for macOS

How to publish signed, notarized macOS builds through Copse's public stable and
beta channels. Run the [general release checklist](release-checklist.md) for
every release; this document covers channel policy and macOS packaging.

The supported target is macOS 26 or newer on Apple Silicon (`arm64`) and Intel
(`x64`). Copse cannot use the Mac App Store or TestFlight because its shell and
PTY functionality is incompatible with the App Sandbox. Distribution is a
Developer ID-signed, Apple-notarized direct download with updates from GitHub
Releases.

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

GitHub release assets must be anonymously reachable. Before a public beta or
stable launch, make this repository public or move `build.publish` to a public
download endpoint and verify the feed from a signed-out browser. A GitHub
Release in a private repository is not public distribution.

## What the build produces

`electron-builder` emits the following files into `release/` for each
architecture:

| Artifact                                 | Purpose                                      |
| ---------------------------------------- | -------------------------------------------- |
| `Copse-<ver>-<arch>.dmg`                 | First-install disk image.                    |
| `Copse-<ver>-<arch>.zip` (+ `.blockmap`) | Payload and differential-update metadata.    |
| `latest-mac.yml` or `beta-mac.yml`       | Channel feed consumed by `electron-updater`. |
| `SHA256SUMS`                             | Checksums for every promoted artifact.       |

A stable build also mirrors its tested latest metadata into the beta feed so an
installed beta can advance to that stable version. The workflow publishes every
finalized macOS metadata file with the exact zip files it references.

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

`GITHUB_TOKEN` is provided automatically for publishing. The release workflow
fails before packaging if a required signing or notarization credential is
missing.

## Publishing through CI

Only [the `Release (macOS)` workflow](../.github/workflows/release-mac.yml)
publishes releases. Local commands are deliberately non-publishing so the
signed, notarized, smoke-tested artifacts cannot be replaced by a separate
local build.

1. Complete [the release checklist](release-checklist.md), including security
   review and GA-blocker handling.
2. Set `package.json` to the next supported version, such as `0.1.0-beta.2` or
   `0.1.0`.
3. Merge that version to `main`, then create and push the exact matching tag.
   For example: `git tag v0.1.0-beta.2 && git push origin v0.1.0-beta.2`.
4. Wait for the tagged commit's exact `CI Passed` check. The release workflow
   will not accept a branch-tip, merge-ref, or unrelated successful run.
5. The workflow builds, signs, notarizes, staples, verifies, smoke-tests, and
   attests the package. A separate publisher job promotes those exact files as
   a prerelease for beta or a normal/latest release for stable.
6. Review and update the generated GitHub Release notes before announcing the
   release.

A manual workflow dispatch accepts only an existing matching tag reachable
from `main`; it does not provide a bypass around those gates.

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
