---
title: Connect a model
description: Add a cloud API key, import one from your environment, or point Copse at a local server.
---

# Connect a model

Copse has no account and no hosted backend. The desktop app talks directly to
the provider you choose. Read [Privacy and data flow](../privacy-data-flow.md)
and [Provider data policies](../provider-data-policies.md) before sending a
real repository to a hosted model.

## Three ways in

1. **Type a key in Settings → Providers.** Copse encrypts it with the OS key
   store (macOS Keychain, Windows DPAPI, or a Linux keyring) when that store is
   available.
2. **Scan the environment.** Settings offers an explicit scan of `process.env`
   and a fixed list of shell startup files. You see masked previews only; nothing
   is stored until you import a key.
3. **Connect a local server.** Point an OpenAI-compatible endpoint at LM Studio,
   Ollama, llama.cpp, Jan, vLLM, or similar. That traffic stays on the machine
   only when the URL you configured is local.

**You should see** the model picker list at least one model, and a first prompt
should stream a reply (or a clear provider error).

## If the key store is unavailable

Copse refuses to persist the key until you explicitly approve **base64
plaintext** storage. Base64 is recoverable by anyone who can read
`~/.copse/user-data/settings.json`. That consent is the L1 residual: it exists
so a Linux or headless session without a keyring is not stranded. Prefer fixing
the keyring.

Environment-only keys are never written to settings.

## Attribution Copse always sends

Every provider request includes `HTTP-Referer: https://copse.dev/` and
`X-Title: Copse`. Those name the app, not you. They are the same on every
install.

OpenRouter traffic defaults to zero-data-retention, non-training upstreams.
Direct OpenAI requests send `store: false`. You can relax the OpenRouter ZDR
toggle in Settings; training stays excluded unless you change that too.

Optional on-device PII redaction (Settings, off by default) can redact the text
you typed before it leaves the machine. It does not cover repository files or
tool output.

If the picker is empty or the key will not save, see
[Troubleshooting](troubleshooting.md#provider-and-key-problems).
