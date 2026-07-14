import { el } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { toggleRightPanelWithWorkspace } from '../controller/panels.ts'
import { mountOpenInEditor } from './open-in-editor.ts'

function basename(p: string): string {
  return p.split('/').pop() ?? p
}

function panelIcon(): SVGSVGElement {
  return outlineIcon(
    'panel',
    ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M9 4v16'],
    'titlebar-btn-icon',
  )
}

function terminalIcon(): SVGSVGElement {
  return outlineIcon('terminal', ['m7 8 4 4-4 4', 'M13 16h4'], 'titlebar-btn-icon')
}

function changesIcon(): SVGSVGElement {
  return outlineIcon(
    'changes',
    [
      'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M6 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M15 5H9a3 3 0 0 0-3 3v8',
      'M9 19h6a3 3 0 0 0 3-3V8',
    ],
    'titlebar-btn-icon',
  )
}

function browserIcon(): SVGSVGElement {
  return outlineIcon(
    'browser',
    [
      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
      'M2 12h20',
      'M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20Z',
    ],
    'titlebar-btn-icon',
  )
}

function prsIcon(): SVGSVGElement {
  return outlineIcon(
    'prs',
    [
      'M9 6a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z',
      'M6 9v12',
      'M21 18a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z',
      'M13 6h3a2 2 0 0 1 2 2v7',
    ],
    'titlebar-btn-icon',
  )
}

function memoriesIcon(): SVGSVGElement {
  return outlineIcon(
    'memories',
    [
      'M4 19.5A2.5 2.5 0 0 1 6.5 17H20',
      'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',
    ],
    'titlebar-btn-icon',
  )
}

function roadmapIcon(): SVGSVGElement {
  return outlineIcon(
    'roadmap',
    ['M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4Z', 'M8 2v16', 'M16 6v16'],
    'titlebar-btn-icon',
  )
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
  // file explorer and opens settings.
  const filesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Toggle right panel' },
    panelIcon(),
    'Panel',
  )
  const terminalBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open terminal' },
    terminalIcon(),
    'Terminal',
  )
  const changesBadge = el('span', { class: 'titlebar-btn-badge', hidden: true })
  const changesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open changes' },
    changesIcon(),
    'Changes',
    changesBadge,
  )
  const prsBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open pull requests' },
    prsIcon(),
    'PRs',
  )
  // The Memories button is gated on the experimental okfMemoriesEnabled setting;
  // it starts hidden and is revealed once the setting is read (and re-checked on
  // settings_changed), mirroring how the tools themselves are gated.
  const memoriesBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open memories', hidden: true },
    memoriesIcon(),
    'Memories',
  )
  // Likewise gated, on the experimental roadmapPlansEnabled setting.
  const roadmapBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open roadmap', hidden: true },
    roadmapIcon(),
    'Roadmap',
  )
  const browserBtn = el(
    'button',
    { class: 'titlebar-btn titlebar-text-btn', 'aria-label': 'Open browser' },
    browserIcon(),
    'Browser',
  )
  const panelControls = el(
    'div',
    { class: 'titlebar-panel-controls' },
    filesBtn,
    terminalBtn,
    changesBtn,
    prsBtn,
    memoriesBtn,
    roadmapBtn,
    browserBtn,
  )

  // "Open in editor" leads the right-hand cluster, sitting just before the Panel
  // button. mountOpenInEditor appends to its root, so move it ahead of filesBtn.
  const openInEditor = mountOpenInEditor(panelControls, store, api)
  panelControls.insertBefore(openInEditor.element, filesBtn)

  root.append(leftCluster, dragRegion, panelControls)

  filesBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, api, 'explorer')
    syncPanelBtns()
  })

  terminalBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, api, 'terminal')
    syncPanelBtns()
  })

  changesBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, api, 'changes')
    syncPanelBtns()
  })

  prsBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, api, 'prs')
    syncPanelBtns()
  })

  memoriesBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, api, 'memories')
    syncPanelBtns()
  })

  roadmapBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, api, 'roadmap')
    syncPanelBtns()
  })

  browserBtn.addEventListener('click', () => {
    toggleRightPanelWithWorkspace(store, api, 'browser')
    syncPanelBtns()
  })

  function syncPanelBtns(): void {
    const { filesPaneOpen, rightPanelMode } = store.getState()
    filesBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'explorer')
    terminalBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'terminal')
    changesBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'changes')
    prsBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'prs')
    memoriesBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'memories')
    roadmapBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'roadmap')
    browserBtn.classList.toggle('active', filesPaneOpen && rightPanelMode === 'browser')
  }

  // Reveal the Memories and Roadmap buttons only while their experimental
  // features are enabled. Read on mount and again whenever settings change so
  // toggling them in the dialog takes effect without a restart.
  function syncExperimentalBtns(): void {
    void api.settings.get('okfMemoriesEnabled').then((enabled) => {
      memoriesBtn.hidden = enabled !== true
    })
    void api.settings.get('roadmapPlansEnabled').then((enabled) => {
      roadmapBtn.hidden = enabled !== true
    })
  }

  // Surface the pending agent-proposed diff count on the Changes button so the
  // queue is visible without opening the panel.
  function syncChangesBadge(): void {
    const pending = store.getState().stagedDiffs.length
    changesBadge.hidden = pending === 0
    changesBadge.textContent = String(pending)
    changesBtn.classList.toggle('has-pending', pending > 0)
  }

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
        sshTarget.textContent = `⚡ ${target}`
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
    const root = store.getState().workspaceRoot
    if (!root) {
      workspaceBranch.hidden = true
      workspaceBranch.textContent = ''
      return
    }
    void api.git.branchStatus().then(
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
  syncPanelBtns()
  syncChangesBadge()
  syncExperimentalBtns()
  const unsubs = [
    store.on('workspace_changed', () => {
      syncName()
      syncBranch()
    }),
    store.on('projects_changed', syncName),
    store.on('git_branch_changed', syncBranch),
    api.fs.onChanged(scheduleBranchSync),
    store.on('files_pane_changed', syncPanelBtns),
    store.on('right_panel_mode_changed', syncPanelBtns),
    store.on('staged_diffs_changed', syncChangesBadge),
    store.on('settings_changed', syncExperimentalBtns),
  ]

  return () => {
    if (branchTimer) clearTimeout(branchTimer)
    openInEditor.destroy()
    unsubs.forEach((u) => {
      u()
    })
  }
}
