---
title: Troubleshooting
description: Fix empty model pickers, unexpected prompts, and a profile that will not open.
---

# Troubleshooting

## Provider and key problems

**The model picker is empty.** Open Settings → Providers and add a key, import
one from the environment scan, or set a local server URL. Then pick a model in
the thread header.

**The key will not save.** The OS key store may be unavailable. Copse will ask
before writing a recoverable base64 copy. On Linux, install and unlock a
supported keyring rather than accepting plaintext if you can.

**A hosted request fails immediately.** Check the provider dashboard, the
endpoint URL, and that the key has not been rotated. Copse talks to the
provider directly — there is no Copse-side outage page.

**LM Studio context resets after reboot.** Copse cannot set LM Studio’s load
context over the OpenAI-compatible API. Save the context length as that
model’s default in LM Studio:
[Making LM Studio's context length survive a restart](../lm-studio-context-persistence.md).

## Approval and sandbox surprises

**Everything asks, including `ls`.** Either auto-run is off, the project is
untrusted, or there is no sandbox (Windows, or init failure). Check Settings →
Permissions and the project trust prompt.

**`git fetch` asked on Windows but not on a Mac.** On a Mac the sandbox is the
boundary. On Windows there is no jail, so the same shape is a prompt unless a
read-tier auto-approval match applies. After
[#1763](https://github.com/copse-dev/agent-pane/pull/1763) it will ask on
Windows even for recognised reads.

**The Shells tab never asked.** That tab is your terminal, not the agent.
It is supposed to open without a prompt and without the sandbox. Agent
commands still go through [Approvals](approvals.md).

**A command ran, failed, then asked.** The sandbox blocked network or an
outside path. The follow-up dialog is the unsandboxed retry.

## Recovery

Quit Copse before copying `~/.copse/` (or `COPSE_DIR`). That directory is the
whole profile. Step-by-step backup and restore:
[Backup and recovery](../recovery.md).

Do not share `settings.json`, thread exports, or browser profiles without
redacting them. Copse has no secret-scrubbed support bundle. See
[SUPPORT.md](../../SUPPORT.md).

## Still stuck

Search [GitHub Issues](https://github.com/copse-dev/agent-pane/issues). File a
bug with the template. Suspected vulnerabilities go to
[security@copse.dev](mailto:security@copse.dev), not the issue tracker.
