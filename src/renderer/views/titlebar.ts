import { openAppRunDialog } from './app-run-dialog.ts'
import { chevronDownIcon, playIcon } from '../dom/icons.ts'
import { getActiveThread, isBlankThread } from '@shared/store/thread-helpers.ts'
import { projectDisplayName, setSidebarProjectFilter } from '../controller/projects.ts'
import { contextMenuClosedByPressOn, showContextMenu } from '../dom/context-menu.ts'
import { el } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import { setTooltip } from '../dom/tooltip.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountOpenInEditor } from './open-in-editor.ts'
import { mountPanelModeControls } from './panel-mode-controls.ts'
import { getActiveThreadOwner } from '../controller/active-thread-owner.ts'
import { bindTitlebarCompactLayout } from './titlebar-compact.ts'
import { toggleProjectsPane } from '../controller/panels.ts'
import { isMacPlatform } from './keyboard-shortcuts-dialog.ts'

const PROJECTS_COLLAPSED_CLASS = 'is-projects-collapsed'

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

export function mountTitlebar(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  // The structural #titlebar div needs the .titlebar class for its flex layout,
  // height, and traffic-light clearance to apply. Without it the controls
  // collapse and hide under the macOS window buttons.
  root.classList.add('titlebar')

  const leftCluster = el('div', { class: 'titlebar-left' })
  const workspaceLabel = el('span', { class: 'workspace-name-label' }, 'No folder')
  const workspaceName = el(
    'button',
    { type: 'button', class: 'workspace-name', 'aria-haspopup': 'menu' },
    workspaceLabel,
    chevronDownIcon('ui-icon ui-icon-sm ui-picker-chevron workspace-name-chevron'),
  )
  workspaceName.addEventListener('click', (event) => {
    if (workspaceName.disabled || contextMenuClosedByPressOn(workspaceName)) return
    const rect = workspaceName.getBoundingClientRect()
    const { projects, activeProjectId } = store.getState()
    showContextMenu(
      rect.left,
      rect.bottom + 4,
      projects.map((project) => ({
        label: projectDisplayName(project),
        checked: project.id === activeProjectId,
        disabled: project.missing === true,
        onSelect: (): void => {
          setSidebarProjectFilter(store, api, project.id)
        },
      })),
    )
    if (event.detail === 0) {
      document.querySelector<HTMLButtonElement>('.context-menu-item.is-checked')?.focus()
    }
  })
  const sshTarget = el('span', { class: 'workspace-ssh-target', hidden: true })
  const workspaceBranch = el('span', { class: 'workspace-branch', hidden: true })
  // Hides or shows the projects sidebar (Cmd/Ctrl+B). Sits right after the
  // traffic lights, where the sidebar's own edge used to be.
  const sidebarBtn = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost titlebar-sidebar-btn',
      'aria-label': 'Toggle sidebar',
    },
    outlineIcon(
      'sidebar',
      ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M9 4v16'],
      'titlebar-btn-icon',
    ),
  )
  sidebarBtn.addEventListener('click', () => {
    toggleProjectsPane(store)
  })
  function syncSidebar(): void {
    const open = store.getState().projectsPaneOpen
    document.getElementById('body')?.classList.toggle(PROJECTS_COLLAPSED_CLASS, !open)
    sidebarBtn.setAttribute('aria-pressed', String(open))
    const chord = isMacPlatform() ? '⌘B' : 'Ctrl+B'
    setTooltip(sidebarBtn, `${open ? 'Hide' : 'Show'} sidebar (${chord})`)
  }
  syncSidebar()
  leftCluster.append(sidebarBtn, workspaceName, sshTarget, workspaceBranch)

  const dragRegion = el('div', { class: 'titlebar-drag' })
  // Opening projects lives in the projects panel; the titlebar only toggles the
  // file explorer and opens settings. In portrait/vertical chrome the secondary
  // mode buttons keep their icons but drop text labels (see titlebar.css); Panel
  // stays labeled so the primary affordance remains readable.
  const panelControls = mountPanelModeControls(store, api, {
    alwaysShowLabels: new Set(['explorer']),
    enableOverflow: true,
    overflowPlacement: 'below',
  })

  // "Open in editor" leads the right-hand cluster, sitting just before the Panel
  // button. mountOpenInEditor appends to its root, so move it ahead of filesBtn.
  const openInEditor = mountOpenInEditor(panelControls.element, store, api)
  const firstBtn = panelControls.element.firstElementChild
  if (firstBtn) {
    panelControls.element.insertBefore(openInEditor.element, firstBtn)
  }

  const runApp = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost titlebar-run-app',
      hidden: true,
      'aria-label': 'Run app',
    },
    playIcon(),
    'Run app',
  )
  runApp.addEventListener('click', () => {
    openAppRunDialog(store, api)
  })
  panelControls.element.prepend(runApp)
  let detectionGeneration = 0
  let detectedThread: string | null = null
  function syncRunApp(): void {
    const generation = ++detectionGeneration
    const { activeProjectId: projectId, activeThreadId: threadId } = store.getState()
    detectedThread = threadId
    runApp.hidden = true
    if (projectId)
      void api.appRun
        .detect({ projectId, ...(threadId ? { threadId } : {}) })
        .then((detected) => {
          if (generation === detectionGeneration) runApp.hidden = !detected
        })
        .catch(() => {})
  }
  syncRunApp()
  root.append(leftCluster, dragRegion, panelControls.element)
  const destroyCompactLayout = bindTitlebarCompactLayout(root, [leftCluster, panelControls.element])

  function syncProjectPicker(): void {
    const thread = getActiveThread(store)
    workspaceName.disabled =
      store.getState().projects.length === 0 || (thread !== undefined && !isBlankThread(thread))
    workspaceName.setAttribute(
      'aria-label',
      workspaceName.disabled
        ? workspaceName.textContent
        : `Project for new thread: ${workspaceName.textContent}`,
    )
  }

  function syncName(): void {
    const { workspaceRoot, activeProjectId, projects } = store.getState()
    const project = projects.find((p) => p.id === activeProjectId)
    workspaceLabel.textContent = project
      ? projectDisplayName(project)
      : workspaceRoot
        ? basename(workspaceRoot)
        : 'No folder'
    syncProjectPicker()
    // The project name truncates in narrow chrome; the tooltip carries its full path.
    setTooltip(workspaceName, workspaceRoot)
    if (project?.sshHost) {
      void api.sshWorkspace.listHosts().then((hosts) => {
        const host = hosts.find((h) => h.id === project.sshHost)
        if (!host) {
          sshTarget.hidden = true
          return
        }
        const target = host.user ? `${host.user}@${host.host}` : host.host
        sshTarget.hidden = false
        sshTarget.textContent = target
        setTooltip(sshTarget, `SSH workspace on ${target}`)
      })
    } else {
      sshTarget.hidden = true
      sshTarget.textContent = ''
    }
  }

  // Refresh local checkout metadata independently of remote PR observations.
  // A token prevents a slow response from repainting a different thread.
  let branchToken = 0
  let syncedThreadId = store.getState().activeThreadId
  function syncBranch(): void {
    syncedThreadId = store.getState().activeThreadId
    const token = ++branchToken
    const rootPath = store.getState().workspaceRoot
    const owner = getActiveThreadOwner(store)
    if (!rootPath || !owner) {
      workspaceBranch.hidden = true
      workspaceBranch.textContent = ''
      return
    }
    void api.git.currentBranch(owner.projectId, owner.threadId).then(
      (branch) => {
        if (token !== branchToken) return
        workspaceBranch.hidden = !branch
        workspaceBranch.textContent = branch ?? ''
        setTooltip(workspaceBranch, branch ? `On branch ${branch}` : null)
      },
      () => {
        if (token !== branchToken) return
        workspaceBranch.hidden = true
        workspaceBranch.textContent = ''
      },
    )
  }

  let branchTimer: ReturnType<typeof setTimeout> | null = null
  function syncBranchNow(): void {
    if (branchTimer) {
      clearTimeout(branchTimer)
      branchTimer = null
    }
    syncBranch()
  }

  function scheduleBranchSync(): void {
    if (branchTimer) clearTimeout(branchTimer)
    branchTimer = setTimeout(() => {
      branchTimer = null
      syncBranch()
    }, 500)
  }

  // Titlebar mounts before persisted projects restore on boot; sync on mount
  // for the no-project case, then again when restoreProject emits workspace_changed.
  syncName()
  syncBranch()
  const unsubs = [
    store.on('projects_pane_changed', syncSidebar),
    store.on('workspace_changed', () => {
      syncName()
      syncBranchNow()
      syncRunApp()
    }),
    store.on('projects_changed', syncName),
    store.on('message_added', syncProjectPicker),
    store.on('thread_status_changed', syncProjectPicker),
    store.on('threads_changed', () => {
      syncProjectPicker()
      if (store.getState().activeThreadId !== syncedThreadId) {
        syncBranchNow()
        return
      }
      scheduleBranchSync()
    }),
    store.on('threads_changed', () => {
      if (store.getState().activeThreadId !== detectedThread) syncRunApp()
    }),
    store.on('thread_checkout_changed', syncRunApp),
    store.on('message_done', syncRunApp),
    store.on('git_branch_changed', scheduleBranchSync),
    api.fs.onChanged(scheduleBranchSync),
    api.git.onWorkingTreeChanged(scheduleBranchSync),
  ]

  return () => {
    if (branchTimer) clearTimeout(branchTimer)
    detectionGeneration++
    openInEditor.destroy()
    panelControls.destroy()
    destroyCompactLayout()
    unsubs.forEach((u) => {
      u()
    })
  }
}
