---
title: Install
description: Download Copse for macOS 26 or newer, or build it from source.
---

# Install

The supported app is **macOS 26 or newer** on Apple Silicon (`arm64`) and Intel
(`x64`). Linux and Windows can run a source build for development. They are not
supported release targets.

## Download the app

Copse is in public beta. Every release is signed with a Developer ID and
notarized by Apple.

1. Open [Copse releases](https://github.com/copse-dev/copse-releases/releases).
   The newest release is at the top.
2. Under **Assets**, download the DMG for your Mac:
   - `Copse-<version>-arm64.dmg` for Apple Silicon (M-series chips).
   - `Copse-<version>-x64.dmg` for Intel.

   Not sure which you have? Apple menu → **About This Mac**: a **Chip** line
   means Apple Silicon, a **Processor** line means Intel.

3. Open the DMG and drag Copse to Applications.
4. Open Copse from Applications. The first time, macOS asks whether to open an
   app downloaded from the internet; choose **Open**.

**You should see** the Copse window with a prompt to open a project folder.

You do not need to download later releases by hand. Copse checks for a newer
release each time it starts, and **Copse → Check for Updates…** checks on
demand. It shows what changed and asks before downloading; a downloaded update
installs when you choose **Restart now**, or the next time you quit.

Choose which releases you get in **Settings → About → Update channel**. Beta
gets new features first. If you switch to Stable, Copse keeps installing betas
until the next stable release, then installs only stable releases; it never
moves you back to an older version.

### If it does not open

- **"You can't use this version of the application with this version of
  macOS"**: Copse needs macOS 26 or newer. Update macOS, or build from source
  below.
- **"Copse can't be opened" or "is damaged"**: delete the copy in Applications,
  download the DMG again from the releases page above, and reinstall. Do not
  remove the quarantine attribute or bypass Gatekeeper; a notarized download
  opens without that.

For anything else, see [Troubleshooting](troubleshooting.md).

## From source

You need [Node.js](https://nodejs.org/) 24 or newer and [pnpm](https://pnpm.io/)
10 (`corepack enable`; the repo pins `pnpm@10.34.5`). On macOS, install the
Xcode command-line tools too.

```bash
git clone https://github.com/copse-dev/agent-pane.git
cd agent-pane
corepack enable
pnpm install
pnpm run dev
```

**You should see** an Electron window titled Copse. No paid model key is
required: connect a local model, or launch with
`COPSE_PANEL_MOCK_LLM=1 pnpm run dev` to opt into the built-in mock agent. An
otherwise unconfigured app asks you to add a provider.

If `pnpm install` fails with `No module named 'distutils'`, a newer Homebrew
Python was selected for the native rebuild. Retry with the Python supplied by
Xcode's command-line tools:

```bash
PYTHON=/usr/bin/python3 pnpm install
```

More install troubleshooting lives in the [README](../../README.md#install-troubleshooting)
and [CONTRIBUTING.md](../../CONTRIBUTING.md).
