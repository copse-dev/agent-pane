# Custom tools

Custom tools let you hand the agent your own in-process function without standing
up a dedicated MCP server. They're the lightweight middle ground between the
built-in tools (compiled into the app) and MCP servers (a separate process or
remote service): the same ergonomics as Cursor's SDK `local.customTools`, but
loaded from a directory instead of injected by embedding code.

## Where they live

Custom tools are loaded from `<userData>/tools/`:

| Platform | Path                                               |
| -------- | -------------------------------------------------- |
| macOS    | `~/Library/Application Support/copse-panel/tools/` |
| Linux    | `~/.config/copse-panel/tools/`                     |
| Windows  | `%APPDATA%\copse-panel\tools\`                     |

Only `.js`, `.mjs`, and `.cjs` files are loaded. The directory is created by you;
if it doesn't exist, no custom tools are loaded (this is the normal case).

### Trust boundary

Custom tools run **in the main process with full Node privilege**. They are
loaded **only** from this user-controlled directory — never from the workspace.
That asymmetry is deliberate and mirrors the MCP trust model: a cloned repo can
ship a `.mcp.json`, so project-defined MCP servers are sandboxed and gated behind
workspace trust, whereas full-privilege in-process tools come only from files you
put on your own machine. Treat this directory as trusted as the app itself.

Every custom tool call still **prompts for approval** before running (with an
"always allow" option per tool), the same opt-in model as MCP tools.

## The shape

A module default-exports a tool object, an array of them, or a factory function
(sync or async) returning either:

```js
// ~/.config/copse-panel/tools/weather.mjs
export default {
  name: 'get_weather', // letters, digits, underscores; exposed as custom__get_weather
  description: 'Get the current weather for a city',
  // JSON Schema for the arguments (`parameters` is accepted as an alias):
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  // requiresApproval: true,   // optional; force a prompt even if remembered
  async execute({ city }, signal) {
    const res = await fetch(`https://example.com/weather?q=${city}`, { signal })
    return await res.text()
  },
}
```

### Return values

`execute` may return:

- a **string** — used verbatim;
- any **JSON value** — serialized to JSON for the model;
- an **MCP-style envelope** `{ content: [{ type: 'text', text }], isError }` — the
  content is flattened to text, and a truthy `isError` is surfaced as a tool error.

`null`/`undefined` become an empty string. Throwing from `execute` reports the
error to the agent.

### Exporting several tools from one file

```js
export default [
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    execute: ({ a, b }) => String(a + b),
  },
  {
    name: 'sub',
    description: 'Subtract',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    execute: ({ a, b }) => String(a - b),
  },
]
```

## Loading

Custom tools are loaded at startup, after MCP servers. A malformed file is
reported and skipped without affecting the others. Names collide on a
first-registered-wins basis within the registry, so avoid reusing a built-in or
MCP tool name.
