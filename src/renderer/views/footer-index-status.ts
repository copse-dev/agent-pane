import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { IndexComponentStatus, WorkspaceIndexStatus } from '@shared/types/index-status.ts'

/**
 * Suppress the chip for builds shorter than this. The workspace watcher
 * rebuilds the file index after every save and a warm semantic re-track runs
 * per search — both finish in well under a second, and flashing "Indexing…"
 * on each would make the footer strobe. Only stalls the user can feel show up.
 */
const SHOW_DELAY_MS = 1_500
const TICK_MS = 1_000

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${String(minutes)}m ${String(seconds)}s` : `${String(seconds)}s`
}

function componentLabel(component: 'fileIndex' | 'semantic'): string {
  return component === 'fileIndex' ? 'file index' : 'semantic code index'
}

function phaseLabel(phase: IndexComponentStatus['phase']): string {
  // `unavailable` covers both "no gortex/vera binary" and SSH workspaces, which
  // skip semantic indexing in v1 — avoid implying a missing install on remote roots.
  if (phase === 'unavailable') return 'unavailable'
  return phase
}

function describe(status: WorkspaceIndexStatus): string {
  const parts = (['fileIndex', 'semantic'] as const).map((key) => {
    const component = status[key]
    const reason = component.reason ? ` — ${component.reason}` : ''
    return `${componentLabel(key)}: ${phaseLabel(component.phase)}${reason}`
  })
  return `Workspace index — ${parts.join(', ')}`
}

/** Chip copy: distinguish a remote file-list build from a (local) semantic index. */
function buildingChipText(status: WorkspaceIndexStatus, elapsedLabel: string): string {
  const fileBuilding = status.fileIndex.phase === 'building'
  const semanticBuilding = status.semantic.phase === 'building'
  if (fileBuilding && !semanticBuilding) return `Building file index… ${elapsedLabel}`
  return `Indexing… ${elapsedLabel}`
}

function oldestBuildStart(status: WorkspaceIndexStatus): number | null {
  const starts = [status.fileIndex, status.semantic]
    .filter((c: IndexComponentStatus) => c.phase === 'building')
    .map((c) => c.startedAt)
    .filter((n): n is number => typeof n === 'number')
  return starts.length > 0 ? Math.min(...starts) : null
}

function scaleGuardChip(status: WorkspaceIndexStatus): {
  text: string
  state: 'limited' | 'skipped'
} | null {
  const phase = status.semantic.phase
  if (phase === 'skipped') return { text: 'Semantic index skipped', state: 'skipped' }
  if (phase === 'limited') return { text: 'Semantic index limited', state: 'limited' }
  return null
}

/**
 * Footer chip reporting workspace indexing: hidden when idle/ready, shows
 * "Indexing… <elapsed>" while a build runs (semantic cold builds take minutes,
 * #517), "Indexing failed" when the last build errored, and a persistent
 * limited/skipped chip when the #795 scale guard refuses unbounded semantic
 * work. Lives in the footer usage group next to the context wheel and queue
 * indicator.
 */
export function mountFooterIndexStatus(host: HTMLElement, api: ApiClient): { destroy: () => void } {
  const chip = el('span', { class: 'footer-indexing', hidden: '', role: 'status' })
  host.append(chip)

  let status: WorkspaceIndexStatus | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let destroyed = false

  function setTicking(ticking: boolean): void {
    if (ticking && timer === null) {
      timer = setInterval(render, TICK_MS)
    } else if (!ticking && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function hide(): void {
    chip.hidden = true
    chip.textContent = ''
    chip.removeAttribute('data-state')
    chip.removeAttribute('title')
  }

  function render(): void {
    if (!status) {
      hide()
      setTicking(false)
      return
    }

    const startedAt = oldestBuildStart(status)
    if (startedAt !== null) {
      // Keep ticking (to re-check the delay and refresh the elapsed label),
      // but stay hidden until the build has run long enough to matter.
      setTicking(true)
      const elapsed = Date.now() - startedAt
      if (elapsed < SHOW_DELAY_MS) {
        hide()
        return
      }
      chip.hidden = false
      chip.textContent = buildingChipText(status, formatElapsed(elapsed))
      chip.dataset['state'] = 'building'
      chip.title = describe(status)
      return
    }

    setTicking(false)
    if (status.fileIndex.phase === 'error' || status.semantic.phase === 'error') {
      chip.hidden = false
      chip.textContent = 'Indexing failed'
      chip.dataset['state'] = 'error'
      chip.title = describe(status)
      return
    }

    const guarded = scaleGuardChip(status)
    if (guarded) {
      chip.hidden = false
      chip.textContent = guarded.text
      chip.dataset['state'] = guarded.state
      chip.title = describe(status)
      return
    }

    hide()
  }

  function update(next: WorkspaceIndexStatus): void {
    status = next
    render()
  }

  const unsubscribe = api.index.onStatusChanged((next) => {
    if (!destroyed) update(next)
  })
  // Seed from current state — builds kicked off before this chip mounted
  // (workspace restored on launch) must still show. A pushed event wins.
  void api.index
    .status()
    .then((initial) => {
      if (!destroyed && status === null) update(initial)
    })
    .catch(() => undefined)

  return {
    destroy: (): void => {
      destroyed = true
      unsubscribe()
      setTicking(false)
      chip.remove()
    },
  }
}
