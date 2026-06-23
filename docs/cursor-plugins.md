# Cursor plugin support in Copse

Copse can reuse plugins installed by [Cursor](https://cursor.com) from the Cursor
Marketplace. Plugins are Git repos cached under `~/.cursor/plugins/` and identified
by a `.cursor-plugin/plugin.json` manifest at the plugin root.

This document records what Cursor plugins provide, what Copse supports today, and
what remains to build for fuller parity.

## On-disk layout

```
~/.cursor/plugins/
├── local/                          # symlinks for local development
└── cache/
    ├── .cloud-plugin-manifest.json # Cursor's install index
    └── {marketplaceSlug}/{pluginId}/{gitSha}/
        ├── .cursor-plugin/
        │   ├── plugin.json         # plugin manifest
        │   └── marketplace.json    # optional marketplace bundle metadata
        ├── skills/                 # Agent Skills (*/SKILL.md)
        └── .mcp.json               # optional MCP config (referenced from manifest)
```

Example manifest (Hugging Face marketplace plugin):

```json
{
  "name": "huggingface-skills",
  "skills": "skills",
  "mcpServers": ".mcp.json",
  "description": "Agent Skills for AI/ML tasks…",
  "version": "1.0.8"
}
```

The `skills` field is a **relative path to a skills directory** (default
`./skills/`). The `mcpServers` field is a **path to an MCP JSON file**, not inline
server definitions.

Cursor's cloud install manifest (`.cloud-plugin-manifest.json`) also tracks
`command` and `subagent` capability paths. Installed plugins on disk today are
primarily **skills + optional MCP**.

## What Copse supports

| Capability               | Status        | Notes                                                                                                           |
| ------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------- |
| **Skills**               | Supported     | Discovered from `~/.cursor/plugins/{local,cache}`; surfaced in `/` picker and `read_skill`                      |
| **MCP servers**          | Supported     | Loaded from each plugin's `mcpServers` config file; merged after user/global `mcp.json`, before project configs |
| **Extra plugin paths**   | Supported     | `skillPluginPaths` setting (storage only; no Settings UI yet)                                                   |
| **Commands**             | Not supported | Cursor manifest slot exists; no on-disk examples in current plugins                                             |
| **Subagents**            | Not supported | Same as commands                                                                                                |
| **Rules / AGENTS.md**    | Not supported | Some plugins ship `agentsmd/AGENTS.md` as a Gemini fallback; Copse does not load it                             |
| **Marketplace install**  | Not supported | Copse reads Cursor's cache; it does not install or update plugins                                               |
| **Plugin management UI** | Partial       | `plugins:list` IPC returns discovered plugins; no dedicated Settings section yet                                |

### Implementation

Shared discovery lives in `src/main/services/cursor-plugins.ts`:

- `discoverCursorPluginRoots()` — walk `local/` and `cache/`
- `resolvePluginSkillsDir()` / `resolvePluginMcpConfigPath()` — read `plugin.json`
- `listCursorPlugins()` — summaries for UI/diagnostics

Skills registration (`skills-registry.ts`) and MCP loading (`mcp-registry.ts`) both
use this module.

### Trust model

| Source                    | Skills trust                            | MCP trust                                                   |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `~/.cursor/skills` (user) | Trusted                                 | —                                                           |
| Cursor plugin (`plugin`)  | Untrusted (delimited as data in prompt) | Trusted (user installed via Cursor; full env interpolation) |
| Project workspace         | Untrusted                               | Requires workspace trust (#100)                             |
| `skillPluginPaths`        | Untrusted                               | —                                                           |

Plugin skills are untrusted because their text is still attacker-influenceable
content (a malicious marketplace plugin). Plugin MCP configs are treated like
user-global MCP: the user explicitly installed the plugin through Cursor.

Merge priority for duplicate MCP server names:

1. `~/.cursor/mcp.json` / app `mcp.json` (user)
2. Cursor plugin `.mcp.json` files
3. Project `.cursor/mcp.json` / `.mcp.json` (only when workspace is trusted)

## Local development

Symlink a plugin repo into Cursor's local plugins directory (from Kingston skills
README):

```bash
mkdir -p ~/.cursor/plugins/local
ln -sfn "$(pwd)" ~/.cursor/plugins/local/my-plugin
```

Ensure the repo contains `.cursor-plugin/plugin.json`. Restart Copse or reload MCP
servers from Settings after changing plugin MCP configs.

## Gaps and future work

1. **Settings UI** — surface `skillPluginPaths`, `skillsEnabled`, and installed
   plugins (name, version, skills/MCP indicators).
2. **Hot reload** — rescan `~/.cursor/plugins` when Cursor installs or updates a
   plugin without restarting the app.
3. **Command contributions** — if Cursor stabilizes a `commands` manifest field,
   map to Copse actions (e.g. slash commands, palette entries).
4. **Subagent contributions** — wire plugin-declared subagents into Copse's
   explore/subagent tooling.
5. **Rules / context files** — optional loading of `agentsmd/AGENTS.md` or
   plugin-bundled rules into the system prompt (with untrusted framing).
6. **First-party marketplace** — optional Copse-native install/update flow for users
   who do not use Cursor IDE.

## Related files

- `src/main/services/cursor-plugins.ts` — discovery and manifest parsing
- `src/main/services/skills-registry.ts` — skill indexing
- `src/main/services/mcp-registry.ts` — MCP spawn and tool registration
- `docs/supply-chain-security.md` — trust boundaries for skills and MCP
- `src/shared/types/cursor-plugins.ts` — `CursorPluginSummary` type
