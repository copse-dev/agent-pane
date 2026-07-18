# Vendored upstream hook schemas (G3)

Pinned, committed copies of the **upstream** hook-config JSON schemas for the two
foreign dialects Copse imports (`.claude/settings.json` and `.cursor/hooks.json`).
They exist for two reasons, and **only** two:

1. **Warn-level authoring lint.** When Copse parses a foreign hooks config it uses
   the _published event list_ from these schemas to tell an author "this event is
   recognised upstream but Copse does not act on it yet" vs "this looks like a
   typo". This is a **warn-only** lint surfaced in Settings → Sources — it is
   **never a load gate**: every valid hook still loads, exactly as before.
2. **CI drift detector.** `src/main/services/hooks/vendor-schema-drift.test.ts`
   diffs the event list each vendored schema publishes against the events our
   adapters actually wire, and fails CI when an upstream release adds an event we
   neither support nor have explicitly listed as intentionally-unsupported. That
   forces a deliberate choice (wire it, or document why not) instead of silent
   drift.

## Hard rules (do not break)

- **Never remote-fetched.** Neither the runtime app nor CI fetches these at
  runtime or test time — the drift detector reads the committed copies from disk
  only. The network is used **exactly once**, by a human/agent re-vendoring a pin
  (see below). Tests and the app must work fully offline.
- **Never a load gate.** These schemas do not validate/reject a user's hooks
  config. A config that violates an upstream schema still loads; at most it earns
  a warning row. Copse's own `schemas/copse-hooks.schema.json` is the only schema
  we author; these vendored ones are read-only references.
- **Pinned, not tracked live.** We pin a specific upstream revision so the drift
  detector is deterministic. Bumping a pin is an explicit, reviewed change.

## Pins

| File                               | Upstream                                                                   | Source URL                                                      | Pinned                                 | Retrieved  | sha256                                                             |
| ---------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- | ---------- | ------------------------------------------------------------------ |
| `claude-code-settings.schema.json` | Claude Code settings (SchemaStore)                                         | <https://www.schemastore.org/claude-code-settings.json>         | SchemaStore `last-modified` 2026-07-15 | 2026-07-16 | `2b4004b2af619ce16bd6dafc0a8f1f03974f45740f4212a1f85f236364057d28` |
| `cursor-hooks.schema.json`         | `cursor-hooks` npm package (community, "Cursor Community" / johnlindquist) | <https://unpkg.com/cursor-hooks@1.1.5/schema/hooks.schema.json> | npm `cursor-hooks@1.1.5`               | 2026-07-16 | `824c8bbe802305827f813c19f2411b883afe8d02f0b947d7c30428f4effc18f3` |

Notes on each pin:

- **Claude — SchemaStore.** SchemaStore's `claude-code-settings.json` is the
  canonical community schema for `.claude/settings.json`. Its `hooks` object
  enumerates the full upstream event surface (30 events as of this pin), of which
  Copse wires `PreToolUse` and `SessionStart`; the rest are intentionally
  unsupported v1 (see the drift test's `CLAUDE_INTENTIONALLY_UNSUPPORTED_EVENTS`).
- **Cursor — community schema.** Cursor does not publish a first-party
  `hooks.json` JSON schema on SchemaStore. The most widely used community schema
  is the one shipped by the `cursor-hooks` npm package (referenced from the Cursor
  hooks docs' "enable JSON Schema validation" section). It lags the Cursor docs
  (it publishes 6 events; Cursor's docs describe more), which is expected for a
  community pin — our adapter deliberately knows a **superset**. The drift detector
  only requires that every event this schema _publishes_ is either wired or listed
  as intentionally-unsupported; adapter-ahead-of-schema is allowed.

## Re-vendoring a pin

This is the **only** step that touches the network, and it is run by a human/agent
on purpose — never by the app or CI:

```bash
# Claude (SchemaStore):
curl -sSL -o schemas/vendor/claude-code-settings.schema.json \
  https://www.schemastore.org/claude-code-settings.json

# Cursor (community, bump the pinned version deliberately):
curl -sSL -o schemas/vendor/cursor-hooks.schema.json \
  https://unpkg.com/cursor-hooks@<version>/schema/hooks.schema.json

# Then update the table above (sha256 via `sha256sum`, dates, versions) and
# re-run the drift detector; if it fails, either wire the new event(s) or add
# them to the intentionally-unsupported list with a reason.
npm test -- --test-name-pattern "vendor-schema-drift"
```

See `docs/plans/hooks-and-feature-packs.md` (issue G3) for the design decision.
