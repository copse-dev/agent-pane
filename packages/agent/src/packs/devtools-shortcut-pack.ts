// The `copse.devtools-shortcut` first-party pack.
//
// Bundles the experimental "DevTools shortcut" feature behind a single lifecycle
// flag. Like the canvas pack it contributes **no tool** — registering the global
// `Ctrl+Shift+I` keyboard shortcut that toggles the Electron DevTools window is
// pure main-process behaviour. It therefore contributes a declarative
// **capability** (`devtools-shortcut`): the host reads
// `getDefaultPackRegistry().isCapabilityActive('devtools-shortcut')` (see
// `create-main-window.ts` `syncDevtoolsShortcut`) instead of the retired
// `devtoolsShortcutEnabled` standalone setting, so a Settings > Packs disable
// unregisters the shortcut in one atomic flag flip (decision 15).
//
// **Default DISABLED.** The shortcut was opt-in (off by default via
// `devtoolsShortcutEnabled`); this pack must not silently enable it for existing
// users. Default-off is expressed the same way as every other experimental pack:
// the pack-service enablement migration seeds the persisted `packDisabled` set
// (an absent/false old setting → disabled) before the shared registry is built.
// A user who had previously turned the setting on keeps the shortcut enabled.
//
// **No-double-registration.** The `devtoolsShortcutEnabled` standalone setting is
// gone (removed from the zod schema and the settings dialog) — the pack
// capability is the single source of truth.
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// globalShortcut register/unregister) reads the pack registry via the shared
// `getDefaultPackRegistry()` seam.
import { definePack, type PackCapabilityDecl, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const DEVTOOLS_SHORTCUT_PACK_ID = 'copse.devtools-shortcut'

/** The capability name the host read site consults via `isCapabilityActive`. */
export const DEVTOOLS_SHORTCUT_CAPABILITY = 'devtools-shortcut'

/** The declarative capability the pack owns while enabled. */
const DEVTOOLS_SHORTCUT_CAPABILITY_DECL: PackCapabilityDecl = {
  name: DEVTOOLS_SHORTCUT_CAPABILITY,
  title: 'DevTools keyboard shortcut',
  description:
    'Register Ctrl+Shift+I to toggle the Electron DevTools window, for debugging the app itself (not the agent conversation). While off, no shortcut is registered and the DevTools window cannot be opened.',
}

/**
 * The `copse.devtools-shortcut` pack: manifest declares the capability; runtime
 * contributions carry the same capability so `activeCapabilities()` reports it
 * while enabled (the atomicity contract test in `enable-disable-atomicity.test.ts`
 * asserts that `disable()` drops the capability in one flag flip).
 */
export const devtoolsShortcutPack: RegisteredPack = definePack(
  {
    name: DEVTOOLS_SHORTCUT_PACK_ID,
    description:
      'DevTools shortcut — register the Ctrl+Shift+I keyboard shortcut that toggles the Electron DevTools window, for debugging the app itself.',
    trust: 'first-party',
    capabilities: [DEVTOOLS_SHORTCUT_CAPABILITY_DECL],
  },
  {
    capabilities: [DEVTOOLS_SHORTCUT_CAPABILITY_DECL],
  },
)
