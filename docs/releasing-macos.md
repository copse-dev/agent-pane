# Releasing Copse for macOS (pre-release)

How to cut a signed, notarized macOS build of Copse and ship it to pre-release
testers, with automatic updates via `electron-updater`.

Because Copse runs arbitrary shell commands and spawns `node-pty`, it is **not
distributed through the Mac App Store / TestFlight** (the App Sandbox those
require forbids that). Instead we ship a **Developer ID-signed, Apple-notarized**
build as a direct download, and auto-update it from GitHub Releases.

## What the build produces

`electron-builder` (config in `package.json` → `build`) emits, per architecture
(`arm64`, `x64`), into `release/`:

| Artifact                                 | Purpose                                                        |
| ---------------------------------------- | -------------------------------------------------------------- |
| `Copse-<ver>-<arch>.dmg`                 | First install — the disk image testers download and open.      |
| `Copse-<ver>-<arch>.zip` (+ `.blockmap`) | The payload `electron-updater` downloads for updates.          |
| `latest-mac.yml`                         | The update feed `electron-updater` reads to detect new builds. |

`<arch>` is `arm64` (Apple Silicon) or `x64` (Intel).

The app is signed with the **hardened runtime** and the entitlements in
[`build/entitlements.mac.plist`](../build/entitlements.mac.plist) (JIT / unsigned
executable memory / library-validation-disabled / dyld env vars — required for
Electron + native modules + spawned helpers).

## Prerequisites

1. **Apple Developer Program** membership (the Team ID).
2. A **Developer ID Application** certificate, exported from Keychain Access as a
   password-protected `.p12` (includes its private key).
3. **Notary credentials** — an Apple ID, an
   [app-specific password](https://support.apple.com/en-us/102654), and the Team
   ID. (An App Store Connect API key works too; adjust the env vars accordingly.)
4. Node ≥ 22.18 and a macOS machine (signing/notarization can't run on Linux).

## Required CI secrets

Set these on the repo (Settings → Secrets and variables → Actions). They feed the
[`Release (macOS)`](../.github/workflows/release-mac.yml) workflow:

| Secret                        | What it is                                                      |
| ----------------------------- | --------------------------------------------------------------- |
| `MAC_CSC_LINK`                | The Developer ID `.p12`, base64-encoded (`base64 -i cert.p12`). |
| `MAC_CSC_KEY_PASSWORD`        | The `.p12` export password.                                     |
| `APPLE_ID`                    | Apple ID email used for notarization.                           |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID.                        |
| `APPLE_TEAM_ID`               | Your Apple Developer Team ID.                                   |

`GITHUB_TOKEN` (auto-provided) handles the GitHub Release upload — no extra
secret needed.

## Releasing via CI (recommended)

1. Bump `version` in `package.json` (e.g. `0.1.0-beta.2`).
2. Push a matching tag: `git tag v0.1.0-beta.2 && git push origin v0.1.0-beta.2`
   — or run the **Release (macOS)** workflow manually (Actions → Run workflow).
3. The workflow builds, signs, notarizes, staples, and publishes a GitHub
   **prerelease** with the DMG, zip, and `latest-mac.yml` attached.

A manual run with **publish = false** does an unsigned dry-run build and uploads
the artifacts to the run (no Release, no notarization) — handy for smoke-testing
packaging changes.

## Releasing locally

First load your Apple credentials into the shell (notarization needs them; signing
auto-discovers the Developer ID identity from your Keychain):

```bash
set -a; source .env; set +a   # APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID (+ GH_TOKEN to publish)
```

Then pick a command — each builds arm64 + x64:

| Command               | Signs | Notarizes | Publishes | Use for                                  |
| --------------------- | :---: | :-------: | :-------: | ---------------------------------------- |
| `npm run dist:mac`    |  ✓\*  |           |           | Fast packaging check                     |
| `npm run release:dry` |   ✓   |     ✓     |           | Verify signing + notarization, no upload |
| `npm run release`     |   ✓   |     ✓     |     ✓     | Cut the actual GitHub prerelease         |

\* `dist:mac` signs only if a Developer ID identity is in your Keychain.

`npm run pack:mac` produces a quick **unsigned** `.app` (`--mac dir`) for local
poking; it isn't a distributable.

### Verifying a signed build

The notarization ticket is stapled to the **`.app`** (then wrapped in the DMG), so
validate the app, not the DMG:

```bash
spctl -a -vvv -t install "release/mac-arm64/Copse.app"   # → "accepted, source=Notarized Developer ID"
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Copse.app"
stapler validate "release/mac-arm64/Copse.app"
```

Artifacts are named with their architecture — `Copse-<ver>-arm64.dmg` (Apple
Silicon) and `Copse-<ver>-x64.dmg` (Intel) — so testers don't grab the wrong one.

## How testers install & update

1. Download the DMG from the GitHub prerelease, open it, drag **Copse** to
   Applications. (The repo is private, so testers need read access to the repo,
   or share the asset link with them.)
2. On launch — and via **Copse ▸ Check for Updates…** — the app checks the feed.
   When a newer prerelease is published, it prompts to download, then prompts to
   restart and install. Updates are never applied silently.

Auto-update wiring lives in [`src/main/services/auto-update.ts`](../src/main/services/auto-update.ts);
it is active only in the packaged macOS build.

## Known limitations / follow-ups

- **codesearch binary signing.** The bundled `vendor/codesearch` binary is
  `asarUnpack`ed so electron-builder signs it under the hardened runtime. Verify
  semantic search works in a notarized build; if Gatekeeper blocks it, the app
  falls back to a system `codesearch`/`vera` on `PATH`, and plain search still
  works.
- **Private-repo distribution.** GitHub Releases on a private repo require
  testers to have repo access. If that's friction, switch `build.publish` /
  hosting to a public static endpoint (see issue #507).
- **Windows/Linux** packaging and updates are not set up yet.
- **CI cost.** The release runs on a GitHub-hosted `macos-14` runner; a
  self-hosted Mac is also available (the e2e runners) if minutes become a concern.
