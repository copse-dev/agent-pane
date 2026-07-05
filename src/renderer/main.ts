import './styles/tokens.css'
// Shared markdown styling lives in the renderer package; agent-pane maps its
// theme tokens onto the sheet's `--sm-*` knobs (see the bridge in
// styles/global/conversation.css). Imported before global.css so app rules win
// ties. The `.streaming-markdown` scope class is added to each render sink.
import '@copse/streaming-markdown/styles/default.css'
import './styles/global.css'
import './styles/themes.css'
import './styles/global/popout.css'

import { createStore } from '@shared/store/store.ts'
import { openNewThread, switchThread, getActiveThread } from '@shared/store/thread-helpers.ts'
import { mountWelcome } from './views/welcome.ts'
import { mountTitlebar } from './views/titlebar.ts'
import { mountProjectsPane } from './views/projects-pane.ts'
import { mountConversation } from './views/conversation.ts'
import { mountFileTree } from './views/file-tree.ts'
import { mountInputBar } from './views/input-bar.ts'
import { mountContextPanel } from './views/context-panel.ts'
import { mountRightPanelLayout } from './views/right-panel-layout.ts'
import { mountTerminalsPane } from './views/terminals-pane.ts'
import { mountAgentTasks } from './views/agent-tasks.ts'
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
import { mountContextWarningBanner } from './views/context-warning-banner.ts'
import { mountApprovalDialog } from './views/approval-dialog.ts'
import { mountAskUserDialog } from './views/ask-user-dialog.ts'
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
  openRightPanel,
  openRightPanelWithWorkspace,
  toggleFilesPaneWithWorkspace,
  syncFilesPaneDom,
  openCanvasArtefact,
} from './controller/panels.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { loadMonaco } from './monaco/setup.ts'
import { mountPaneResizers, parseSavedLayout } from './views/pane-resizer.ts'
import { bindChatComposerLayout } from './views/chat-layout.ts'
import { DEFAULT_APP_CHAT_MODEL } from '@shared/lm-studio-defaults.ts'
import { registerPanelKeyboardShortcuts } from './keyboard-shortcuts.ts'
import { showErrorToast } from './views/toast.ts'
import { mountPortraitRightPanelLayout } from './views/portrait-right-panel-layout.ts'
import { isRightPanelPosition } from '@shared/types/state.ts'
import { installArtifactImagePolicy } from './markdown/artifact-image-policy.ts'
import { installSanitizerBackend } from './markdown/sanitizer-backend.ts'

// Inject host markdown policies into @copse/streaming-markdown before any view
// renders: turn remote-agent artifact <img> tags into inert placeholders that
// hydrateRemoteArtifactImages() resolves after sanitization. The sanitizer
// backend (DOMPurify) is loaded via a deferred dynamic import; boot() awaits it
// before the first render.
const sanitizerReady = installSanitizerBackend()
installArtifactImagePolicy()

const store = createStore()
const api = window.api

// A pane pop-out window loads this same renderer with `?popout=<mode>`. In that
// mode we boot the app normally (so the pane gets the real workspace/threads),
// but force the pane open and let popout.css hide the projects sidebar, chat,
// and titlebar so the detached window shows only that pane.
const POPOUT_MODES = new Set<RightPanelMode>(['explorer', 'terminal', 'changes', 'prs', 'browser'])
function getPopoutMode(): RightPanelMode | null {
  const raw = new URLSearchParams(window.location.search).get('popout')
  return raw && POPOUT_MODES.has(raw as RightPanelMode) ? (raw as RightPanelMode) : null
}
const popoutMode = getPopoutMode()
if (popoutMode) {
  document.documentElement.classList.add('is-popout')
  document.documentElement.setAttribute('data-popout-mode', popoutMode)
}

// The app shell ships these mount points in index.html; a missing one is a
// build/markup bug we want to surface loudly rather than silently no-op.
function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Required element #${id} not found`)
  return el
}

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

async function boot(): Promise<void> {
  // Sanitizer backend must be in place before any markdown sink renders.
  // Resolves instantly on the native path; only awaits a load if DOMPurify had
  // to be lazily pulled in.
  await sanitizerReady
  mountSettingsDialog(store, api)
  mountOnboardingDialog(store, api)
  mountApprovalDialog(api, store)
  mountAskUserDialog(api, store)
  mountFileSearchDialog(store, api)
  // Mounted after settings (it subscribes to the settings-close event to re-check).
  const contextWarningBanner = mountContextWarningBanner(api)

  // Load persisted user preferences before the main layout mounts.
  const savedModel = (await api.settings.get('model')) as string | null
  const savedLayout = await api.settings.get('layout')
  const savedAutoPortraitRightPanel = await api.settings.get('autoPortraitRightPanel')
  const savedRightPanelPosition = await api.settings.get('rightPanelPosition')
  store.setState({
    settings: { model: savedModel ?? DEFAULT_APP_CHAT_MODEL },
    layout: parseSavedLayout(savedLayout),
    autoPortraitRightPanel:
      typeof savedAutoPortraitRightPanel === 'boolean' ? savedAutoPortraitRightPanel : true,
    rightPanelPosition: isRightPanelPosition(savedRightPanelPosition)
      ? savedRightPanelPosition
      : 'auto',
  })
  // A pop-out window is a secondary view of the same workspace; let the main
  // window own the agent loop and config autosave so the two don't race.
  if (!popoutMode) {
    startAgentController(store, api)
    attachAutosave(store, api)
  }
  attachProjectThreadCache(store)

  mountTitlebar(requireElement('titlebar'), store, api)

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

  const [firstProject] = projects
  if (firstProject) {
    const active = projects.find((p) => p.id === activeProjectId) ?? firstProject
    await restoreProject(store, api, active.id)
    ensureLayout()
  } else {
    const unmountWelcome = mountWelcome(requireElement('welcome'), store, api)
    const unsubWelcome = store.on('workspace_changed', () => {
      unsubWelcome()
      unmountWelcome()
      ensureLayout()
    })
  }

  // In a pop-out window, force the detached pane open once the workspace is
  // restored; popout.css collapses everything else to a single-pane window.
  if (popoutMode && store.getState().workspaceRoot) {
    ensureLayout()
    openRightPanel(store, popoutMode)
    return
  }

  if (await shouldShowOnboarding(api)) {
    openOnboardingDialog()
  } else {
    // Onboarding walks the user through model setup, so only nudge established
    // users here: warn when no configured chat model has a usable context window
    // (e.g. LM Studio reloaded everything at a tiny default after a reboot).
    void contextWarningBanner.refresh()
  }
}

function ensureLayout(): void {
  if (layoutMounted) return
  mountFullLayout()
  layoutMounted = true
  updateFilesPane()
  registerKeyboardShortcuts()
  registerPanelKeyboardShortcuts(store, api)
}

function mountFullLayout(): void {
  // Kick off the Monaco bundle immediately so it loads in parallel with the rest
  // of the layout, but mount the editor-backed panes only once it resolves — the
  // editor library is no longer part of the initial app.js.
  const monacoReady = loadMonaco()
  mountProjectsPane(requireElement('pane-projects'), store, api)
  const inputRoot = requireElement('input-bar')
  mountInputBar(inputRoot, store, api)
  mountConversation(requireElement('conversation'), store, api)
  if (!inputRoot.querySelector('.prompt-input')) {
    throw new Error('Chat composer failed to mount (#input-bar missing .prompt-input)')
  }
  bindChatComposerLayout(store)
  mountFileTree(requireElement('file-tree-host'), store, api)
  mountRightPanelLayout(store)
  mountTerminalsPane(
    requireElement('terminals-list-host'),
    requireElement('terminals-viewer-host'),
    store,
    api,
  )
  mountAgentTasks(
    requireElement('terminals-list-host'),
    requireElement('agent-tasks-host'),
    store,
    api,
  )
  mountBrowserPane(
    requireElement('browser-tabs-host'),
    requireElement('browser-viewer-host'),
    store,
    api,
  )
  void monacoReady.then((monaco) => {
    mountGitChangesPane(
      requireElement('git-changes-host'),
      requireElement('git-diff-viewer-host'),
      store,
      api,
      monaco,
    )
    mountPrPane(
      requireElement('pr-list-host'),
      requireElement('pr-viewer-host'),
      store,
      api,
      monaco,
    )
    mountContextPanel(requireElement('file-viewer'), store, api, monaco)
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
function updateFilesPane(): void {
  syncFilesPaneDom(store)
}

function registerKeyboardShortcuts(): void {
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

function confirmDeleteThread(): void {
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

function switchToPrevThread(): void {
  const { threads, activeThreadId } = store.getState()
  const idx = threads.findIndex((t) => t.id === activeThreadId)
  const prev = idx > 0 ? threads[idx - 1] : undefined
  if (prev) switchThread(store, prev.id)
}

function switchToNextThread(): void {
  const { threads, activeThreadId } = store.getState()
  const idx = threads.findIndex((t) => t.id === activeThreadId)
  const next = idx >= 0 && idx < threads.length - 1 ? threads[idx + 1] : undefined
  if (next) switchThread(store, next.id)
}

void boot()
