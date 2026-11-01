import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Project, ProjectGroup, Thread } from '@shared/types'
import type { MainWindowNavigation } from '@shared/types/main-window.ts'
import { getThreadById, sortThreadsNewestFirst } from '@shared/store/thread-helpers.ts'
import { TRANSCRIPT_META_KEYS, type TranscriptMeta } from '@shared/store/transcript-state.ts'
import { backgroundProjectOf } from './background-threads.ts'
import { isApplyingRuntimeOwnedChunk, isRuntimeOwnedMessage } from './runtime-transcript.ts'
import { recordArrayOrEmpty } from '@shared/unknown-value.ts'
import type { RendererStorageKey } from '@shared/storage-keys.ts'

// On-disk persistence for projects and their chat threads. Projects stay in the
// shared electron-store (config.json). Threads live in the filesystem-native
// store (issue #644): the renderer maps store events onto event-level writes —
// `create` on a new thread, `appendMessage` on each human prompt and on each
// finalized message of a stream main does not own, and a debounced
// `updateMeta` for metadata (draft/usage/status/todos/title/…) — instead of
// rewriting whole threads on every keystroke. Messages of a turn main
// dispatched are main's to write.

// Named from the shared allowlist: `storage:get` / `storage:set` reject any key
// main does not know about, and `loadProjects` runs during an un-caught boot
// await — so a key that only exists here takes the whole layout down at launch
// rather than failing a test (see src/shared/storage-keys.ts).
const KEY_PROJECTS: RendererStorageKey = 'projects'
const KEY_PROJECT_GROUPS: RendererStorageKey = 'projectGroups'

// Autosave fires several events per turn and project switches save/load
// concurrently, so writes to the same key could overlap and land out of order
// (a stale in-flight write completing after a newer one). Chain writes per key
// so they apply strictly in submission order; the latest-submitted value wins.
const writeChains = new Map<string, Promise<unknown>>()

export function serializedSet(api: ApiClient, key: string, value: unknown): Promise<void> {
  const prev = writeChains.get(key) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(() => api.storage.set(key, value))
  writeChains.set(key, next)
  // The caller gets `next` and sees any rejection; this cleanup chain must not
  // raise a second, unhandled one.
  void next
    .finally(() => {
      if (writeChains.get(key) === next) writeChains.delete(key)
    })
    .catch(() => undefined)
  return next
}

/**
 * JSON of the projects list this window last wrote to config, or `null` when
 * nothing has been written yet (the first write always goes out).
 *
 * `projects_changed` is a re-render signal as much as an edit signal — a project
 * switch emits it several times — and each `storage:set` rewrites the whole
 * `config.json` synchronously on the main thread. Without this, one switch
 * rewrote an unchanged project list two or three times over. Deliberately not
 * seeded from `loadProjects`: that list is normalised on the way in (legacy
 * `worktreeMode` values, unknown fields dropped), so skipping the first write
 * would leave the old on-disk form in place until the user next edited a project.
 */
let persistedProjectsJson: string | null = null

function persistProjects(api: ApiClient, projects: Project[]): Promise<void> {
  const json = JSON.stringify(projects)
  if (json === persistedProjectsJson) return Promise.resolve()
  persistedProjectsJson = json
  return serializedSet(api, KEY_PROJECTS, projects).catch((error: unknown) => {
    // The write did not land, so the disk no longer matches `json`: forget it and
    // let the next save try again rather than skip it as already persisted.
    if (persistedProjectsJson === json) persistedProjectsJson = null
    throw error
  })
}

function serializedWrite(key: string, write: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(key)
  let next: Promise<void>
  if (prev) {
    next = prev.catch(() => undefined).then(write)
  } else {
    try {
      // Start the first IPC write synchronously. In particular, a new thread's
      // create must be sent before its immediately-following agent:run so main
      // can validate the project/thread pair without racing renderer autosave.
      next = write()
    } catch (error) {
      next = Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
  writeChains.set(key, next)
  void next
    .finally(() => {
      if (writeChains.get(key) === next) writeChains.delete(key)
    })
    .catch(() => undefined)
  return next
}

/**
 * Whether this window owns the persisted navigation (active project + thread).
 *
 * A pane pop-out boots this same renderer and restores the same project, but it
 * is a secondary *view* of the main window's workspace and does not own where
 * that workspace is pointed. The main process enforces this — `setNavigation`
 * rejects any sender that is not a registered full main window — so a pop-out
 * asking to persist navigation is not a recoverable write, it is a call it
 * should never have made. `main.ts` already withholds `attachAutosave` from a
 * pop-out for the same reason; this covers the direct `saveProjects` calls on
 * its boot path.
 *
 * Left as an explicit flag rather than softening the main-process guard: a full
 * main window that failed to register is a real bug, and it should still be
 * loud.
 */
let ownsNavigation = true

/** Set once at boot. A pane pop-out passes `false`. */
export function setNavigationOwnership(owns: boolean): void {
  ownsNavigation = owns
}

/**
 * Whether this window owns the per-window session record at all — navigation,
 * and the Browser pane's restorable tabs, which `setBrowserSession` rejects
 * from a pop-out for exactly the reason above. Exposed so the pane can decline
 * to write rather than firing IPC main is bound to refuse.
 */
export function ownsWindowSession(): boolean {
  return ownsNavigation
}

/**
 * Whether boot has restored the stored navigation yet.
 *
 * `attachAutosave` is attached well before `loadProjects` resolves, and
 * `flushNow` reads `activeProjectId` straight from the store — which is still
 * `null` until the restore lands. Persisting that null overwrites the window's
 * record and, for the primary window, the legacy `activeProjectId` mirror too,
 * so the app forgets which project was open. The symptom is a window that lists
 * its projects but has none active: `ssh-status-banner` short-circuits on
 * `!activeProjectId`, and the SSH disconnect banner never renders.
 *
 * Reads are unaffected — this only gates writing back.
 */
let navigationRestored = true

/**
 * Called by boot *before* `attachAutosave`, to close the window in which a
 * flush would persist the not-yet-restored `null`. Defaults open, so every
 * caller that is not boot — and every test — behaves exactly as before.
 */
export function suspendNavigationWrites(): void {
  navigationRestored = false
}

/**
 * The navigation last persisted (or restored) by this window, so an unchanged
 * value is never written back.
 *
 * `flushNow` writes navigation on every flush, and one of those flushes is the
 * `pagehide` fired while the window is being torn down. In e2e that teardown
 * happens *after* the next fixture has seeded `config.json`, so an unconditional
 * write puts the dying window's project back over the seed — the next launch
 * then boots with someone else's `activeProjectId`, or none. `main` never had
 * this because it only wrote `activeProjectId` when `projectsDirty`; this
 * restores that coupling without giving up per-window navigation.
 */
let lastNavigation: MainWindowNavigation | null = null

/**
 * Called by boot once `loadProjects` has put the stored navigation in the store.
 * The restored value becomes the baseline, so a window that never navigates
 * writes nothing at all.
 */
export function markNavigationRestored(restored: MainWindowNavigation): void {
  navigationRestored = true
  lastNavigation = restored
}

/**
 * The project a dispatched switch has already persisted as selected, while that
 * switch is still applying; `null` when no switch is in flight.
 *
 * Until the switch applies, the store still names the *outgoing* project, and
 * every writer that persists navigation from the store — the autosave flush, a
 * sidebar reorder, removing some other project — would put that project back.
 * Main mirrors navigation into the legacy `activeProjectId` key, which
 * project-scoped reads (`roadmap:list` and the rest of the project store) resolve
 * their directory from, and the switch repaints without awaiting its final
 * navigation write. So the outgoing project, written mid-switch, was what those
 * reads saw on `workspace_changed`: the roadmap listed the previous project's
 * notes. While held, a write naming any other project is dropped, which keeps
 * the persisted selection on the target from dispatch onwards.
 */
let navigationHeldFor: string | null = null

/**
 * Called by a project switch as it persists its target (`projectId`), and with
 * `null` once that switch is applied, superseded or abandoned — before any write
 * that puts the outgoing project back.
 */
export function holdNavigation(projectId: string | null): void {
  navigationHeldFor = projectId
}

function serializedNavigation(api: ApiClient, navigation: MainWindowNavigation): Promise<void> {
  if (!ownsNavigation || !navigationRestored) return Promise.resolve()
  if (
    (navigationHeldFor !== null && navigation.activeProjectId !== navigationHeldFor) ||
    (lastNavigation !== null &&
      lastNavigation.activeProjectId === navigation.activeProjectId &&
      lastNavigation.activeThreadId === navigation.activeThreadId)
  ) {
    // Held for another project, or unchanged. An unchanged value is recorded
    // before IPC finishes, so callers that await navigation before reading
    // project-scoped stores must also await that pending write.
    return (writeChains.get('mainWindow:navigation') ?? Promise.resolve()).then(() => undefined)
  }
  lastNavigation = navigation
  return serializedWrite('mainWindow:navigation', () => api.windowState.setNavigation(navigation))
}

// All writes for one thread (create / appendMessage / updateMeta / delete) share
// this key so they run strictly in order — a create is guaranteed to land before
// the first append even though they are separate IPC channels.
const threadWriteKey = (projectId: string, threadId: string): string =>
  `thread:${projectId}:${threadId}`

/**
 * Run `start` once this window's queued writes for a thread have landed —
 * synchronously when none are queued. Starting a turn goes through here: main
 * now writes the turn's transcript and reads the thread when the turn starts,
 * so the human prompt this window appended must be on disk first or main's
 * messages could be spine-ordered before it.
 */
export function afterThreadWrites<T>(
  projectId: string,
  threadId: string,
  start: () => Promise<T>,
): Promise<T> {
  const pending = writeChains.get(threadWriteKey(projectId, threadId))
  return pending ? pending.catch(() => undefined).then(start) : start()
}

type ThreadMeta = Omit<Thread, 'messages' | 'messagesLoaded' | 'hasSavedPlan'>

function metaOf(thread: Thread): ThreadMeta {
  // Mirror the main-process `metaOf`: load state and plan presence are derived
  // for this session. Hydration and plan saves must not write these projections
  // back as mutable metadata.
  const {
    messages: _messages,
    messagesLoaded: _messagesLoaded,
    hasSavedPlan: _hasSavedPlan,
    ...meta
  } = thread
  return meta
}

function metaSig(meta: ThreadMeta): string {
  return JSON.stringify(meta)
}

/**
 * Build the `updateMeta` patch for a changed thread. On disk `updateMeta` merges
 * `{ ...current, ...patch }`, which can set keys but never delete them — so a
 * field the renderer has dropped (a drained `pendingMessages`, a lifted
 * `queuePaused`, a cleared `contextSnapshot`) would otherwise linger in
 * `meta.json` and, on the next restore, resurrect a phantom "queued" message and
 * re-dispatch its run. Carry an explicit `undefined` for every key that was
 * present in the last-persisted meta but is now gone: the merge then writes
 * `undefined`, which `JSON.stringify` drops, clearing the field on disk.
 *
 * Only keys whose value changed since that baseline are sent. Main writes some
 * metadata directly (`prRefs`, `remoteAgentLink`, `modelSelections`); the
 * renderer's copy of those can be stale, and re-sending it with every unrelated
 * change (a draft keystroke) would overwrite the newer value on disk.
 */
function metaPatch(prev: ThreadMeta, next: ThreadMeta): Partial<ThreadMeta> {
  const before: Record<string, unknown> = { ...prev }
  const after: Record<string, unknown> = { ...next }
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key) || JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      patch[key] = after[key]
    }
  }
  for (const key of Object.keys(before)) {
    if (!Object.hasOwn(after, key)) patch[key] = undefined
  }
  return patch
}

// Each thread's last-persisted metadata, keyed by project then thread id. A
// change event only rewrites `meta.json` when the metadata actually changed
// (compared by signature); created/deleted threads are detected by diffing the
// id set, and the retained object lets us compute which keys a change removed.
// Seeded from disk on load so a freshly loaded project produces no spurious
// writes and its deletions are still detected. Per-project so a project switch
// never mistakes the other project's threads for deletions.
const persistedMeta = new Map<string, Map<string, ThreadMeta>>()

type PendingThreadWrite = { kind: 'save'; thread: Thread; meta: ThreadMeta } | { kind: 'delete' }

// These are targets, not acknowledgements. Comparing against the latest queued
// target coalesces repeated autosave events, while executing against persistedMeta
// lets a later write recover from an earlier failed create/update/delete.
const pendingThreadWrites = new Map<string, Map<string, PendingThreadWrite[]>>()

// Creation can commit before its IPC rejects (for example, a catalog write
// fails). Keep the first submitted metadata until acknowledgement: after an
// idempotent create retry, only subsequent user edits may be patched back.
const unconfirmedCreates = new Map<string, Map<string, { meta: ThreadMeta }>>()

interface UncertainThreadWrite {
  fields: Set<string>
  deleted: boolean
  target: ThreadMeta | null
}

// A rejection does not prove the primary write was rolled back: catalog repair
// can fail after metadata changed or the directory was removed. Preserve the
// touched fields/existence uncertainty until a later operation confirms them.
const uncertainThreadWrites = new Map<string, Map<string, UncertainThreadWrite>>()

interface ReadProjection {
  generation: number
  messagesLoaded: boolean | undefined
  hasSavedPlan: boolean | undefined
}

interface MetadataLoad {
  changed: Set<string>
  generation: number
  fullProjectionGeneration: number
  projections: Map<string, ReadProjection>
}

// Acknowledgements, submitted writes and uncertain rejections protect their IDs
// from older reads, including absent → create → delete ABA changes. The sets
// live only for the duration of their reads; no permanent tombstone cache.
const activeMetadataLoads = new Map<string, Set<MetadataLoad>>()
let metadataLoadGeneration = 0
const appliedProjectLoads = new Map<string, number>()
const appliedThreadLoads = new Map<string, Map<string, number>>()

function markMetadataChanged(projectId: string, threadId: string, ownLoad?: MetadataLoad): void {
  // Read/read ordering is handled by request generations below. Seeding an
  // older response must not suppress a newer response that is still pending.
  if (ownLoad) return
  for (const load of activeMetadataLoads.get(projectId) ?? []) load.changed.add(threadId)
}

function metadataBaseline(projectId: string): Map<string, ThreadMeta> {
  let metas = persistedMeta.get(projectId)
  if (!metas) {
    metas = new Map()
    persistedMeta.set(projectId, metas)
  }
  return metas
}

function acknowledgeMetadata(
  projectId: string,
  threadId: string,
  meta: ThreadMeta | null,
  ownLoad?: MetadataLoad,
): void {
  const metas = metadataBaseline(projectId)
  if (meta) metas.set(threadId, meta)
  else metas.delete(threadId)
  markMetadataChanged(projectId, threadId, ownLoad)
}

function retryMetaPatch(
  previous: ThreadMeta,
  next: ThreadMeta,
  uncertain: UncertainThreadWrite | undefined,
): Partial<ThreadMeta> {
  const patch = metaPatch(previous, next)
  const values: Record<string, unknown> = { ...next }
  for (const key of uncertain?.fields ?? []) Object.assign(patch, { [key]: values[key] })
  return patch
}

function runtimeMeta(previous: ThreadMeta, thread: Thread, before?: TranscriptMeta): ThreadMeta {
  const next = { ...previous }
  for (const key of TRANSCRIPT_META_KEYS) {
    if (before && JSON.stringify(before[key]) === JSON.stringify(thread[key])) continue
    Object.assign(next, { [key]: thread[key] })
  }
  return next
}

/** Runtime-derived fields are already owned by main, never autosaved back. */
export function acceptRuntimeThreadMeta(
  projectId: string,
  thread: Thread,
  before?: TranscriptMeta,
): void {
  const previous = persistedMeta.get(projectId)?.get(thread.id)
  if (previous) acknowledgeMetadata(projectId, thread.id, runtimeMeta(previous, thread, before))
  // Main can accept runtime-owned fields while a user metadata write is queued
  // or in flight. Carry only those accepted fields into its target; acknowledging
  // the whole renderer thread would falsely persist an unsaved draft/model edit.
  for (const pending of pendingThreadWrites.get(projectId)?.get(thread.id) ?? []) {
    if (pending.kind === 'save') pending.meta = runtimeMeta(pending.meta, thread, before)
  }
  const creation = unconfirmedCreates.get(projectId)?.get(thread.id)
  if (creation) creation.meta = runtimeMeta(creation.meta, thread, before)
  const uncertain = uncertainThreadWrites.get(projectId)?.get(thread.id)
  if (uncertain?.target) uncertain.target = runtimeMeta(uncertain.target, thread, before)
  for (const key of TRANSCRIPT_META_KEYS) {
    if (!before || JSON.stringify(before[key]) !== JSON.stringify(thread[key])) {
      uncertain?.fields.delete(key)
    }
  }
}

/** Queue one target, updating the acknowledged baseline only after success. */
function queueThreadWrite(
  api: ApiClient,
  projectId: string,
  threadId: string,
  target: PendingThreadWrite,
): Promise<void> {
  let projectPending = pendingThreadWrites.get(projectId)
  if (!projectPending) {
    projectPending = new Map()
    pendingThreadWrites.set(projectId, projectPending)
  }
  const queue = projectPending.get(threadId) ?? []
  projectPending.set(threadId, queue)
  queue.push(target)
  markMetadataChanged(projectId, threadId)

  return serializedWrite(threadWriteKey(projectId, threadId), async () => {
    const previous = metadataBaseline(projectId).get(threadId)
    const uncertain = uncertainThreadWrites.get(projectId)?.get(threadId)
    let submittedPatch: Partial<ThreadMeta> | undefined
    let attemptedDelete = false
    try {
      if (target.kind === 'delete') {
        if (previous || unconfirmedCreates.get(projectId)?.has(threadId) || uncertain?.deleted) {
          attemptedDelete = true
          await api.threads.delete(projectId, threadId)
        }
        acknowledgeMetadata(projectId, threadId, null)
      } else {
        if (!previous || uncertain?.deleted || unconfirmedCreates.get(projectId)?.has(threadId)) {
          let creations = unconfirmedCreates.get(projectId)
          if (!creations) {
            creations = new Map()
            unconfirmedCreates.set(projectId, creations)
          }
          const creation = creations.get(threadId) ?? { meta: previous ?? target.meta }
          creations.set(threadId, creation)
          await api.threads.create(projectId, { ...target.thread, ...target.meta })
          submittedPatch = retryMetaPatch(creation.meta, target.meta, uncertain)
        } else {
          submittedPatch = retryMetaPatch(previous, target.meta, uncertain)
        }
        if (Object.keys(submittedPatch).length > 0) {
          await api.threads.updateMeta(projectId, threadId, submittedPatch)
        }
        acknowledgeMetadata(projectId, threadId, target.meta)
      }
      const creations = unconfirmedCreates.get(projectId)
      creations?.delete(threadId)
      if (creations?.size === 0) unconfirmedCreates.delete(projectId)
      const uncertainties = uncertainThreadWrites.get(projectId)
      uncertainties?.delete(threadId)
      if (uncertainties?.size === 0) uncertainThreadWrites.delete(projectId)
    } catch (error) {
      const fields = Object.keys(submittedPatch ?? {})
      if (fields.length > 0 || attemptedDelete || target.kind === 'save') {
        let uncertainties = uncertainThreadWrites.get(projectId)
        if (!uncertainties) {
          uncertainties = new Map()
          uncertainThreadWrites.set(projectId, uncertainties)
        }
        const failed = uncertainties.get(threadId) ?? {
          fields: new Set<string>(),
          deleted: false,
          target: null,
        }
        for (const field of fields) failed.fields.add(field)
        failed.deleted ||= attemptedDelete
        failed.target = target.kind === 'save' ? target.meta : null
        uncertainties.set(threadId, failed)
        markMetadataChanged(projectId, threadId)
      }
      throw error
    } finally {
      queue.splice(queue.indexOf(target), 1)
      if (queue.length === 0) projectPending.delete(threadId)
      if (projectPending.size === 0 && pendingThreadWrites.get(projectId) === projectPending) {
        pendingThreadWrites.delete(projectId)
      }
    }
  })
}

/**
 * Diff against the latest submitted target to avoid duplicate queued writes.
 * Each callback resolves create/update/delete against the acknowledged baseline
 * when it runs: a failed create must not turn the next save into an update of a
 * thread that does not exist. Rejected targets stay dirty for an unchanged flush.
 */
function reconcileThreads(api: ApiClient, projectId: string, threads: Thread[]): Promise<void> {
  const previous = new Map(persistedMeta.get(projectId))
  for (const [id, queue] of pendingThreadWrites.get(projectId) ?? []) {
    const target = queue.at(-1)
    if (target?.kind === 'save') previous.set(id, target.meta)
    else previous.delete(id)
  }
  const next = new Map(threads.map((thread) => [thread.id, { thread, meta: metaOf(thread) }]))
  const writes: Array<Promise<void>> = []
  for (const [id, target] of next) {
    const before = previous.get(id)
    const uncertain = uncertainThreadWrites.get(projectId)?.has(id)
    const pending = pendingThreadWrites.get(projectId)?.has(id)
    if (!before || metaSig(before) !== metaSig(target.meta) || (uncertain && !pending)) {
      writes.push(queueThreadWrite(api, projectId, id, { kind: 'save', ...target }))
    }
  }
  const potentiallyCreated = new Set([
    ...previous.keys(),
    ...(unconfirmedCreates.get(projectId)?.keys() ?? []),
    ...(uncertainThreadWrites.get(projectId)?.keys() ?? []),
  ])
  for (const id of potentiallyCreated) {
    const pending = pendingThreadWrites.get(projectId)?.get(id)?.at(-1)
    if (!next.has(id) && pending?.kind !== 'delete') {
      writes.push(queueThreadWrite(api, projectId, id, { kind: 'delete' }))
    }
  }
  // A flush is a durability barrier even when its target was already queued.
  // In particular, switching away must await a pending create or deletion and
  // observe its failure instead of treating deduplication as an acknowledgement.
  for (const id of pendingThreadWrites.get(projectId)?.keys() ?? []) {
    const pending = writeChains.get(threadWriteKey(projectId, id))
    if (pending) writes.push(pending.then(() => undefined))
  }
  return Promise.all(writes).then(() => undefined)
}

/**
 * Flush a project's current thread metadata to disk. Used when switching away
 * from a project so any debounced metadata changes are committed before its
 * state leaves memory (message content is already appended as it finalizes).
 */
export function flushProjectThreads(
  api: ApiClient,
  projectId: string,
  threads: Thread[],
): Promise<void> {
  return reconcileThreads(api, projectId, threads)
}

/** Test-only: clear the per-project metadata baseline and write chains. */
export function __resetPersistenceForTest(): void {
  persistedMeta.clear()
  pendingThreadWrites.clear()
  unconfirmedCreates.clear()
  uncertainThreadWrites.clear()
  activeMetadataLoads.clear()
  appliedProjectLoads.clear()
  appliedThreadLoads.clear()
  metadataLoadGeneration = 0
  persistedProjectsJson = null
  writeChains.clear()
  activeAutosave = null
  ownsNavigation = true
  navigationRestored = true
  lastNavigation = null
  navigationHeldFor = null
}

export async function loadProjects(api: ApiClient): Promise<{
  projects: Project[]
  projectGroups: ProjectGroup[]
  activeProjectId: string | null
  activeThreadId: string | null
}> {
  const projects = recordArrayOrEmpty(await api.storage.get(KEY_PROJECTS)).flatMap((value) => {
    const id = value['id']
    const path = value['path']
    const name = value['name']
    if (typeof id !== 'string' || typeof path !== 'string' || typeof name !== 'string') return []
    const project: Project = { id, path, name }
    if (typeof value['sshHost'] === 'string') project.sshHost = value['sshHost']
    if (typeof value['missing'] === 'boolean') project.missing = value['missing']
    // A groupId naming a group that is not in config reads as top level at
    // render time (see project-tree.ts), so it is kept rather than dropped.
    if (typeof value['groupId'] === 'string') project.groupId = value['groupId']
    const worktreeMode = value['worktreeMode']
    // `from-default-branch` predates cutting worktrees from the default branch
    // unconditionally; it now means the same thing as `always`.
    if (worktreeMode === 'never' || worktreeMode === 'always' || worktreeMode === 'on-write') {
      project.worktreeMode = worktreeMode
    } else if (worktreeMode === 'from-default-branch') {
      project.worktreeMode = 'always'
    }
    return [project]
  })
  const projectGroups = recordArrayOrEmpty(await api.storage.get(KEY_PROJECT_GROUPS)).flatMap(
    (value) => {
      const id = value['id']
      const name = value['name']
      if (typeof id !== 'string' || typeof name !== 'string') return []
      const group: ProjectGroup = { id, name }
      if (value['collapsed'] === true) group.collapsed = true
      return [group]
    },
  )
  const navigation = await api.windowState.getNavigation()
  return { projects, projectGroups, ...navigation }
}

export async function saveProjects(
  api: ApiClient,
  projects: Project[],
  activeProjectId: string | null,
  activeThreadId: string | null,
): Promise<void> {
  await Promise.all([
    persistProjects(api, projects),
    serializedNavigation(api, { activeProjectId, activeThreadId }),
  ])
}

/**
 * Persist only the window's navigation (active project + thread). For callers
 * that have just written the projects list and would otherwise rewrite it
 * unchanged through {@link saveProjects}. An unchanged navigation is a no-op.
 */
export function saveNavigation(
  api: ApiClient,
  activeProjectId: string | null,
  activeThreadId: string | null,
): Promise<void> {
  return serializedNavigation(api, { activeProjectId, activeThreadId })
}

/**
 * Persist the sidebar's group list. Kept off {@link saveProjects} because groups
 * only change through group actions (create / rename / delete / collapse / a
 * drag), while `saveProjects` runs on every project switch and autosave tick.
 */
export function saveProjectGroups(api: ApiClient, groups: ProjectGroup[]): Promise<void> {
  return serializedSet(api, KEY_PROJECT_GROUPS, groups)
}

const threadLoadRevisions = new WeakMap<ApiClient, Map<string, number>>()

/** Discard metadata responses that started before a main-process archive/restore. */
export function invalidateProjectThreadLoads(api: ApiClient, projectId: string): void {
  let revisions = threadLoadRevisions.get(api)
  if (!revisions) {
    revisions = new Map()
    threadLoadRevisions.set(api, revisions)
  }
  revisions.set(projectId, (revisions.get(projectId) ?? 0) + 1)
}

/** Replace metadata exactly, preserving only the separately loaded projections. */
function threadWithMeta(thread: Thread, meta: ThreadMeta, projection?: ReadProjection): Thread {
  const messagesLoaded = projection ? projection.messagesLoaded : thread.messagesLoaded
  const hasSavedPlan = projection ? projection.hasSavedPlan : thread.hasSavedPlan
  return {
    ...meta,
    messages: thread.messages,
    ...(messagesLoaded !== undefined ? { messagesLoaded } : {}),
    ...(hasSavedPlan !== undefined ? { hasSavedPlan } : {}),
  }
}

async function readThreadMetadata(
  api: ApiClient,
  projectId: string,
  onlyThreadId?: string,
): Promise<Thread[]> {
  const load: MetadataLoad = {
    changed: new Set(),
    generation: 0,
    fullProjectionGeneration: 0,
    projections: new Map(),
  }
  let loads = activeMetadataLoads.get(projectId)
  if (!loads) {
    loads = new Set()
    activeMetadataLoads.set(projectId, loads)
  }
  loads.add(load)
  try {
    let loaded: Thread[]
    let revision: number
    do {
      revision = threadLoadRevisions.get(api)?.get(projectId) ?? 0
      load.generation = ++metadataLoadGeneration
      loaded = await api.threads.loadProject(projectId)
    } while (revision !== (threadLoadRevisions.get(api)?.get(projectId) ?? 0))
    const threads = sortThreadsNewestFirst(loaded)
      .filter((thread) => onlyThreadId === undefined || thread.id === onlyThreadId)
      .map((thread) =>
        onlyThreadId === undefined &&
        thread.status !== 'running' &&
        thread.lastSettledAt === undefined
          ? { ...thread, lastSettledAt: thread.updatedAt }
          : thread,
      )
    const baseline = metadataBaseline(projectId)
    const beforeSeed = new Map(baseline)
    const returned = new Map(threads.map((thread) => [thread.id, thread]))
    if (load.generation < (appliedProjectLoads.get(projectId) ?? 0)) {
      for (const id of new Set([...baseline.keys(), ...returned.keys()])) load.changed.add(id)
    }
    for (const [id, generation] of appliedThreadLoads.get(projectId) ?? []) {
      if (load.generation < generation) load.changed.add(id)
    }
    // Preserve the live map: in-flight writers must never acknowledge an
    // orphaned map. Changed IDs also protect acknowledgements that landed
    // before this stale read returned, and tombstones for newer deletions.
    for (const id of baseline.keys()) {
      if (onlyThreadId !== undefined && id !== onlyThreadId) continue
      if (!returned.has(id) && !load.changed.has(id)) {
        acknowledgeMetadata(projectId, id, null, load)
      }
    }
    for (const thread of threads) {
      if (!load.changed.has(thread.id)) {
        const meta = metaOf(thread)
        const uncertain = uncertainThreadWrites.get(projectId)?.get(thread.id)
        const creation = unconfirmedCreates.get(projectId)?.get(thread.id)
        const before = beforeSeed.get(thread.id) ?? creation?.meta ?? meta
        // Adopt proven disk fields while retaining only local write intent.
        // Neither a pending target nor a rejected patch becomes acknowledged.
        for (const pending of pendingThreadWrites.get(projectId)?.get(thread.id) ?? []) {
          if (pending.kind === 'save') {
            pending.meta = { ...meta, ...retryMetaPatch(before, pending.meta, uncertain) }
          }
        }
        if (uncertain?.target) {
          uncertain.target = { ...meta, ...retryMetaPatch(before, uncertain.target, uncertain) }
        }
        if (creation) creation.meta = meta
        acknowledgeMetadata(projectId, thread.id, meta, load)
      }
    }
    for (const id of load.changed) {
      if (onlyThreadId !== undefined && id !== onlyThreadId) continue
      const current = baseline.get(id)
      if (current) {
        const old = returned.get(id) ?? { ...current, messages: [], messagesLoaded: false }
        returned.set(id, threadWithMeta(old, current))
      } else {
        returned.delete(id)
      }
    }
    // A read must not replace UI intent that is queued or awaiting repair.
    // This is a projection only: those fields are NOT acknowledged as saved.
    for (const id of new Set([
      ...returned.keys(),
      ...(pendingThreadWrites.get(projectId)?.keys() ?? []),
      ...(uncertainThreadWrites.get(projectId)?.keys() ?? []),
    ])) {
      if (onlyThreadId !== undefined && id !== onlyThreadId) continue
      const pending = pendingThreadWrites.get(projectId)?.get(id)?.at(-1)
      const uncertain = uncertainThreadWrites.get(projectId)?.get(id)
      if (pending?.kind === 'delete' || (!pending && uncertain?.target === null)) {
        returned.delete(id)
        continue
      }
      const target = pending?.kind === 'save' ? pending.meta : uncertain?.target
      if (!target) continue
      const current = returned.get(id) ?? { ...target, messages: [], messagesLoaded: false }
      const before =
        beforeSeed.get(id) ?? unconfirmedCreates.get(projectId)?.get(id)?.meta ?? target
      const patch = retryMetaPatch(before, target, uncertain)
      returned.set(id, threadWithMeta(current, { ...metaOf(current), ...patch }))
    }
    // Derived retention/load flags are not mutable metadata. A newer read
    // must nevertheless carry them into older pending reads, or a saved plan
    // can become a "blank" task after hydration and be deleted by pruning.
    for (const [id, thread] of returned) {
      const known = load.projections.get(id)
      const projection =
        known && known.generation >= load.fullProjectionGeneration
          ? known
          : {
              generation: load.fullProjectionGeneration,
              messagesLoaded: undefined,
              hasSavedPlan: undefined,
            }
      if (projection.generation > load.generation) {
        returned.set(id, threadWithMeta(thread, metaOf(thread), projection))
      }
    }
    for (const older of loads) {
      if (older === load || older.generation >= load.generation) continue
      if (onlyThreadId === undefined) {
        older.fullProjectionGeneration = Math.max(older.fullProjectionGeneration, load.generation)
        for (const [id, projection] of older.projections) {
          if (projection.generation <= load.generation) older.projections.delete(id)
        }
      }
      for (const [id, thread] of returned) {
        const previous = older.projections.get(id)
        if (!previous || previous.generation < load.generation) {
          older.projections.set(id, {
            generation: load.generation,
            messagesLoaded: thread.messagesLoaded,
            hasSavedPlan: thread.hasSavedPlan,
          })
        }
      }
    }
    if (onlyThreadId === undefined) {
      appliedProjectLoads.set(
        projectId,
        Math.max(appliedProjectLoads.get(projectId) ?? 0, load.generation),
      )
      const scoped = appliedThreadLoads.get(projectId)
      for (const [id, generation] of scoped ?? []) {
        if (generation <= load.generation) scoped?.delete(id)
      }
      if (scoped?.size === 0) appliedThreadLoads.delete(projectId)
    } else {
      let scoped = appliedThreadLoads.get(projectId)
      if (!scoped) {
        scoped = new Map()
        appliedThreadLoads.set(projectId, scoped)
      }
      scoped.set(onlyThreadId, Math.max(scoped.get(onlyThreadId) ?? 0, load.generation))
    }
    return sortThreadsNewestFirst([...returned.values()])
  } finally {
    loads.delete(load)
    if (loads.size === 0 && activeMetadataLoads.get(projectId) === loads) {
      activeMetadataLoads.delete(projectId)
    }
  }
}

export function loadThreads(api: ApiClient, projectId: string): Promise<Thread[]> {
  return readThreadMetadata(api, projectId)
}

/** Read/register one restored thread without letting a stale read erase newer writes. */
export async function loadPersistedThread(
  api: ApiClient,
  projectId: string,
  threadId: string,
): Promise<Thread | undefined> {
  return (await readThreadMetadata(api, projectId, threadId))[0]
}

export const AUTOSAVE_DEBOUNCE_MS = 250

export interface Autosave {
  /** Persist any pending changes immediately and await the writes. */
  flush(): Promise<void>
  /**
   * Await in-flight thread writes without forcing a projects save.
   * Settles even when a write rejects so callers can still proceed.
   */
  whenIdle(): Promise<void>
  /** Remove listeners and cancel the pending timer (mainly for tests). */
  detach(): void
}

/** Active autosave from the most recent `attachAutosave` (cleared on detach). */
let activeAutosave: Autosave | null = null

/**
 * Wait for any in-flight autosave writes (especially immediate `threads:create`
 * on a new id). Used by `terminal:create` so main's ownership check cannot race
 * ahead of the create that `threads_changed` already kicked off.
 */
export function awaitPendingThreadPersistence(): Promise<void> {
  return activeAutosave?.whenIdle() ?? Promise.resolve()
}

// Autosave: maps store mutations onto event-level thread-store writes.
//
// - Metadata changes (draft, usage, status, todos, title, branch, structural
//   create/delete) schedule a debounced `reconcile`: it diffs each thread's
//   current metadata signature against the last-persisted one and emits exactly
//   `create` (new id), `updateMeta` (changed meta), or `delete` (removed id).
// - Finalized messages persist immediately via `appendMessage` (the commit
//   point), preceded by a `reconcile` on the same per-thread queue so a
//   brand-new thread's `create` lands before its first append. The exception is
//   a turn main dispatched: main reduces and writes that transcript itself, so
//   events fired while a stamped chunk is applied write nothing here (see
//   `runtime-transcript.ts`). Human prompts are still written from here.
//
// Stale-save protection: every write resolves the active project / thread from
// current state at fire time. A late `message_done` from a thread that is gone
// after a project switch finds no thread and writes nothing; `reconcile` only
// ever runs against the active project's own baseline.
export function attachAutosave(store: AppStore, api: ApiClient): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null
  let projectsDirty = false
  // Immediate new-thread creates (and other flushNow work) must be awaitable from
  // flush()/pagehide so callers do not observe a resolved flush while create is
  // still in flight.
  let inflightFlush: Promise<void> = Promise.resolve()

  const reconcile = (projectId: string): Promise<void> =>
    reconcileThreads(api, projectId, store.getState().threads)

  // Persist one message immediately. Reconcile first (same per-thread queue) so a
  // not-yet-created thread is created before its message is appended.
  const persistMessage = (projectId: string, threadId: string, messageId: string): void => {
    const thread = store.getState().threads.find((t) => t.id === threadId)
    const message = thread?.messages.find((m) => m.id === messageId)
    if (!message) return
    void reconcile(projectId)
    void serializedWrite(threadWriteKey(projectId, threadId), () =>
      api.threads.appendMessage(projectId, threadId, message),
    )
  }

  // Persist a finalized message of a carried background run (#1841). No
  // reconcile: reconcileThreads diffs a project's baseline against
  // `state.threads`, which belongs to the *active* project — running it with
  // the background project's id would read its threads as deleted. The thread
  // was created while its project was active, so the append alone is enough.
  const persistBackgroundMessage = (
    projectId: string,
    threadId: string,
    messageId: string,
  ): void => {
    const message = getThreadById(store, threadId)?.messages.find((m) => m.id === messageId)
    if (!message) return
    void serializedWrite(threadWriteKey(projectId, threadId), () =>
      api.threads.appendMessage(projectId, threadId, message),
    )
  }

  const threadIdOfMessage = (messageId: string): string | undefined => {
    const { threads, backgroundThreads, activeThreadId } = store.getState()
    const active = threads.find((t) => t.id === activeThreadId)
    if (active?.messages.some((m) => m.id === messageId)) return active.id
    // Skip threads whose transcript is not in memory: their empty `messages`
    // proves nothing, and matching against it would silently attribute the
    // message to the wrong thread or to none. Anything actually streaming a
    // message has been hydrated first (see `ensureThreadMessages` callers).
    return (
      threads.find(
        (t) => t.messagesLoaded !== false && t.messages.some((m) => m.id === messageId),
      ) ??
      backgroundThreads
        .map((b) => b.thread)
        .find((t) => t.messagesLoaded !== false && t.messages.some((m) => m.id === messageId))
    )?.id
  }

  const flushNow = (): Promise<void> => {
    const { activeProjectId, activeThreadId, projects } = store.getState()
    const writes: Array<Promise<void>> = []
    if (projectsDirty) {
      projectsDirty = false
      writes.push(persistProjects(api, projects))
    }
    writes.push(serializedNavigation(api, { activeProjectId, activeThreadId }))
    if (activeProjectId) writes.push(reconcile(activeProjectId))
    const done = Promise.all(writes).then(() => undefined)
    inflightFlush = Promise.all([inflightFlush.catch(() => undefined), done]).then(() => undefined)
    return done
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void flushNow()
    }, AUTOSAVE_DEBOUNCE_MS)
  }

  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    // Deliberately NOT forcing `projectsDirty` here: every projects mutation
    // sets it via `projects_changed`, so an unchanged list needs no write. One
    // of these flushes is the `pagehide` of a window being torn down, and (as
    // with `lastNavigation` above) an unconditional write there put the dying
    // window's — possibly stale — project list back over state a fresh launch
    // was about to read. Observed as the e2e teardown wiping a just-seeded
    // config.json's projects with the outgoing window's empty list.
    return flushNow().then(() => inflightFlush)
  }

  const unsubscribes = [
    store.on('threads_changed', () => {
      const { activeProjectId, threads } = store.getState()
      if (!activeProjectId) {
        schedule()
        return
      }
      // Blank-thread first send calls `agent:prepare-checkout` before any
      // `message_added` reconcile. Debouncing that create leaves a race that
      // surfaces as "Thread is not persisted yet; retry sending the message".
      // The integrated terminal has the same race on `terminal:create` when a
      // new thread is opened with the Terminal pane already visible.
      // Flush immediately when threads_changed introduces a new id so main can
      // validate the project/thread pair; callers that need the create on disk
      // (send, terminal spawn) must still `awaitPendingThreadPersistence()`.
      const prev = persistedMeta.get(activeProjectId) ?? new Map()
      if (threads.some((t) => !prev.has(t.id))) {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        void flushNow()
        return
      }
      schedule()
    }),
    store.on('thread_draft_changed', () => {
      schedule()
    }),
    store.on('usage_updated', () => {
      schedule()
    }),
    store.on('thread_status_changed', () => {
      schedule()
    }),
    store.on('todos_changed', () => {
      schedule()
    }),
    store.on('context_updated', () => {
      schedule()
    }),
    // A dismissed (or landed) comparison changes thread metadata with no other
    // event in flight — e.g. dismissing a failed card on an idle thread — so it
    // needs its own autosave trigger or the card resurrects on reload.
    store.on('comparison_changed', () => {
      schedule()
    }),
    // Same for the review report: a dismissed finding or a cleared card is a
    // metadata-only change on an idle thread. A report anchored to a message
    // lives on that message's spine line instead, so re-finalize the message:
    // a standalone review (Changes view "Review") ends with a `done` that has
    // no streaming message, so no `message_done` would ever carry it to disk.
    store.on('review_report_changed', (threadId, messageId) => {
      if (messageId === null) {
        schedule()
        return
      }
      // Anchored by a turn main owns: main wrote it.
      if (isApplyingRuntimeOwnedChunk()) return
      const message = getThreadById(store, threadId)?.messages.find(
        (candidate) => candidate.id === messageId,
      )
      if (!message) return
      // A `running` card is transient; the settled report (or error) replaces
      // it. Persisting it would leave a card spinning forever after a crash.
      // A message still streaming a tool is finalized by its own
      // `message_done`; the v1 spine has no running tool status.
      if (message.reviewReport?.status === 'running') return
      if (message.toolCalls.some((toolCall) => toolCall.status === 'running')) return
      const backgroundProjectId = backgroundProjectOf(store, threadId)
      if (backgroundProjectId) {
        persistBackgroundMessage(backgroundProjectId, threadId, messageId)
        return
      }
      const { activeProjectId } = store.getState()
      if (activeProjectId) persistMessage(activeProjectId, threadId, messageId)
    }),
    store.on('projects_changed', () => {
      projectsDirty = true
      schedule()
    }),
    store.on('message_added', (threadId, messageId) => {
      const message = getThreadById(store, threadId)?.messages.find((m) => m.id === messageId)
      // User messages are complete when added — persist now. An assistant message
      // is created empty and streamed, so it waits for `message_done`; still
      // reconcile so the thread's create/meta lands.
      // A machine turn's prompt arrives in a stamped chunk; main wrote it.
      if (message?.role === 'user' && isApplyingRuntimeOwnedChunk()) {
        schedule()
        return
      }
      if (message?.role === 'user') {
        const backgroundProjectId = backgroundProjectOf(store, threadId)
        if (backgroundProjectId) {
          persistBackgroundMessage(backgroundProjectId, threadId, messageId)
          return
        }
      }
      const { activeProjectId } = store.getState()
      if (!activeProjectId) return
      if (message?.role === 'user') persistMessage(activeProjectId, threadId, messageId)
      else schedule()
    }),
    store.on('message_done', (messageId) => {
      // Main finalized and wrote this message from the same chunk.
      if (isApplyingRuntimeOwnedChunk()) return
      const threadId = threadIdOfMessage(messageId)
      if (!threadId) return
      // A carried background run persists into its own project's store; the
      // active-project path would either miss the message or file it under
      // the wrong project (#1841).
      const backgroundProjectId = backgroundProjectOf(store, threadId)
      if (backgroundProjectId) {
        persistBackgroundMessage(backgroundProjectId, threadId, messageId)
        return
      }
      const { activeProjectId } = store.getState()
      if (activeProjectId) persistMessage(activeProjectId, threadId, messageId)
    }),
    // ACP agents may patch raw input/output after the turn's message was first
    // finalized (including between-turn background updates). Re-finalize the
    // owning message when that tool settles so events.jsonl + its result blob
    // carry the latest args/response across an app restart. Do not persist a
    // running tool: the v1 spine deliberately has no running status.
    store.on('tool_call_updated', (messageId, toolCallId) => {
      if (isApplyingRuntimeOwnedChunk()) return
      // A summary label on a main-owned message is sent to main to merge
      // (`applySummary` in agent.ts); writing this copy could undo main's.
      if (!toolCallId && isRuntimeOwnedMessage(messageId)) return
      const threadId = threadIdOfMessage(messageId)
      if (!threadId) return
      const message = getThreadById(store, threadId)?.messages.find(
        (candidate) => candidate.id === messageId,
      )
      if (!message) return
      if (toolCallId) {
        const toolCall = message.toolCalls.find((candidate) => candidate.id === toolCallId)
        if (!toolCall || toolCall.status === 'running') return
      }
      // An empty tool-call id is a small-model rollup label landing on the
      // message (command / turn / run summary). A run summary in particular
      // resolves against its *anchor*, whose `message_done` fired turns ago, so
      // without this the polished label never reached disk.
      const backgroundProjectId = backgroundProjectOf(store, threadId)
      if (backgroundProjectId) {
        persistBackgroundMessage(backgroundProjectId, threadId, messageId)
        return
      }
      const { activeProjectId } = store.getState()
      if (activeProjectId) persistMessage(activeProjectId, threadId, messageId)
    }),
  ]

  const onPagehide = (): void => void flush()
  window.addEventListener('pagehide', onPagehide)

  const whenIdle = (): Promise<void> => inflightFlush.catch(() => undefined)

  const autosave: Autosave = {
    flush,
    whenIdle,
    detach(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      unsubscribes.forEach((u) => {
        u()
      })
      window.removeEventListener('pagehide', onPagehide)
      if (activeAutosave === autosave) activeAutosave = null
    },
  }
  activeAutosave = autosave
  return autosave
}
