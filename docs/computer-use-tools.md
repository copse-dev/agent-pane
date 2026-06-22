# Computer-use / browser automation tools

Design note for adding Cursor-style browser tools to Copse: navigate pages,
capture accessibility snapshots, take screenshots, and interact (click, type,
scroll). This document records the current gaps, trust boundaries, and a phased
implementation plan. **No implementation code exists yet** — this PR is the
planning artifact from an architecture exploration.

Related existing surfaces:

- `fetch_url` / `web_search` — HTTP fetch + markdown extraction (read-only, no
  JS execution, no interaction). Origin gating is tracked separately on
  `jkt/auto/web-origin-sandbox-13b9`.
- MCP — external tool servers; images in MCP results are currently flattened to
  `[image omitted]`.
- User message attachments — pasted screenshots reach the model via `UserContent`
  image blocks, but **tool results are string-only**.

## Goals

Enable the agent to verify local dev servers, read dynamic web UIs, and assist
with browser-based workflows — without requiring Playwright in the project
sandbox.

Non-goals for v1:

- Full desktop automation (OS-level mouse/keyboard outside a browser)
- Coordinate-based “computer use” (Anthropic beta style) — prefer
  accessibility-ref interaction
- Automating Copse’s own renderer `webContents`

## Current architecture gaps

| Layer | Today | Needed for computer use |
| --- | --- | --- |
| `ToolResult` | `{ result: string }` | Content blocks: text + optional image |
| Anthropic provider | `tool_result.content` is a string | Array with `image` + `text` blocks |
| OpenAI provider | `tool` role string content | Multimodal tool messages where supported |
| MCP flattening | Images → `[image omitted]` | Pass images through or base64-encode |
| Permissions | `SANDBOX_TOOLS`, shell, MCP tiers | Browser tier: localhost auto, external prompt |
| UI | No browser surface | Optional right-panel “Browser” tab |

Key types today (`src/shared/types/llm.ts`):

```typescript
export interface ToolResult {
  toolCallId: string
  result: string
}
```

Providers map tool results to plain text only (`anthropic-provider.ts`,
`openai-provider.ts`). User messages already support `{ type: 'image'; dataUrl }`
— the gap is **tool → model**, not user → model.

## Reference tool surface

Align naming with Cursor’s `cursor-ide-browser` MCP so prompts and skills
transfer:

| Tool | Purpose |
| --- | --- |
| `browser_tabs` | List / create / close / select tabs |
| `browser_navigate` | Open URL; optional new tab |
| `browser_snapshot` | Accessibility tree as compact YAML with opaque refs |
| `browser_take_screenshot` | PNG of current viewport |
| `browser_click` | Act on element ref (or coordinates as fallback) |
| `browser_type` / `browser_fill` | Text entry |
| `browser_scroll` / `browser_press_key` | Navigation within page |
| `browser_wait` | Poll for navigation / selector (optional v1.1) |

**Accessibility-first:** `browser_snapshot` is the primary page model (cheap,
structured). Screenshots supplement visual/layout verification.

## Implementation paths considered

### A — MCP server only (Playwright MCP, custom stdio server)

**Pros:** Reuses existing MCP registry; fastest prototype for text snapshots.  
**Cons:** Images still blocked until tool-result multimodal support; external
process; Playwright already triggers sandbox retry prompts in `run_shell`.

### B — Native Electron browser session (recommended)

Main-process `BrowserSessionManager`:

- Hidden `BrowserWindow`(s) or `BrowserView`(s), separate from the chat renderer
- CDP via `webContents.debugger` (`Accessibility`, `Page`, `DOM`, `Input`)
- Snapshot: walk AX tree → YAML with stable refs → map refs to backend node IDs
- Screenshot: `Page.captureScreenshot` or `webContents.capturePage()`
- Optional UI: “Browser” tab in the right panel (alongside file tree / terminals)

**Pros:** No Playwright dependency; integrated permissions; can show localhost
testing live.  
**Cons:** Largest build; requires Phase 1 platform work for screenshots.

### C — `run_shell` + Playwright scripts

**Pros:** Minimal new code.  
**Cons:** Poor UX; sandbox friction; no integrated browser view.

**Recommendation:** Phase 1 (platform) + Phase 2 (native Electron headless
browser). Phase 4 optionally documents an MCP wrapper for power users.

## Trust boundaries

| Action | Policy |
| --- | --- |
| Navigate to `localhost` / `127.0.0.1` / `[::1]` | Auto-allow (primary dev workflow) |
| Navigate to arbitrary HTTPS origin | Prompt once per origin; “remember” in settings |
| `file://`, `javascript:`, data URLs | Deny |
| Private IPs, link-local, metadata endpoints | Deny without prompt (SSRF) |
| Click / type / submit on non-localhost | Prompt unless origin remembered |
| Screenshot | Auto-allow (read-only) |

Reuse patterns from:

- `permission-gate.ts` / `permission-policy.ts` (shell + MCP tiers)
- Web origin allowlist (`web-origin-policy.ts` on the origin-sandbox branch) —
  browser navigation should share or extend the same origin key format

Browser sessions must **not** share `webContents` with the Copse renderer.

## Phased plan

```text
Phase 1: Multimodal tool results
    ↓
Phase 2: Headless browser tools (Electron + CDP)
    ↓
Phase 3: Browser panel UI (optional)
    ↓
Phase 4: MCP parity / external MCP docs (optional)
```

### Phase 1 — Multimodal tool results (~1–2 days)

1. Extend `ToolResult` with content blocks (`text` | `image`).
2. Update `ToolDefinition.execute` return type (string remains valid shorthand).
3. Wire `run-agent-loop.ts` to accumulate blocks.
4. Map blocks in `anthropic-provider.ts` (`tool_result.content` array).
5. Map blocks in `openai-provider.ts` (graceful text fallback for non-vision models).
6. Fix `flattenMcpContent` in `mcp-schema.ts` to pass images through.
7. Unit tests on provider message mapping.

**Acceptance:** A test tool returning text + PNG reaches Anthropic as a
multimodal tool result.

### Phase 2 — Headless browser service (~3–5 days)

1. `src/main/services/browser/session-manager.ts` — tab lifecycle, CDP attach.
2. `src/main/services/browser/snapshot.ts` — AX tree → YAML + ref map.
3. `src/main/tools/browser-tools.ts` — register tools listed above.
4. `registry-bootstrap.ts` — register behind `browserToolsEnabled` setting
   (default off).
5. Permission gates in `permission-gate.ts` (browser tier, localhost rules).
6. `tool-display.ts` — human labels for browser tools.
7. Unit tests for snapshot formatting and origin policy; no e2e required for v1.

**Acceptance:** Agent can `browser_navigate` to `http://localhost:<port>`,
`browser_snapshot`, and `browser_click` by ref on a static test page served by
a fixture HTTP server in tests.

### Phase 3 — Browser panel UI (~2–3 days, optional)

1. Right-panel tab “Browser” mirroring active agent session tab.
2. IPC to show/hide browser view on user request (`position: active` parity).
3. Tool cards: thumbnail for screenshot tools.
4. E2e screenshot fixture under `tests/e2e/browser-tools.e2e.ts`.

### Phase 4 — MCP / external automation (optional)

1. Document Playwright MCP in `mcp.json.example`.
2. Or ship a thin stdio MCP delegating to `BrowserSessionManager` for consistency.

## High-value Copse workflows

1. **Local dev verification** — `run_shell` starts dev server → `browser_navigate`
   → snapshot + screenshot → agent reports UI state.
2. **Docs lookup** — complement `fetch_url` for JS-heavy doc sites where static
   fetch is insufficient.
3. **E2E assist** — agent reads live snapshot while helping author Playwright tests.

## Open questions

- Should browser origin allowlist reuse `webAllowedOrigins` settings or a
  separate `browserAllowedOrigins` key?
- Vision-required models: gate browser screenshot tools on model capability, or
  always return screenshot as optional attachment?
- Single shared browser session per thread vs per agent run?

## Test plan (when implemented)

- [ ] `npm run check` — provider mapping unit tests (Phase 1)
- [ ] Browser origin policy unit tests (Phase 2)
- [ ] Snapshot ref stability on simple HTML fixture (Phase 2)
- [ ] Manual: mock LLM navigates localhost Vite/Next dev server (Phase 2)
- [ ] `npm run test:e2e` browser panel screenshots (Phase 3)
