/**
 * Config keys the renderer may read and write over `storage:get` / `storage:set`.
 *
 * This list is the single source of truth for two things that must agree: what
 * `src/renderer/controller/persistence.ts` actually persists, and what
 * `assertStorageKey` in `src/main/ipc/ipc-guards.ts` lets through. They used to
 * be written out separately, and adding a renderer key without touching the main
 * allowlist did not fail any renderer test — component tests stub `storage` with
 * no allowlist at all — it failed at runtime, in the packaged app, by rejecting
 * the IPC call. `loadProjects` runs during boot and is awaited without a catch,
 * so that rejection took the whole layout down: no chat, no composer, no panes
 * (issue #1685).
 *
 * Adding a key here is deliberate: it widens what a compromised renderer can
 * read and overwrite in `config.json`, so keep the list to state the renderer
 * genuinely owns.
 */
export const RENDERER_STORAGE_KEYS = ['projects', 'projectGroups', 'activeProjectId'] as const

export type RendererStorageKey = (typeof RENDERER_STORAGE_KEYS)[number]
