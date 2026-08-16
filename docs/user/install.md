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

You need [Node.js](https://nodejs.org/) 22.22.2 or newer and [pnpm](https://pnpm.io/)
10 (`corepack enable`; the repo pins `pnpm@10.34.5`). On macOS, install the
Xcode command-line tools too.

```bash
git clone https://github.com/copse-dev/agent-pane.git
cd agent-pane
corepack enable
pnpm install
pnpm run dev
```

**You should see** an Electron window titled Copse. No model key is required:
with nothing configured, Copse uses a built-in mock agent.

More install troubleshooting lives in the [README](../../README.md#contributing)
and [CONTRIBUTING.md](../../CONTRIBUTING.md).
