import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { Project } from '@shared/types'
import { archiveThread, deleteThread } from '@shared/store/thread-helpers.ts'
import { showContextMenu, type ContextMenuEntry } from '../dom/context-menu.ts'
import {
  getSidebarThreads,
  isProjectSwitchInFlight,
  removeProject,
  switchProject,
} from '../controller/projects.ts'
import { forkThread } from '../controller/fork-thread.ts'
import type { SidebarThread } from '../controller/sidebar-thread.ts'
import { openAppRunDialog } from './app-run-dialog.ts'
import { hasAutomationDialog, openAutomationDialog } from './automation-dialog.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'
import { showErrorToast, showToast } from './toast.ts'

/** One schedule's run/setup actions, addressed the way the sidebar groups are. */
export interface AutomationMenuTarget {
  project: Project
  scheduleName: string
  scheduleId: string
}

/**
 * Fire a schedule immediately through the same IPC the editor's Run-now
 * button uses. The outcome surfaces as a toast: this runs from a menu that
 * has already closed, so unlike the editor there is no inline status element
 * to write into. A coalesced run says why, as the editor's status line does.
 */
export function startRunNow(api: ApiClient, target: AutomationMenuTarget): void {
  void api.automations
    .runNow(target.project.id, target.scheduleId)
    .then((event) => {
      showToast(
        event.disposition === 'started'
          ? `Started “${target.scheduleName}”.`
          : event.coalescedReason === 'worktree-limit'
            ? `“${target.scheduleName}” has reached its live worktree limit.`
            : `“${target.scheduleName}” is already pending or running.`,
      )
    })
    .catch((error: unknown) => {
      showErrorToast(
        `Could not run “${target.scheduleName}”`,
        ipcErrorMessage(error, 'The run could not start'),
      )
    })
}

/**
 * One schedule's shared right-click actions, rendered on the sidebar's
 * schedule headings. "Run now" is the editor's Run-now button, reached
 * without opening the dialog.
 */
export function automationMenuEntries(
  api: ApiClient,
  target: AutomationMenuTarget,
  openSetup: () => void,
): ContextMenuEntry[] {
  return [
    { heading: target.scheduleName },
    {
      label: 'Run now',
      onSelect: (): void => {
        startRunNow(api, target)
      },
    },
    {
      label: 'Automation setup…',
      onSelect: openSetup,
    },
  ]
}

/**
 * Branch the whole conversation into a new thread. Only the active project's
 * threads are in memory (and only its store dir is the fork IPC's subject).
 */
export function forkProjectThread(
  store: AppStore,
  api: ApiClient,
  projectId: string,
  threadId: string,
): void {
  if (projectId !== store.getState().activeProjectId) return
  void forkThread(store, api, threadId).then((result) => {
    if (!result) {
      showToast('That thread has no messages to fork.', { variant: 'error' })
      return
    }
    showToast('Forked into a new thread.')
  })
}

/** Archive a thread; only the active project's in-memory list is mutable here. */
export function archiveProjectThread(store: AppStore, projectId: string, threadId: string): void {
  if (projectId !== store.getState().activeProjectId) return
  archiveThread(store, threadId)
}

/** Delete a thread of the active project, keeping at least one thread listed. */
function deleteProjectThread(
  store: AppStore,
  api: ApiClient,
  projectId: string,
  threadId: string,
): boolean {
  if (projectId !== store.getState().activeProjectId) return false
  if (getSidebarThreads(store, projectId).length <= 1) return false
  void api.agent.clearHistory(projectId, threadId)
  deleteThread(store, threadId)
  return true
}

/**
 * A thread row's menu, opened by right-click or its three-dot button.
 * Mutations apply only to the active project, whose threads are in memory;
 * another project's row offers to open the thread first. Automation runs
 * always reach their schedule, and Delete comes last (#3379).
 */
export function threadMenuEntries(
  store: AppStore,
  api: ApiClient,
  options: {
    project: Project
    thread: SidebarThread
    allowRename: boolean
    allowDelete?: boolean
    onRename: () => void
    onOpen?: () => void
  },
): ContextMenuEntry[] {
  const { project, thread } = options
  const canMutate = project.id === store.getState().activeProjectId
  const scheduleId = thread.automation?.scheduleId
  return [
    ...(!canMutate && options.onOpen ? [{ label: 'Open thread', onSelect: options.onOpen }] : []),
    ...(canMutate
      ? [
          ...(options.allowRename ? [{ label: 'Rename', onSelect: options.onRename }] : []),
          {
            label: 'Fork',
            onSelect: (): void => {
              forkProjectThread(store, api, project.id, thread.id)
            },
          },
          {
            label: 'Archive',
            onSelect: (): void => {
              archiveProjectThread(store, project.id, thread.id)
            },
          },
        ]
      : []),
    // A schedule with a single run has no heading of its own, and a
    // historical run is several rows below the one that does, so every
    // automation row carries the way out to its setup. Opens directly
    // against this run's own project rather than switching the active
    // project just to reach the editor.
    ...(scheduleId
      ? [
          {
            label: 'Run now',
            onSelect: (): void => {
              startRunNow(api, {
                project,
                scheduleName: thread.automation?.scheduleName ?? thread.title,
                scheduleId,
              })
            },
          },
          {
            label: 'Automation setup…',
            onSelect: (): void => {
              openAutomationDialog(store, api, { projectId: project.id, scheduleId })
            },
          },
        ]
      : []),
    ...(canMutate && options.allowDelete
      ? [
          {
            label: 'Delete',
            disabled: getSidebarThreads(store, project.id).length <= 1,
            onSelect: (): void => {
              deleteProjectThread(store, api, project.id, thread.id)
            },
          },
        ]
      : []),
  ]
}

/** "Remove from sidebar" plus any caller-specific entries (e.g. group moves). */
export function projectMenuEntries(
  store: AppStore,
  api: ApiClient,
  project: Project,
): ContextMenuEntry[] {
  return [
    {
      label: 'Remove from sidebar',
      onSelect: (): void => {
        void removeProject(store, api, project.id)
      },
    },
  ]
}

/**
 * The project "⋯" menu: Run app (when detected), the project's automations,
 * then `trailing` (removal, group moves). Detection runs first, so the menu
 * opens at `anchor` once it knows which entries apply.
 */
export async function showProjectMenu(
  store: AppStore,
  api: ApiClient,
  project: Project,
  anchor: HTMLElement,
  trailing: readonly ContextMenuEntry[],
): Promise<void> {
  const state = store.getState()
  try {
    const [result, appDetected] = await Promise.all([
      api.plugins.list(),
      api.appRun
        .detect({
          projectId: project.id,
          ...(state.activeProjectId === project.id && state.activeThreadId
            ? { threadId: state.activeThreadId }
            : {}),
        })
        .catch(() => false),
    ])
    if (!anchor.isConnected) return
    const rect = anchor.getBoundingClientRect()
    const entries: ContextMenuEntry[] = []
    if (appDetected) {
      entries.push({
        label: 'Run app…',
        onSelect: (): void => {
          if (store.getState().activeProjectId === project.id) {
            openAppRunDialog(store, api, project.id)
            return
          }
          const unsubscribe = store.on('workspace_changed', () => {
            if (store.getState().activeProjectId === project.id) {
              unsubscribe()
              openAppRunDialog(store, api, project.id)
            } else if (!isProjectSwitchInFlight(store, project.id)) {
              unsubscribe()
            }
          })
          switchProject(store, api, project.id)
        },
      })
    }
    if (result.plugins.some(hasAutomationDialog)) {
      entries.push(
        {
          label: 'Automations',
          onSelect: (): void => {
            openAutomationDialog(store, api, { projectId: project.id })
          },
        },
        {
          label: 'New automation…',
          disabled: project.missing === true,
          onSelect: (): void => {
            openAutomationDialog(store, api, { projectId: project.id, createNew: true })
          },
        },
      )
    }
    showContextMenu(rect.left, rect.bottom, [...entries, ...trailing])
  } catch (error: unknown) {
    showErrorToast('Could not load project menu', error)
  }
}
