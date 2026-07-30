# Adding a pack to Copse

A **pack** bundles related agent capabilities — tools, hooks, prompt blocks, UI
panels, and pack-scoped settings — behind one enable/disable toggle in
**Settings → Packs**.

This is the practical guide for installing or authoring one. For the registry
lifecycle and internal design, see [`docs/packs.md`](./packs.md).

## What you can do today

| Goal                                     | Where it lives today                                                                | Shows up in Settings…                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| Turn a shipped Copse feature on or off   | First-party packs (`copse.todos`, `copse.pii-redaction`, …)                         | **Packs** (toggle per row)                  |
| Add skills and/or MCP servers            | A Cursor-style plugin under `~/.cursor/plugins/`                                    | **Sources → Plugins** (and **MCP servers**) |
| Add command hooks                        | Cursor / Claude / Copse hooks files                                                 | **Sources → Hooks**                         |
| Add an in-process custom tool            | `<userData>/tools/*.mjs`                                                            | Used by the agent (approval-gated)          |
| Author a full user pack row in **Packs** | Manifest shape exists (`plugin.json` + pack slots); host discovery is not wired yet | Not yet — see [Status](#status-user-packs)  |

So: you can extend Copse today with the same _kinds_ of contributions a pack
owns, but a third-party bundle does **not** yet appear as its own row under
**Settings → Packs**. First-party packs are the rows you see there now.

## Install skills + MCP (closest thing to a user pack today)

Copse already loads Cursor plugins from disk. That path is the practical way to
ship skills and MCP together:

```
my-pack/
├── .cursor-plugin/
│   └── plugin.json
├── skills/
│   └── my-skill/
│       └── SKILL.md
└── .mcp.json                 # optional; referenced from the manifest
```

Minimal `plugin.json`:

```json
{
  "name": "my-pack",
  "version": "0.1.0",
  "description": "Skills and MCP for my workflow",
  "skills": "skills",
  "mcpServers": ".mcp.json"
}
```

Install for local use (symlink into Cursor's local plugins dir):

```bash
mkdir -p ~/.cursor/plugins/local
ln -sfn "$(pwd)" ~/.cursor/plugins/local/my-pack
```

Then restart Copse, or use **Settings → Sources → Reload** / reload MCP from
**Settings → MCP servers**. Confirm the plugin appears under
**Settings → Sources → Plugins**.

Details and trust rules: [`docs/cursor-plugins.md`](./cursor-plugins.md).

## Add hooks (command hooks)

Hooks are not installed through the Packs list today. Author them with one of
the on-disk dialects and reload **Settings → Sources**:

| Dialect | Doc                                         |
| ------- | ------------------------------------------- |
| Cursor  | [`docs/cursor-hooks.md`](./cursor-hooks.md) |
| Claude  | [`docs/claude-hooks.md`](./claude-hooks.md) |
| Copse   | [`docs/copse-hooks.md`](./copse-hooks.md)   |

Architecture umbrella: [`docs/hooks.md`](./hooks.md).

## Add a custom tool

For a privileged in-process tool without standing up MCP, drop a module under
the app's userData `tools/` directory. See
[`docs/custom-tools.md`](./custom-tools.md).

## Authoring a pack manifest (for when user packs land)

The declarative pack manifest **extends** `plugin.json` with the remaining
slots. JSON Schema:
[`schemas/copse-pack.schema.json`](../schemas/copse-pack.schema.json).

```
pack manifest
├── name / version / description
├── stability   stable | experimental (omitted user values are experimental)
├── skills      relative skills directory (same as plugin.json)
├── tools       { "mcpServers": ".mcp.json" }   # user packs — not native tools
├── hooks       [ { "event", "command" }, … ]   # command hooks
├── prompt      steering blocks (always treated as untrusted for user packs)
├── ui          level-1 cards / level-2 list|tree panels
├── settings    pack-scoped fields rendered in Settings
└── storage     namespaced bag that survives disable
```

Example sketch (valid against the schema; **not** registered as a Packs row
until host discovery lands):

```json
{
  "name": "example.notes",
  "version": "0.1.0",
  "description": "Example user pack",
  "stability": "experimental",
  "skills": "skills",
  "tools": { "mcpServers": ".mcp.json" },
  "hooks": [{ "event": "stop", "command": "./hooks/on-stop.sh" }],
  "prompt": [
    {
      "id": "notes-steering",
      "text": "Prefer capturing durable notes when the user finishes a task.",
      "trust": "untrusted"
    }
  ],
  "ui": [
    {
      "id": "notes",
      "level": 2,
      "slot": "conversation-panel",
      "title": "Notes",
      "panel": { "kind": "list", "header": "Notes", "ariaLabel": "Notes" }
    }
  ],
  "settings": {
    "captureEnabled": {
      "kind": "boolean",
      "title": "Capture notes on stop",
      "default": true
    }
  },
  "storage": { "namespace": "example.notes" }
}
```

### Trust boundaries (user packs)

- A discovered pack is always **user** trust — it cannot self-declare
  `first-party`.
- Prompt blocks from a user pack are forced to **untrusted** (delimited as data),
  even if the file says `"trust": "trusted"`.
- User packs may declare **command** hooks and MCP config paths. They cannot
  ship in-process function hooks, native Copse tools, or level-3 renderer views
  — those stay first-party only.

## Status: user packs

| Piece                                              | Status                     |
| -------------------------------------------------- | -------------------------- |
| Manifest types + JSON schema                       | Landed                     |
| `packManifestFromPluginJson()` mapper              | Landed                     |
| Settings → Packs list + enable/disable             | Landed (first-party packs) |
| Host disk discovery → register user packs          | **Not wired yet**          |
| Runtime wiring of user-pack hooks/MCP via registry | Follows discovery          |

Until discovery lands, put skills/MCP in a Cursor plugin (above) and hooks in
the dialect files. When user packs are discovered, the same `plugin.json`
(optionally with the extra slots) is the intended on-disk unit.

## Contributing a first-party pack (Copse developers)

Shipped packs live in `packages/agent/src/packs/`, are listed from
`first-party-packs.ts`, and follow the pattern in `todos-pack.ts` /
`pii-redaction-pack.ts`:

1. `definePack(manifest, contributions)` with typed function hooks / native
   tool names as needed. First-party manifests must declare `stability`; use
   `experimental` for any feature whose contract or compatibility may still change.
2. Register in `FIRST_PARTY_PACKS`.
3. Gate any host-side tool registration on `getDefaultPackRegistry().isEnabled(id)`.
4. Add Settings / e2e coverage for the new row and default enablement.
5. Keep history rendering independent of live enablement (disabled packs must
   not break old threads).

Design source of truth:
[`docs/plans/hooks-and-feature-packs.md`](./plans/hooks-and-feature-packs.md)
(the [two-capability-tiers](./plans/hooks-and-feature-packs.md#decisions-log) and [disable-never-breaks-history](./plans/hooks-and-feature-packs.md#decisions-log) decisions). Architecture notes: [`docs/packs.md`](./packs.md).

## Related

- [`docs/packs.md`](./packs.md) — registry, panels, Settings wiring
- [`docs/cursor-plugins.md`](./cursor-plugins.md) — plugin install path used today
- [`docs/hooks.md`](./hooks.md) — hooks platform
- [`docs/custom-tools.md`](./custom-tools.md) — userData tools
- [`docs/supply-chain-security.md`](./supply-chain-security.md) — trust for skills / MCP
