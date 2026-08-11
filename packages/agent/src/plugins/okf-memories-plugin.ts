// The `copse.okf-memories` first-party plugin.
//
// Bundles the experimental "OKF memories" feature behind a single lifecycle
// flag. The plugin declares the `remember` and `recall` native tools (registered
// host-side in `registry-bootstrap.ts`) and the memory steering prompt block;
// the runtime call sites read `pluginRegistry.isEnabled('copse.okf-memories')` to
// decide whether to register the tools for the model tool list and whether to
// append the memory prompt block, so a Settings > Plugins disable drops both in
// one atomic flag flip (decision 15). The renderer Memories pane reads the same
// plugin enablement (via `plugins:list`) to decide whether to show its titlebar
// button — the pane shows iff the plugin is enabled.
//
// **No-double-registration.** Historically the `remember`/`recall` tools were
// registered when the top-level `okfMemoriesEnabled` boolean was on, and the
// memory prompt block was appended off the same setting. That standalone setting
// is gone (`OKF_MEMORIES_ENABLED_SETTING` deleted, the `okfMemoriesEnabled`
// checkbox removed from `settings-dialog.ts`) — the plugin toggle is the master
// switch. Registering the tools via both the plugin gate and the deleted
// standalone setting would have double-consulted the enable state; the deletions
// happen in the same change to keep a single source of truth
// (`isEnabled(OKF_MEMORIES_PLUGIN_ID)`).
//
// Electron-free (execution-guidance rule 4): pure declarations + the prompt
// block text. Host wiring (the tool registration + live sync + the prompt-block
// gate) reads the plugin registry via the shared `getDefaultPluginRegistry()` seam
// and imports the block text from here.
import { definePlugin, type RegisteredPlugin, type PluginPromptBlock } from './plugin-manifest.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export const OKF_MEMORIES_PLUGIN_ID = 'copse.okf-memories'

/** The native tool names the plugin contributes while enabled. */
export const OKF_MEMORIES_TOOL_NAMES = ['remember', 'recall'] as const

/** Contribution id for the memory steering prompt block. */
export const OKF_MEMORIES_PROMPT_BLOCK_ID = 'okf-memories-block'

/**
 * Steering appended to the system prompt while the plugin is enabled (i.e. while
 * the `remember`/`recall` tools are registered). Lives here (not in host code)
 * so the plugin's `promptBlocks` declaration and the host's appending site read
 * the identical text — the host imports this const from the plugin.
 */
export const MEMORY_TOOLS_BLOCK = `

You have a persistent memory for this project, stored as Open Knowledge Format markdown notes:
- remember: Save a durable fact worth recalling in future sessions — a project convention, decision, gotcha, or environment detail. Re-use a title to update that memory.
- recall: Look up what you previously stored, optionally filtered by a query.
Use recall early when a task may depend on prior context, and remember when you learn something durable the user would not want to re-explain. Keep memories concise and project-specific; do not store secrets.`

/** The manifest's steering prompt block (framed as trusted first-party text). */
const OKF_MEMORIES_PROMPT_BLOCK: PluginPromptBlock = {
  id: OKF_MEMORIES_PROMPT_BLOCK_ID,
  text: MEMORY_TOOLS_BLOCK,
  trust: 'trusted',
}

/**
 * The `copse.okf-memories` plugin: manifest declares the native tools
 * (`tools.native`), the memory steering prompt block, and plugin-scoped storage;
 * runtime contributions carry the same tool names and prompt block so
 * `activeToolNames()` reports them while enabled (the atomicity contract test in
 * `plugin-registry.test.ts` asserts that `disable()` clears the active tool list
 * in one flag flip).
 */
export const okfMemoriesPlugin: RegisteredPlugin = definePlugin(
  {
    name: OKF_MEMORIES_PLUGIN_ID,
    description:
      'OKF memories — the agent persists and recalls durable project knowledge (conventions, decisions, gotchas) across sessions via the `remember`/`recall` tools, saved per project as portable Open Knowledge Format markdown notes, with a Memories pane to browse and edit them.',
    trust: 'first-party',
    stability: 'experimental',
    tools: { native: [...OKF_MEMORIES_TOOL_NAMES] },
    prompt: [OKF_MEMORIES_PROMPT_BLOCK],
    storage: { namespace: OKF_MEMORIES_PLUGIN_ID },
  },
  {
    toolNames: [...OKF_MEMORIES_TOOL_NAMES],
    promptBlocks: [OKF_MEMORIES_PROMPT_BLOCK],
  },
)
