// The `copse.devtools-shortcut` first-party plugin.
//
// Bundles the experimental "DevTools shortcut" feature behind a single lifecycle
// flag. Like the canvas plugin it contributes **no tool** — registering the global
// `Ctrl+Shift+I` keyboard shortcut that toggles the Electron DevTools window is
// pure main-process behaviour. It therefore contributes a declarative
// **capability** (`devtools-shortcut`): the host reads
// `getDefaultPluginRegistry().isCapabilityActive('devtools-shortcut')` (see
// `create-main-window.ts` `syncDevtoolsShortcut`) instead of the retired
// `devtoolsShortcutEnabled` standalone setting, so a Settings > Plugins disable
// unregisters the shortcut in one atomic flag flip (decision 15).
//
// **Default DISABLED.** The shortcut was opt-in (off by default via
// `devtoolsShortcutEnabled`); this plugin must not silently enable it for existing
// users. Default-off is expressed the same way as every other experimental plugin:
// the plugin-service enablement migration seeds the persisted `pluginDisabled` set
// (an absent/false old setting → disabled) before the shared registry is built.
// A user who had previously turned the setting on keeps the shortcut enabled.
//
// **No-double-registration.** The `devtoolsShortcutEnabled` standalone setting is
// gone (removed from the zod schema and the settings dialog) — the plugin
// capability is the single source of truth.
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// globalShortcut register/unregister) reads the plugin registry via the shared
// `getDefaultPluginRegistry()` seam.
import {
  definePlugin,
  type PluginCapabilityDecl,
  type RegisteredPlugin,
} from './plugin-manifest.ts'

/** Stable plugin id — the manifest name + the grouping key across contributions. */
export const DEVTOOLS_SHORTCUT_PLUGIN_ID = 'copse.devtools-shortcut'

/** The capability name the host read site consults via `isCapabilityActive`. */
export const DEVTOOLS_SHORTCUT_CAPABILITY = 'devtools-shortcut'

/** The declarative capability the plugin owns while enabled. */
const DEVTOOLS_SHORTCUT_CAPABILITY_DECL: PluginCapabilityDecl = {
  name: DEVTOOLS_SHORTCUT_CAPABILITY,
  title: 'DevTools keyboard shortcut',
  description:
    'Register Ctrl+Shift+I to toggle the Electron DevTools window, for debugging the app itself (not the agent conversation). While off, no shortcut is registered and the DevTools window cannot be opened.',
}

/**
 * The `copse.devtools-shortcut` plugin: manifest declares the capability; runtime
 * contributions carry the same capability so `activeCapabilities()` reports it
 * while enabled (the atomicity contract test in `enable-disable-atomicity.test.ts`
 * asserts that `disable()` drops the capability in one flag flip).
 */
export const devtoolsShortcutPlugin: RegisteredPlugin = definePlugin(
  {
    name: DEVTOOLS_SHORTCUT_PLUGIN_ID,
    description:
      'DevTools shortcut — register the Ctrl+Shift+I keyboard shortcut that toggles the Electron DevTools window, for debugging the app itself.',
    trust: 'first-party',
    stability: 'experimental',
    capabilities: [DEVTOOLS_SHORTCUT_CAPABILITY_DECL],
  },
  {
    capabilities: [DEVTOOLS_SHORTCUT_CAPABILITY_DECL],
  },
)
