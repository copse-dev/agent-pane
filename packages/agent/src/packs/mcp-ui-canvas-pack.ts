// The `copse.mcp-ui-canvas` first-party pack.
//
// Bundles the experimental "MCP-UI artefacts (canvas)" feature (issue #611)
// behind a single lifecycle flag. Unlike the other first-party packs this pack
// contributes **no tool** — the canvas is pure cross-cutting behaviour that
// already lives across main (the MCP registry's UI-resource summarisation and
// the bundled canvas server) and the renderer (Browser-pane artefact
// rendering). It therefore contributes a declarative **capability**
// (`mcp-ui-canvas`): the host read sites consult
// `getDefaultPackRegistry().isCapabilityActive('mcp-ui-canvas')` instead of the
// retired `mcpUiArtefactsEnabled` standalone setting, so a Settings > Packs
// disable turns canvas rendering off in one atomic flag flip (decision 15).
//
// **Default DISABLED.** Canvas was opt-in (off by default via
// `mcpUiArtefactsEnabled`); this pack must not silently enable it for existing
// users. Default-off is expressed the same way as every other experimental pack:
// the pack-service enablement migration seeds the persisted `packDisabled` set
// (an absent/false old setting → disabled) before the shared registry is built.
// A user who had previously turned the setting on keeps canvas enabled.
//
// **No-double-registration.** The `mcpUiArtefactsEnabled` standalone setting is
// gone (removed from the zod schema and the settings dialog) — the pack
// capability is the single source of truth.
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// canvas gates) reads the pack registry via the shared `getDefaultPackRegistry()`
// seam.
import { definePack, type PackCapabilityDecl, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const MCP_UI_CANVAS_PACK_ID = 'copse.mcp-ui-canvas'

/** The capability name the host read sites consult via `isCapabilityActive`. */
export const MCP_UI_CANVAS_CAPABILITY = 'mcp-ui-canvas'

/** The declarative capability the pack owns while enabled. */
const MCP_UI_CANVAS_CAPABILITY_DECL: PackCapabilityDecl = {
  name: MCP_UI_CANVAS_CAPABILITY,
  title: 'MCP-UI canvas rendering',
  description:
    'Recognise UI resources returned by MCP tools (self-contained HTML) and render them as a fully sandboxed artefact in the Browser pane, plus a bundled canvas server exposing render_html_artefact. While off, UI resources are treated as plain tool output.',
}

/**
 * The `copse.mcp-ui-canvas` pack: manifest declares the capability; runtime
 * contributions carry the same capability so `activeCapabilities()` reports it
 * while enabled (the atomicity contract test in `enable-disable-atomicity.test.ts`
 * asserts that `disable()` drops the capability in one flag flip).
 */
export const mcpUiCanvasPack: RegisteredPack = definePack(
  {
    name: MCP_UI_CANVAS_PACK_ID,
    description:
      'MCP-UI artefacts (canvas) — render self-contained HTML UI resources from MCP tools as live, fully sandboxed artefacts in the Browser pane (no Node, no app access), and ship a bundled canvas server with a render_html_artefact tool for demos, charts, and small interactive UIs.',
    trust: 'first-party',
    stability: 'experimental',
    capabilities: [MCP_UI_CANVAS_CAPABILITY_DECL],
  },
  {
    capabilities: [MCP_UI_CANVAS_CAPABILITY_DECL],
  },
)
