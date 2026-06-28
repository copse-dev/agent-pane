import './styles/tokens.css'
import './styles/global.css'
import './styles/themes.css'

import { createStore } from '@shared/store/store.ts'
import { openNewThread, switchThread, getActiveThread } from '@shared/store/thread-helpers.ts'
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
import { mountPrPane } from './views/pr-pane.ts'
import { mountBrowserPane } from './views/browser-pane.ts'
import {
  mountSettingsDialog,
  openSettingsDialog,
  isSettingsDialogOpen,
  closeSettingsDialog,
} from './views/settings-dialog.ts'
import {
  mountOnboardingDialog,
  openOnboardingDialog,
  shouldShowOnboarding,
} from './views/onboarding-dialog.ts'
import { mountApprovalDialog } from './views/approval-dialog.ts'
import {
  mountFileSearchDialog,
  openFileSearchDialog,
  closeFileSearchDialog,
  isFileSearchDialogOpen,
} from './views/file-search-dialog.ts'
import { startAgentController } from './controller/agent.ts'
import { loadProjects, attachAutosave } from './controller/persistence.ts'
import {
  addProjectFromPath,
  attachProjectThreadCache,
  restoreProject,
} from './controller/projects.ts'
import {
  openRightPanelWithWorkspace,
  toggleFilesPaneWithWorkspace,
  syncFilesPaneDom,
  openCanvasArtefact,
} from './controller/panels.ts'
import { loadMonaco } from './monaco/setup.ts'
import { mountPaneResizers, parseSavedLayout } from './views/pane-resizer.ts'
import { bindChatComposerLayout } from './views/chat-layout.ts'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { registerPanelKeyboardShortcuts } from './keyboard-shortcuts.ts'
import { showErrorToast } from './views/toast.ts'
import { mountPortraitRightPanelLayout } from './views/portrait-right-panel-layout.ts'

const store = createStore()
const api = window.api

// Catch-all for IPC/promise failures that would otherwise vanish silently
// (many call sites dispatch with `void api.…()`). Surface them to the user.
window.addEventListener('unhandledrejection', (event) => {
  // Monaco throws when diff compute races model disposal (e.g. staged-diff accept).
  if (event.reason instanceof Error && event.reason.message === 'no diff result available') {
    event.preventDefault()
    return
  }
  showErrorToast('Unexpected error', event.reason)
})

let layoutMounted = false

async function boot() {
  mountSettingsDialog(store, api)
  mountOnboardingDialog(store, api)
  mountApprovalDialog(api)
  mountFileSearchDialog(store, api)

  // Load persisted user preferences before the main layout mounts.
  const savedModel = (await api.settings.get('model')) as string | null
  const savedLayout = await api.settings.get('layout')
  const savedAutoPortraitRightPanel = await api.settings.get('autoPortraitRightPanel')
  store.setState({
    settings: { model: savedModel ?? DEFAULT_APP_CHAT_MODEL },
    layout: parseSavedLayout(savedLayout),
    autoPortraitRightPanel:
      typeof savedAutoPortraitRightPanel === 'boolean' ? savedAutoPortraitRightPanel : true,
  })
  startAgentController(store, api)
  attachAutosave(store, api)
  attachProjectThreadCache(store)

  mountTitlebar(document.getElementById('titlebar')!, store, api)

  // File ▸ Settings… (Cmd+,) from the native menu opens the settings dialog.
  api.menu.onSettings(() => {
    if (!isSettingsDialogOpen()) openSettingsDialog()
  })

  // File ▸ New Thread (Cmd/Ctrl+N) opens a fresh composer, mirroring the
  // sidebar's "+" button. No-op until a workspace is open.
  api.menu.onNewThread(() => {
    if (!store.getState().workspaceRoot) return
    ensureLayout()
    openNewThread(store)
  })

  api.menu.onTogglePanel(() => {
    ensureLayout()
    toggleFilesPaneWithWorkspace(store, api)
  })
  api.menu.onShowExplorer(() => {
    ensureLayout()
    openRightPanelWithWorkspace(store, api, 'explorer')
  })
  api.menu.onShowTerminal(() => {
    ensureLayout()
    openRightPanelWithWorkspace(store, api, 'terminal')
  })
  api.menu.onShowChanges(() => {
    ensureLayout()
    openRightPanelWithWorkspace(store, api, 'changes')
  })
  api.menu.onShowBrowser(() => {
    ensureLayout()
    openRightPanelWithWorkspace(store, api, 'browser')
  })

  // MCP-UI canvas: an artefact from a (bundled or external) MCP server opens in
  // the Browser pane, rendered fully sandboxed.
  api.canvas.onArtefact((artefact) => {
    ensureLayout()
    openCanvasArtefact(store, artefact)
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

  if (await shouldShowOnboarding(api)) {
    openOnboardingDialog()
  }
}

function ensureLayout() {
  if (layoutMounted) return
  mountFullLayout()
  layoutMounted = true
  updateFilesPane()
  registerKeyboardShortcuts()
  registerPanelKeyboardShortcuts(store, api)
}

function mountFullLayout() {
  // Kick off the Monaco bundle immediately so it loads in parallel with the rest
  // of the layout, but mount the editor-backed panes only once it resolves — the
  // editor library is no longer part of the initial app.js.
  const monacoReady = loadMonaco()
  mountProjectsPane(document.getElementById('pane-projects')!, store, api)
  const inputRoot = document.getElementById('input-bar')!
  mountInputBar(inputRoot, store, api)
  mountConversation(document.getElementById('conversation')!, store, api)
  if (!inputRoot.querySelector('.prompt-input')) {
    throw new Error('Chat composer failed to mount (#input-bar missing .prompt-input)')
  }
  bindChatComposerLayout(store)
  mountFileTree(document.getElementById('file-tree-host')!, store, api)
  mountRightPanelTabs(document.getElementById('right-panel-tabs')!, store)
  mountTerminalsPane(
    document.getElementById('terminals-list-host')!,
    document.getElementById('terminals-viewer-host')!,
    store,
    api,
  )
  mountBrowserPane(
    document.getElementById('browser-tabs-host')!,
    document.getElementById('browser-viewer-host')!,
    store,
    api,
  )
  void monacoReady.then((monaco) => {
    mountGitChangesPane(
      document.getElementById('git-changes-host')!,
      document.getElementById('git-diff-viewer-host')!,
      store,
      api,
      monaco,
    )
    mountPrPane(
      document.getElementById('pr-list-host')!,
      document.getElementById('pr-viewer-host')!,
      store,
      api,
      monaco,
    )
    mountContextPanel(document.getElementById('file-viewer')!, store, api, monaco)
  })

  const body = document.getElementById('body')
  if (body) {
    mountPaneResizers(body, store, api)
    mountPortraitRightPanelLayout(body, store)
  }

  store.on('files_pane_changed', updateFilesPane)
  updateFilesPane()
}

// The right pane (explorer + file viewer) is hidden by default so chat is
// full width; it shows when filesPaneOpen is set (toggle, or auto on file open).
function updateFilesPane() {
  syncFilesPaneDom(store)
}

function registerKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey
    if (meta && e.key === 't') {
      e.preventDefault()
      openNewThread(store)
    }
    // Cmd/Ctrl+P opens the file quick-open palette (needs a workspace to search).
    if (meta && e.key === 'p') {
      e.preventDefault()
      if (store.getState().workspaceRoot) openFileSearchDialog()
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
      if (isFileSearchDialogOpen()) {
        closeFileSearchDialog()
        return
      }
      if (isSettingsDialogOpen()) {
        closeSettingsDialog()
        return
      }
      const thread = getActiveThread(store)
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
    void api.agent.clearHistory(activeThreadId)
    const index = threads.findIndex((t) => t.id === activeThreadId)
    const remaining = threads.filter((t) => t.id !== activeThreadId)
    const newActive = remaining[Math.min(index, remaining.length - 1)]?.id ?? null
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
