import './styles/tokens.css'
import './styles/global.css'
import './styles/themes.css'

import { createStore } from '@shared/store/store.ts'
import { createThread, switchThread } from '@shared/store/thread-helpers.ts'
import { mountWelcome } from './views/welcome.ts'
import { mountTitlebar } from './views/titlebar.ts'
import { mountProjectsPane } from './views/projects-pane.ts'
import { mountConversation } from './views/conversation.ts'
import { mountFileTree } from './views/file-tree.ts'
import { mountInputBar } from './views/input-bar.ts'
import { mountContextPanel } from './views/context-panel.ts'
import { mountRightPanelTabs } from './views/right-panel-tabs.ts'
import { mountTerminalsPane } from './views/terminals-pane.ts'
import { mountGitChangesPane } from './views/git-changes-pane.ts'
import {
  mountSettingsDialog,
  openSettingsDialog,
  isSettingsDialogOpen,
  closeSettingsDialog,
} from './views/settings-dialog.ts'
import { mountApprovalDialog } from './views/approval-dialog.ts'
import { startAgentController } from './controller/agent.ts'
import { loadProjects, attachAutosave } from './controller/persistence.ts'
import { addProjectFromPath, restoreProject } from './controller/projects.ts'
import { initMonaco } from './monaco/setup.ts'
import { mountPaneResizers, parseSavedLayout } from './views/pane-resizer.ts'

const store = createStore()
const api = window.api

let layoutMounted = false

async function boot() {
  mountSettingsDialog(store, api)
  mountApprovalDialog(api)

  // Load persisted user preferences before the main layout mounts.
  const savedModel = (await api.settings.get('model')) as string | null
  const savedLayout = await api.settings.get('layout')
  store.setState({
    settings: { model: savedModel ?? 'claude-sonnet-4-6' },
    layout: parseSavedLayout(savedLayout),
  })
  startAgentController(store, api)
  attachAutosave(store, api)

  mountTitlebar(document.getElementById('titlebar')!, store, api)

  // File ▸ Settings… (Cmd+,) from the native menu opens the settings dialog.
  api.menu.onSettings(() => {
    if (!isSettingsDialogOpen()) openSettingsDialog()
  })

  // File ▸ Open Folder… registers the chosen folder as a project and switches.
  api.workspace.onOpened((root) => {
    void addProjectFromPath(store, api, root).then(ensureLayout)
  })

  const { projects, activeProjectId } = await loadProjects(api)
  store.setState({ projects, activeProjectId })

  if (projects.length > 0) {
    const active = projects.find((p) => p.id === activeProjectId) ?? projects[0]!
    await restoreProject(store, api, active.id)
    ensureLayout()
  } else {
    const unmountWelcome = mountWelcome(document.getElementById('welcome')!, store, api)
    const unsubWelcome = store.on('workspace_changed', () => {
      unsubWelcome()
      unmountWelcome()
      ensureLayout()
    })
  }
}

function ensureLayout() {
  if (layoutMounted) return
  layoutMounted = true
  mountFullLayout()
  registerKeyboardShortcuts()
  updateFilesPane()
}

function mountFullLayout() {
  const monaco = initMonaco()
  mountProjectsPane(document.getElementById('pane-projects')!, store, api)
  mountConversation(document.getElementById('conversation')!, store)
  mountInputBar(document.getElementById('input-bar')!, store, api)
  mountFileTree(document.getElementById('file-tree-host')!, store, api)
  mountRightPanelTabs(document.getElementById('right-panel-tabs')!, store)
  mountTerminalsPane(
    document.getElementById('terminals-list-host')!,
    document.getElementById('terminals-viewer-host')!,
    store,
    api,
  )
  mountGitChangesPane(
    document.getElementById('git-changes-host')!,
    document.getElementById('git-diff-viewer-host')!,
    store,
    api,
    monaco,
  )
  mountContextPanel(document.getElementById('file-viewer')!, store, api, monaco)

  const body = document.getElementById('body')
  if (body) mountPaneResizers(body, store, api)

  store.on('files_pane_changed', updateFilesPane)
}

// The right pane (explorer + file viewer) is hidden by default so chat is
// full width; it shows when filesPaneOpen is set (toggle, or auto on file open).
function updateFilesPane() {
  const pane = document.getElementById('pane-files')
  if (pane) pane.hidden = !store.getState().filesPaneOpen
}

function registerKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey
    if (meta && e.key === 't') {
      e.preventDefault()
      createThread(store)
    }
    // Cmd/Ctrl+O is handled by the native File ▸ Open Folder… menu accelerator.
    if (meta && e.key === ',') {
      e.preventDefault()
      openSettingsDialog()
    }
    if (meta && e.key === 'w') {
      e.preventDefault()
      confirmDeleteThread()
    }
    if (e.key === 'Escape') {
      if (isSettingsDialogOpen()) {
        closeSettingsDialog()
        return
      }
      const thread = store.getState().threads.find((t) => t.id === store.getState().activeThreadId)
      if (thread?.status === 'running') {
        const id = store.getState().activeThreadId
        if (id) void api.agent.abort(id)
      }
    }
    if (e.altKey && e.key === 'ArrowLeft') switchToPrevThread()
    if (e.altKey && e.key === 'ArrowRight') switchToNextThread()
  })
}

function confirmDeleteThread() {
  const { activeThreadId, threads } = store.getState()
  if (!activeThreadId || threads.length <= 1) return
  if (confirm('Delete this thread?')) {
    const remaining = threads.filter((t) => t.id !== activeThreadId)
    const newActive = remaining[remaining.length - 1]?.id ?? null
    store.setState({ threads: remaining, activeThreadId: newActive })
    store.emit('threads_changed')
  }
}

function switchToPrevThread() {
  const { threads, activeThreadId } = store.getState()
  const idx = threads.findIndex((t) => t.id === activeThreadId)
  if (idx > 0) switchThread(store, threads[idx - 1]!.id)
}

function switchToNextThread() {
  const { threads, activeThreadId } = store.getState()
  const idx = threads.findIndex((t) => t.id === activeThreadId)
  if (idx < threads.length - 1) switchThread(store, threads[idx + 1]!.id)
}

void boot()
