import { el } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { mountOpenInEditor } from './open-in-editor.ts'
import { mountPanelModeControls } from './panel-mode-controls.ts'
import { getActiveThreadOwner } from '../controller/active-thread-owner.ts'

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

export function mountTitlebar(root: HTMLElement, store: AppStore, api: ApiClient): () => void {
  // The structural #titlebar div needs the .titlebar class for its flex layout,
  // height, and traffic-light clearance to apply. Without it the controls
  // collapse and hide under the macOS window buttons.
  root.classList.add('titlebar')

  const leftCluster = el('div', { class: 'titlebar-left' })
  const workspaceName = el('span', { class: 'workspace-name' }, 'No folder')
  const sshTarget = el('span', { class: 'workspace-ssh-target', hidden: true })
  const workspaceBranch = el('span', { class: 'workspace-branch', hidden: true })
  leftCluster.append(workspaceName, sshTarget, workspaceBranch)

  const dragRegion = el('div', { class: 'titlebar-drag' })
  // Opening projects lives in the projects panel; the titlebar only toggles the
  // file explorer and opens settings. In portrait/vertical chrome the secondary
  // mode buttons keep their icons but drop text labels (see titlebar.css); Panel
  // stays labeled so the primary affordance remains readable.
  const panelControls = mountPanelModeControls(store, api, {
    alwaysShowLabels: new Set(['explorer']),
  })

  // "Open in editor" leads the right-hand cluster, sitting just before the Panel
  // button. mountOpenInEditor appends to its root, so move it ahead of filesBtn.
  const openInEditor = mountOpenInEditor(panelControls.element, store, api)
  const firstBtn = panelControls.element.firstElementChild
  if (firstBtn) {
    panelControls.element.insertBefore(openInEditor.element, firstBtn)
  }

  root.append(leftCluster, dragRegion, panelControls.element)

  function syncName(): void {
    const { workspaceRoot, activeProjectId, projects } = store.getState()
    const project = projects.find((p) => p.id === activeProjectId)
    workspaceName.textContent = workspaceRoot ? basename(workspaceRoot) : 'No folder'
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
        sshTarget.title = `SSH workspace on ${target}`
      })
    } else {
      sshTarget.hidden = true
      sshTarget.textContent = ''
    }
  }

  // The current checked-out branch of the active workspace. branchStatus() reads
  // the single active workspace root, so this tracks whatever is checked out now,
  // independent of which thread's branch is bound. A request token guards against
  // a slow response landing after the workspace has already changed.
  let branchToken = 0
  function syncBranch(): void {
    const token = ++branchToken
    const rootPath = store.getState().workspaceRoot
    const owner = getActiveThreadOwner(store)
    if (!rootPath || !owner) {
      workspaceBranch.hidden = true
      workspaceBranch.textContent = ''
      return
    }
    void api.git.branchStatus(owner.projectId, owner.threadId).then(
      (s) => {
        if (token !== branchToken) return
        const branch = s.currentBranch
        workspaceBranch.hidden = !branch
        workspaceBranch.textContent = branch ?? ''
        if (branch) workspaceBranch.title = `On branch ${branch}`
      },
      () => {
        if (token !== branchToken) return
        workspaceBranch.hidden = true
        workspaceBranch.textContent = ''
      },
    )
  }

  let branchTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleBranchSync(): void {
    if (branchTimer) clearTimeout(branchTimer)
    branchTimer = setTimeout(syncBranch, 500)
  }

  // Titlebar mounts before persisted projects restore on boot; sync on mount
  // for the no-project case, then again when restoreProject emits workspace_changed.
  syncName()
  syncBranch()
  const unsubs = [
    store.on('workspace_changed', () => {
      syncName()
      syncBranch()
    }),
    store.on('projects_changed', syncName),
    store.on('threads_changed', syncBranch),
    store.on('git_branch_changed', syncBranch),
    api.fs.onChanged(scheduleBranchSync),
  ]

  return () => {
    if (branchTimer) clearTimeout(branchTimer)
    openInEditor.destroy()
    panelControls.destroy()
    unsubs.forEach((u) => {
      u()
    })
  }
}
