# Adding a pack to Copse

A **pack** bundles related agent capabilities — tools, whole-thread model routes,
hooks, prompt blocks, UI panels, and pack-scoped settings — behind one enable/disable toggle in
**Settings → Packs**.

This is the practical guide for installing or authoring one. For the registry
lifecycle and internal design, see [`docs/packs.md`](./packs.md).

## What you can do today

| Goal                                         | Where it lives today                                                                | Shows up in Settings…                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| Turn a shipped Copse feature on or off       | First-party packs (`copse.todos`, `copse.pii-redaction`, …)                         | **Packs** (toggle per row)                  |
| Add skills and/or MCP servers                | A Cursor-style plugin under `~/.cursor/plugins/`                                    | **Sources → Plugins** (and **MCP servers**) |
| Add command hooks                            | Cursor / Claude / Copse hooks files                                                 | **Sources → Hooks**                         |
| Add an in-process custom tool                | `<userData>/tools/*.mjs`                                                            | Used by the agent (approval-gated)          |
| Add a personal pack with executable behavior | Explicit folder selected in **Settings → Packs**                                    | **Packs** (ordinary user-pack row)          |
| Author a full user pack row in **Packs**     | Manifest shape exists (`plugin.json` + pack slots); host discovery is not wired yet | Not yet — see [Status](#status-user-packs)  |

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

## Add a personal pack with executable behavior

Executable pack behavior is deliberately explicit: Copse does not scan
arbitrary plugin directories for code. Choose **Settings → Packs → Add pack…**
and select a folder containing `copse-pack.json`. Selecting the folder is the
current opt-in. Copse validates the manifest and source tree and computes a
content hash used to create a consistent executable snapshot; the hash is not a
separate trust tier or approval identity.

Minimal manifest:

```json
{
  "name": "personal.example",
  "version": "0.1.0",
  "description": "A personal review pack",
  "tools": {
    "provides": ["personal_judge"]
  },
  "models": {
    "provides": [
      {
        "id": "reference-judge",
        "label": "Reference judge",
        "group": "Personal models",
        "supportsImages": true
      }
    ]
  },
  "browser": {
    "origins": ["https://example.test"]
  },
  "runtime": {
    "entrypoint": "dist/index.mjs",
    "apiVersion": 1
  }
}
```

Adding or enabling starts a standalone API-v1 worker. Copse re-hashes the
selected source, copies the selected files into a content-addressed snapshot,
validates the snapshot again, and runs it with direct network and filesystem
writes denied. The runtime fails closed when Copse's macOS OS sandbox is not
active; Windows and Linux execution are not supported by this slice.

The runtime must register exactly the tool names in `tools.provides` and model
route ids in `models.provides`. A pack may declare either behavior or both.
Enabling it once makes those contributions available for new work; invoking a
declared route does not add a second per-turn pack approval.

Model routes appear in the thread's model picker. Each invocation receives:

- the current prompt;
- up to eight validated current-turn PNG, JPEG, WebP, or GIF attachments as
  base64 (8 MB decoded total), when the route declares `supportsImages`;
- a newest-biased, text-only handoff of up to 32 prior messages and
  64 KiB; and
- a session API durably scoped by Copse to this pack id and thread id.

The session API lets a handler remember an opaque remote conversation id. A
handler can therefore reuse an intact external conversation and consume the
bounded history only when it has to recreate one. Copse binds the identity; the
worker cannot select another pack's or thread's session.

Minimal `dist/index.mjs`:

```js
export function activate(api) {
  api.registerTool(
    {
      name: 'personal_judge',
      description: 'Review a prompt with the personal judge.',
      inputSchema: { type: 'object', additionalProperties: true },
    },
    (input) => ({ result: `Received ${JSON.stringify(input)}` }),
  )

  api.registerModelRoute('reference-judge', async (turn, { session, browser, signal }) => {
    const previous = await session.get()
    if (signal.aborted) throw new Error('Cancelled')

    const tab = await browser.open('https://example.test/')
    const page = await browser.snapshot(tab.tabId)

    // A real pack can find refs in `page`, then call browser.click/type/upload.
    // Save only the external conversation identity needed for recovery.
    await session.set(previous ?? { createdAt: new Date().toISOString() })
    return { text: `Opened ${tab.url}\n\n${page}` }
  })
}
```

The model result is either a string or `{ text, inputTokens?, outputTokens? }`.
Session state must be JSON and is capped at 256 KiB per thread.

When `browser.origins` is present, model handlers receive a narrow P4 bridge to
Copse's **visible browser panel**. The bridge can open/reuse a pack-and-thread
owned tab, open a new tab, list owned tabs, navigate, take an accessibility
snapshot, click/type by snapshot ref, and upload validated images to a
referenced file input. Upload uses in-page `File`/`DataTransfer` injection, so
no native file chooser opens.

Snapshots include bounded meaningful visible leaf text, semantic interactive
roles, pointer-affordance refs, and hidden file inputs that back visible
attachment controls. Hidden inputs are exposed only as upload refs; the bridge
still does not expose selectors or arbitrary page scripting.

Origins are exact: HTTPS scheme + host + optional port, with HTTP allowed only
for loopback development. Paths, credentials, wildcards, undeclared origins,
cross-thread tab ids, and redirects outside the declaration fail closed. The
browser panel uses its persistent interactive profile, so the page can see the
cookies and site storage the user established there. Calls visibly open/reveal
the panel and use tabs rather than separate windows.

The worker still has no direct network, raw Electron/webview objects, arbitrary
IPC, renderer code, or generic `host.call`. A browser declaration is supported
only with a model route in API v1; tool handlers do not receive browser access.

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
├── skills      relative skills directory (same as plugin.json)
├── tools       MCP config and/or selected-pack tool ids
├── models      selected-pack whole-thread model routes
├── browser     exact visible-browser origins for selected-pack model routes
├── runtime     shared isolated worker entrypoint for executable behavior
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

Explicitly selected personal packs remain ordinary user packs. Their executable
behavior runs through the isolated versioned worker and never receives raw
Electron authority from the manifest.

## Status: user packs

| Piece                                              | Status                     |
| -------------------------------------------------- | -------------------------- |
| Manifest types + JSON schema                       | Landed                     |
| `packManifestFromPluginJson()` mapper              | Landed                     |
| Settings → Packs list + enable/disable             | Landed (first-party packs) |
| Explicit selected-pack tools and model routes      | Landed                     |
| Isolated executable behavior                       | Landed (macOS P2/P3 slice) |
| Bounded image/transcript handoff + thread sessions | Landed                     |
| Origin-scoped visible browser tabs + image upload  | Landed (macOS P4 slice)    |
| Direct network or generic host gateway             | Intentionally unavailable  |
| User-pack renderer code                            | **Not wired**              |
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
   tool names as needed.
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
