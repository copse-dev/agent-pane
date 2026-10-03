import { el } from '../dom/helpers.ts'
import { warningIcon } from '../dom/icons.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { OrphanProjectStore, Project } from '@shared/types'
import {
  dismissOrphanProject,
  listOrphanProjects,
  recoverOrphanProject,
  relocateProject,
  switchProject,
} from '../controller/projects.ts'
import { showConfirmDialog } from './confirm-dialog.ts'
import { showErrorToast, showToast } from './toast.ts'

/**
 * The quarantine notice shown when a project's folder could not be opened
 * (#997). Its threads are still on disk under ~/.copse/workspace/<id>/; the
 * action re-points the project at a folder (local) or retries the open (SSH).
 */
export function renderMissingNotice(
  store: AppStore,
  api: ApiClient,
  project: Project,
): HTMLElement {
  const wrap = el('div', { class: 'project-missing-notice', 'data-project-id': project.id })
  wrap.append(
    el(
      'div',
      { class: 'project-missing-text' },
      'This folder could not be opened. Its threads are safe — ' +
        (project.sshHost
          ? 'retry once the host is reachable.'
          : 'relocate the project to restore them.'),
    ),
  )
  const action = project.sshHost
    ? el('button', { type: 'button', class: 'project-missing-btn' }, 'Retry')
    : el('button', { type: 'button', class: 'project-missing-btn' }, 'Relocate…')
  action.addEventListener('click', () => {
    if (project.sshHost) {
      switchProject(store, api, project.id)
      return
    }
    void relocateProject(store, api, project.id).catch((err: unknown) => {
      showErrorToast('Could not relocate project', err)
    })
  })
  wrap.append(action)
  return wrap
}

// Orphaned thread stores (dirs with threads but no project entry) surfaced so
// they can be re-attached instead of recovered by hand (#997).
function orphanPrimaryLabel(orphan: OrphanProjectStore): string {
  const lead = orphan.sampleTitles[0]?.trim()
  if (lead) return lead
  const count = orphan.threadCount
  return `${String(count)} thread${count === 1 ? '' : 's'}`
}

function orphanSubtitle(orphan: OrphanProjectStore): string {
  const count = orphan.threadCount
  const countLabel = `${String(count)} thread${count === 1 ? '' : 's'}`
  const extra = orphan.sampleTitles.slice(1).filter((title) => title.trim().length > 0)
  if (extra.length === 0) return countLabel
  const shown = extra.slice(0, 2).join(' · ')
  const more =
    orphan.threadCount > orphan.sampleTitles.length
      ? ` · +${String(orphan.threadCount - orphan.sampleTitles.length)} more`
      : ''
  return `${countLabel} · ${shown}${more}`
}

function orphanRecoverDetail(orphan: OrphanProjectStore): string {
  const lines: string[] = [
    'Choose the folder this conversation belonged to. Copse will attach the saved threads to that project.',
  ]
  if (orphan.sampleTitles.length > 0) {
    lines.push('')
    lines.push('Threads in this store:')
    for (const title of orphan.sampleTitles) {
      lines.push(`• ${title}`)
    }
    if (orphan.threadCount > orphan.sampleTitles.length) {
      lines.push(`• …and ${String(orphan.threadCount - orphan.sampleTitles.length)} more`)
    }
  } else {
    lines.push('')
    lines.push(
      `This store holds ${String(orphan.threadCount)} thread${orphan.threadCount === 1 ? '' : 's'}.`,
    )
  }
  lines.push('')
  lines.push(`Store id: ${orphan.id}`)
  return lines.join('\n')
}

export interface RecoverableThreads {
  /** The "Recoverable threads" section, or null when there is nothing to recover. */
  section: () => HTMLElement | null
  readonly count: number
  refresh: () => void
  dispose: () => void
}

/**
 * Track orphaned thread stores and render their recovery section. The scan
 * re-runs only when a project is added, removed, or recovered: switches emit
 * `projects_changed` too, but cannot change which stores are orphaned.
 */
export function createRecoverableThreads(
  store: AppStore,
  api: ApiClient,
  /**
   * The list changed. `preserveScroll` is set when the reader removed a row
   * in place (Dismiss), so the surrounding list should keep its position.
   */
  changed: (options?: { preserveScroll: boolean }) => void,
): RecoverableThreads {
  let orphans: OrphanProjectStore[] = []
  let knownProjectIds = new Set(store.getState().projects.map((project) => project.id))
  let generation = 0

  function refresh(): void {
    const current = ++generation
    void listOrphanProjects(api)
      .then((scanned) => {
        if (current !== generation) return
        // Recovery can emit before its new project id reaches main-process
        // config. Exclude ids already known to the renderer from that stale scan.
        const known = new Set(store.getState().projects.map((project) => project.id))
        const next = scanned.filter((orphan) => !known.has(orphan.id))
        const differs =
          next.length !== orphans.length ||
          next.some((o, i) => {
            const prev = orphans[i]
            return (
              !prev ||
              o.id !== prev.id ||
              o.threadCount !== prev.threadCount ||
              o.updatedAt !== prev.updatedAt ||
              o.sampleTitles.join('\0') !== prev.sampleTitles.join('\0')
            )
          })
        orphans = next
        if (differs) changed()
      })
      .catch((err: unknown) => {
        if (current !== generation) return
        showErrorToast('Could not scan recoverable threads', err)
      })
  }

  const offProjects = store.on('projects_changed', () => {
    const nextIds = new Set(store.getState().projects.map((project) => project.id))
    if (
      nextIds.size === knownProjectIds.size &&
      [...nextIds].every((id) => knownProjectIds.has(id))
    ) {
      return
    }
    knownProjectIds = nextIds
    refresh()
  })

  function section(): HTMLElement | null {
    if (orphans.length === 0) return null
    const wrap = el('div', { class: 'orphans-section' })
    wrap.append(
      el(
        'div',
        { class: 'orphans-heading' },
        warningIcon('ui-icon ui-icon-sm'),
        el('span', {}, 'Recoverable threads'),
      ),
      el(
        'p',
        { class: 'orphans-hint' },
        'Saved chats with no project in the sidebar. Recover attaches them to a folder; Dismiss hides the row (threads stay on disk).',
      ),
    )
    for (const orphan of orphans) {
      const primary = orphanPrimaryLabel(orphan)
      const row = el(
        'div',
        { class: 'orphan-row', title: `Store ${orphan.id}`, 'data-orphan-id': orphan.id },
        el(
          'div',
          { class: 'orphan-copy' },
          el('span', { class: 'orphan-name' }, primary),
          el('span', { class: 'orphan-meta' }, orphanSubtitle(orphan)),
        ),
      )
      const actions = el('div', { class: 'orphan-actions' })
      const dismissBtn = el(
        'button',
        { type: 'button', class: 'orphan-dismiss-btn', title: 'Hide this store from the list' },
        'Dismiss',
      )
      dismissBtn.addEventListener('click', () => {
        void dismissOrphanProject(api, orphan.id)
          .then(() => {
            orphans = orphans.filter((entry) => entry.id !== orphan.id)
            changed({ preserveScroll: true })
            showToast('Recoverable threads hidden. They remain on disk.')
          })
          .catch((err: unknown) => {
            showErrorToast('Could not dismiss recoverable threads', err)
          })
      })
      const recoverBtn = el('button', { type: 'button', class: 'orphan-recover-btn' }, 'Recover…')
      recoverBtn.addEventListener('click', () => {
        void recoverOrphanProject(store, api, orphan.id, () =>
          showConfirmDialog({
            message: `Recover “${primary}”?`,
            detail: orphanRecoverDetail(orphan),
            confirmLabel: 'Choose folder…',
            cancelLabel: 'Cancel',
          }),
        )
          .then((recovered) => {
            if (!recovered) return
            orphans = orphans.filter((entry) => entry.id !== orphan.id)
            changed()
          })
          .catch((err: unknown) => {
            showErrorToast('Could not recover threads', err)
          })
      })
      actions.append(dismissBtn, recoverBtn)
      row.append(actions)
      wrap.append(row)
    }
    return wrap
  }

  refresh()
  return {
    section,
    get count(): number {
      return orphans.length
    },
    refresh,
    dispose: (): void => {
      generation += 1
      offProjects()
    },
  }
}
