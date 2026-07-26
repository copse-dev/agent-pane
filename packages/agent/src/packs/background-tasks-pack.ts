// The `copse.background-tasks` first-party pack (issue #1190).
//
// Bundles the experimental "background tasks" feature (issue #691) behind a
// single lifecycle flag. The pack declares the `run_background` native tool
// (registered host-side in `registry-bootstrap.ts` by
// `syncBackgroundTasksTools`); the runtime call site reads
// `packRegistry.isEnabled('copse.background-tasks')` to decide whether to
// register the tool for the model tool list, so a Settings > Packs disable drops
// it in one atomic flag flip (decision 15).
//
// **It also DECLARES the authority it opens.** Beyond advertising a tool, the
// pack contributes a permission / sandbox relaxation (`loopback-bind`): a
// background task may opt into binding a loopback port, which relaxes the
// default sandbox (workspace-only, no network) to allow `localhost` binding for
// the process lifetime, gated by a per-project grant through the permission-gate
// (issue #1190). The permission-gate resolves that relaxation through
// `getDefaultPackRegistry().isPermissionDeclared('loopback-bind')`, so it is
// grantable ONLY while this pack is enabled — disabling the pack revokes the
// authority in the same flag flip that unregisters the tool. The declaration
// also feeds the Settings pack-list enumeration and the future install-time
// capability/permission review (#1082).
//
// **Default DISABLED.** Background tasks are opt-in, declared as
// `defaultEnabled: false` on the manifest so `PackRegistry.register` starts the
// pack disabled in every registry — including the fallback
// `getDefaultPackRegistry()` hands out before the host wires the shared one.
// That matters more here than for the other experimental packs: it is what stops
// `isPermissionDeclared('loopback-bind')` answering "granted" from an unwired
// registry, so the sandbox relaxation cannot be reached before the host has
// applied the user's actual choice.
//
// **No-double-registration.** The `backgroundTasksEnabled` standalone setting is
// gone (removed from the zod schema and the settings dialog) — the pack toggle
// is the single source of truth.
//
// Electron-free (execution-guidance rule 4): pure declarations. Host wiring (the
// tool registration + live sync, and the permission-gate's loopback-bind gate)
// reads through the shared `getDefaultPackRegistry()` seam.
import { definePack, type PackPermissionDecl, type RegisteredPack } from './pack-manifest.ts'

/** Stable pack id — the manifest name + the grouping key across contributions. */
export const BACKGROUND_TASKS_PACK_ID = 'copse.background-tasks'

/** The native tool name the pack contributes while enabled. */
export const BACKGROUND_TASKS_TOOL_NAME = 'run_background'

/**
 * The permission / sandbox relaxation name the permission-gate resolves via
 * `isPermissionDeclared`. Matches the loopback port-binding grant in
 * `permission-gate.ts` / `permission-policy.ts` (the per-project
 * `portBindingAllowedRoots` grant), which is honoured only while this pack
 * declares it.
 */
export const LOOPBACK_BIND_PERMISSION = 'loopback-bind'

/** The declarative permission / sandbox relaxation the pack owns while enabled. */
const LOOPBACK_BIND_PERMISSION_DECL: PackPermissionDecl = {
  name: LOOPBACK_BIND_PERMISSION,
  title: 'Bind a loopback port',
  description:
    'Let a background task opt into binding a localhost port (e.g. a dev server), relaxing the default sandbox (workspace-only, no network) to allow loopback binding for the process lifetime. Gated by a per-project grant through the permission-gate the first time it is used; while off, tasks stay fully sandboxed.',
  scope: 'project',
}

/**
 * The `copse.background-tasks` pack: manifest declares the native tool
 * (`tools.native`) AND the loopback-bind permission relaxation; runtime
 * contributions carry the same tool name (so `activeToolNames()` reports it
 * while enabled) and the same permission (so `isPermissionDeclared('loopback-bind')`
 * is true while enabled). The atomicity contract test in
 * `enable-disable-atomicity.test.ts` asserts that `disable()` drops both the
 * tool and the permission in one flag flip.
 */
export const backgroundTasksPack: RegisteredPack = definePack(
  {
    name: BACKGROUND_TASKS_PACK_ID,
    description:
      'Background tasks — run a long-lived command (dev server, watcher, build) via the `run_background` tool that stays alive across turns, with list / logs / stop actions. A task can opt into binding a local port (reporting its http://localhost:<port> URL), which relaxes the sandbox to allow loopback binding, gated by a per-project permission grant.',
    trust: 'first-party',
    defaultEnabled: false,
    tools: { native: [BACKGROUND_TASKS_TOOL_NAME] },
    permissions: [LOOPBACK_BIND_PERMISSION_DECL],
  },
  {
    toolNames: [BACKGROUND_TASKS_TOOL_NAME],
    permissions: [LOOPBACK_BIND_PERMISSION_DECL],
  },
)
