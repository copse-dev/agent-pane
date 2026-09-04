---
title: Install
description: Get Copse running on a supported Mac, or build it from source.
---

# Install

The supported app is **macOS 26 or newer** on Apple Silicon (`arm64`) and Intel
(`x64`). Linux and Windows can run a source build for development. They are not
supported release targets.

## Signed download (when a release is published)

1. Open the [GitHub Releases](https://github.com/copse-dev/agent-pane/releases)
   page and download the DMG for your architecture.
2. Open the DMG and drag Copse to Applications.
3. Launch Copse. macOS Gatekeeper should accept a signed, notarized build.

If the download URL 404s or asks you to sign in, the repository is still
private — use the source path below, or wait for a public release.

**You should see** the Copse window with a prompt to open a project folder.

If it does not launch, see [Troubleshooting](troubleshooting.md).

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
