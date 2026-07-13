---
name: checkup
description: Run a Copse setup health check (doctor). Use when the user types /checkup or asks to check, diagnose, or troubleshoot their Copse/app setup, API keys, providers, MCP servers, skills, or terminal.
disable-model-invocation: true
---

# Checkup

A read-only health check of the user's Copse setup — the same idea as Claude
Code's `/checkup` / `/doctor`: diagnose the setup, report findings, and offer to
fix what's actionable.

Only run this when the user explicitly invokes it (`/checkup`) — never start a
checkup on your own initiative.

Follow these steps exactly when this skill is invoked:

1. Call the `run_checkup` tool (it takes no arguments). It inspects the live
   setup — LLM providers and API keys (including whether keys are encrypted at
   rest), MCP servers, skills, the model context window, semantic search,
   command permissions, the app version, the workspace/git state, and the
   terminal helper — and returns findings already grouped into **errors**,
   **warnings**, and **healthy**.

2. Present the results to the user, most severe first:
   - Open with a one-line summary (e.g. "1 error, 2 warnings, everything else
     healthy").
   - List each **error** and **warning** with what's wrong and the suggested
     fix. Keep healthy items to a short reassuring summary — don't dump the full
     list unless asked.
   - If everything is healthy, say so plainly.

3. Offer to fix the actionable items. **Do not change anything without the
   user's confirmation.** For each fix the user approves, use your normal tools
   (editing settings, files, or running commands through the approval gate). Some
   fixes are outside your reach (installing a system keyring, adding an API key
   in Settings) — for those, give clear, concrete instructions instead.

4. Never invent findings. Report only what `run_checkup` returned. If the tool
   is unavailable, say so rather than guessing at the setup's health.

## Example opening

> Ran a checkup — 1 error, 1 warning, 9 healthy.
>
> **Error — LLM provider:** No provider is configured, so the app falls back to
> the mock model. Add an API key in Settings → API Keys, or configure a local
> provider.
>
> **Warning — Semantic search:** No backend available; the agent is using text
> search. Reinstall to fetch the bundled `gortex` binary, or put `gortex`/`vera`
> on your PATH.
>
> Want me to walk through fixing either of these?
