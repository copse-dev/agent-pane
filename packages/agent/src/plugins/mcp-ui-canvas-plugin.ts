// The `copse.mcp-ui-canvas` first-party plugin.
//
// Bundles the "MCP-UI artefacts (canvas)" feature (issue #611)
// behind a single lifecycle flag. Unlike the other first-party plugins this plugin
// contributes **no tool** — the canvas is pure cross-cutting behaviour that
// already lives across main (the MCP registry's UI-resource summarisation and
// the bundled canvas server) and the renderer (Browser-pane artefact
// rendering). It therefore contributes a declarative **capability**
// (`mcp-ui-canvas`): the host read sites consult
// `getDefaultPluginRegistry().isCapabilityActive('mcp-ui-canvas')` instead of the
// retired `mcpUiArtefactsEnabled` standalone setting, so a Settings > Plugins
// disable turns canvas rendering off in one atomic flag flip (decision 15).
//
// It also contributes **conditional turn-start hooks**
// (`canvasPrototypeSteeringHook` and `explainerSteeringHook`). A canvas that exists but is never reached is
// worth nothing: asked to prototype something, a model with a long tool list
// answers in prose or writes a file the user has to open. The hook fires only on
// a prototype request, and only when this turn actually offers the bundled
// `render_html_artefact` tool, so the steering and the tool it names appear and
// disappear together. Hook rather than a static prompt block for the same
// reason `copse.site-building` uses one: the guidance is worth its tokens on a
// prototype turn and pure noise on every other.
//
// **Stable, default-ON.** Canvas was opt-in at launch (off by default via the
// retired `mcpUiArtefactsEnabled` setting, then via `experimental` stability).
// It graduated to `stable` once the live-toggle MCP reload
// (`reloadMcpServersForPluginToggle` in `mcp-registry.ts`) and the ACP
// inline-visualization capability gate (`dispatchInlineVisualization` in
// `inline-visualization.ts`) both existed, so disabling the plugin now turns
// off every path that can render agent-authored HTML, not only the bundled
// tool. A profile that already owns a disable list is graduated once by
// `migrateMcpUiCanvasStable()` in `plugin-service.ts`; later toggles remain
// the user's own choice.
//
// **No-double-registration.** The `mcpUiArtefactsEnabled` standalone setting is
// gone (removed from the zod schema and the settings dialog) — the plugin
// capability is the single source of truth.
//
// Electron-free (execution-guidance rule 4): declarations plus a pure steering
// hook whose policy and text live in `../canvas-prototype-steering.ts`. Host
// wiring (the canvas gates) reads the plugin registry via the shared
// `getDefaultPluginRegistry()` seam.
import {
  definePlugin,
  type PluginCapabilityDecl,
  type RegisteredPlugin,
} from './plugin-manifest.ts'
import { MCP_UI_CANVAS_PLUGIN_ID, ANIMATED_EXPLAINERS_SETTING_ID } from '../canvas-settings.ts'
import { explainerSteeringHook } from '../explainer-steering.ts'
import { canvasPrototypeSteeringHook } from '../hooks/turn-start-hooks.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export { MCP_UI_CANVAS_PLUGIN_ID } from '../canvas-settings.ts'

/** The capability name the host read sites consult via `isCapabilityActive`. */
export const MCP_UI_CANVAS_CAPABILITY = 'mcp-ui-canvas'

/** The declarative capability the plugin owns while enabled. */
const MCP_UI_CANVAS_CAPABILITY_DECL: PluginCapabilityDecl = {
  name: MCP_UI_CANVAS_CAPABILITY,
  title: 'MCP-UI canvas rendering',
  description:
    'Recognise UI resources returned by MCP tools (self-contained HTML) and render them as a fully sandboxed artefact in the Browser pane. Includes a canvas service for interactive pages and captioned animations in the conversation. While off, UI resources are treated as plain tool output.',
}

/**
 * The `copse.mcp-ui-canvas` plugin: manifest declares the capability; runtime
 * contributions carry the same capability plus the prototype and explainer steering hooks, so
 * `activeCapabilities()` reports the flag and `activeBlockingHooks()` the hook
 * while enabled (the atomicity contract test in `enable-disable-atomicity.test.ts`
 * asserts that `disable()` drops both in one flag flip).
 */
export const mcpUiCanvasPlugin: RegisteredPlugin = definePlugin(
  {
    name: MCP_UI_CANVAS_PLUGIN_ID,
    description:
      'Create interactive demos, charts and small apps in Canvas. Optionally turn explanation requests into captioned animations in your chat.',
    trust: 'first-party',
    stability: 'stable',
    settings: {
      [ANIMATED_EXPLAINERS_SETTING_ID]: {
        kind: 'boolean',
        title: 'Animated explainers (experimental)',
        description:
          'Ask “explain X” in a chat. Copse chooses a style, writes the captions and checks the animation before sharing it. Silent playback; creation can take a few minutes. Off by default.',
        default: false,
      },
    },
    storage: { namespace: MCP_UI_CANVAS_PLUGIN_ID },
    capabilities: [MCP_UI_CANVAS_CAPABILITY_DECL],
  },
  {
    capabilities: [MCP_UI_CANVAS_CAPABILITY_DECL],
    blockingHooks: [canvasPrototypeSteeringHook, explainerSteeringHook],
  },
)
