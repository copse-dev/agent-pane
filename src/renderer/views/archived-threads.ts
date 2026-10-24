import type { Project } from '@shared/types'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { restoreArchivedThread } from '../controller/thread-archive.ts'
import { el } from '../dom/helpers.ts'
import { showErrorToast } from './toast.ts'

/** Archived metadata is fetched only while this view is open. */
export function createArchivedThreads(
  store: AppStore,
  api: ApiClient,
  onRestored: () => void,
): {
  element: HTMLElement
  show(projects: readonly Project[], query: string): void
  invalidate(): void
  hide(): void
} {
  const element = el('section', { class: 'archived-threads', 'aria-label': 'Archived threads' })
  let generation = 0
  let selection = ''

  async function load(projects: readonly Project[], query: string, current: number): Promise<void> {
    element.replaceChildren(
      el('div', { class: 'sidebar-empty', role: 'status' }, 'Loading archives…'),
    )
    try {
      const groups = await Promise.all(
        projects.map(async (project) => ({
          project,
          state: await api.threads.archiveState(project.id, 'archived'),
        })),
      )
      if (current !== generation) return
      const rows = groups
        .flatMap(({ project, state }) =>
          state.archived
            .filter(
              (thread) =>
                !thread.sideChat &&
                thread.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            )
            .map((thread) => ({ project, thread })),
        )
        .sort((a, b) => (b.thread.archivedAt ?? 0) - (a.thread.archivedAt ?? 0))
      element.replaceChildren(
        el('p', { class: 'sidebar-empty' }, 'Archived threads stay here until you restore them.'),
      )
      if (rows.length === 0) {
        element.append(
          el('div', { class: 'sidebar-empty', role: 'status' }, 'No archived threads.'),
        )
      }
      for (const { project, thread } of rows) {
        const restore = el(
          'button',
          { type: 'button', class: 'ui-btn', 'aria-label': `Restore ${thread.title}` },
          'Restore',
        )
        const row = el(
          'div',
          { class: 'archived-thread-row', 'data-thread-id': thread.id },
          el(
            'div',
            { class: 'archived-thread-description' },
            el('span', { class: 'archived-thread-title' }, thread.title || 'New thread'),
            el('span', { class: 'archived-thread-project' }, project.name),
          ),
          restore,
        )
        restore.addEventListener('click', () => {
          restore.disabled = true
          void restoreArchivedThread(store, api, project.id, thread.id)
            .then(() => {
              selection = ''
              onRestored()
            })
            .catch((error: unknown) => {
              restore.disabled = false
              showErrorToast('Could not restore thread', error)
            })
        })
        element.append(row)
      }
    } catch (error) {
      if (current !== generation) return
      selection = ''
      element.replaceChildren(
        el(
          'div',
          { class: 'sidebar-empty', role: 'status' },
          'Could not load archived threads. Reopen the Archived filter to retry.',
        ),
      )
      showErrorToast('Could not load archived threads', error)
    }
  }

  const invalidate = (): void => {
    selection = ''
    generation++
  }
  return {
    element,
    show(projects, query): void {
      const next = JSON.stringify([projects.map((project) => [project.id, project.name]), query])
      if (selection === next) return
      selection = next
      void load(projects, query, ++generation)
    },
    invalidate,
    hide: invalidate,
  }
}
