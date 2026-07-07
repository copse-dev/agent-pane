import type {
  IndexComponentStatus,
  IndexPhase,
  WorkspaceIndexStatus,
} from '@shared/types/index-status.ts'

/**
 * Central status tracker for workspace indexing, feeding the renderer's
 * footer indicator over the `index:status_changed` IPC event.
 *
 * Builds overlap (the watcher's debounced rebuild can fire while a diff-queue
 * rebuild is in flight, and semantic ensure/update passes coalesce per root),
 * so each component counts active builds rather than toggling a boolean: the
 * phase is `building` while any build runs, and the terminal phase of the
 * batch (`ready`/`error`) applies only when the last one finishes.
 */
type IndexComponent = 'fileIndex' | 'semantic'

interface ComponentState {
  active: number
  startedAt: number | null
  /** Phase reported when no build is active. */
  restingPhase: IndexPhase
}

type StatusListener = (status: WorkspaceIndexStatus) => void

function initialState(): Record<IndexComponent, ComponentState> {
  return {
    fileIndex: { active: 0, startedAt: null, restingPhase: 'idle' },
    semantic: { active: 0, startedAt: null, restingPhase: 'idle' },
  }
}

let components = initialState()
const listeners = new Set<StatusListener>()

function componentStatus(state: ComponentState): IndexComponentStatus {
  if (state.active > 0) {
    return {
      phase: 'building',
      ...(state.startedAt !== null ? { startedAt: state.startedAt } : {}),
    }
  }
  return { phase: state.restingPhase }
}

export function getWorkspaceIndexStatus(): WorkspaceIndexStatus {
  return {
    fileIndex: componentStatus(components.fileIndex),
    semantic: componentStatus(components.semantic),
  }
}

function notify(): void {
  const status = getWorkspaceIndexStatus()
  for (const listener of listeners) {
    try {
      listener(status)
    } catch (err) {
      console.warn('[copse-panel] index status listener failed:', err)
    }
  }
}

export function onWorkspaceIndexStatusChanged(listener: StatusListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function indexBuildStarted(component: IndexComponent): void {
  const state = components[component]
  state.active += 1
  if (state.active === 1) state.startedAt = Date.now()
  notify()
}

export function indexBuildFinished(component: IndexComponent, ok: boolean): void {
  const state = components[component]
  state.active = Math.max(0, state.active - 1)
  state.restingPhase = ok ? 'ready' : 'error'
  if (state.active === 0) state.startedAt = null
  notify()
}

/** Mark the semantic backend as absent (no gortex/vera binary found at probe time). */
export function setSemanticIndexUnavailable(): void {
  components.semantic = { active: 0, startedAt: null, restingPhase: 'unavailable' }
  notify()
}

/** Test hook — reset counters, phases, and listeners between tests. */
export function resetWorkspaceIndexStatusForTest(): void {
  components = initialState()
  listeners.clear()
}
