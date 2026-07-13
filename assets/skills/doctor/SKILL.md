---
name: doctor
description: Alias for /checkup — run a Copse setup health check. Use when the user types /doctor or asks to diagnose or troubleshoot their setup, API keys, providers, MCP servers, skills, or terminal.
---

# Doctor

Alias for the `checkup` skill. Run the same setup health check:

1. Call the `run_checkup` tool (no arguments).
2. Present the findings most-severe-first with a one-line summary, listing each
   error and warning with its suggested fix and keeping healthy items brief.
3. Offer to fix the actionable items, but change nothing without the user's
   confirmation. For fixes outside your reach (installing a keyring, adding an
   API key in Settings), give clear instructions instead.
4. Report only what `run_checkup` returned — never invent findings.
