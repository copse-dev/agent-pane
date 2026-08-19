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
import {
  nextThreadId,
  openNewThread,
  prevThreadId,
  switchThread,
} from '@shared/store/thread-helpers.ts'
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
import { mountSupervisedTasks } from './views/supervised-tasks.ts'
import { mountGitChangesPane } from './views/git-changes-pane.ts'
import { mountPrPane } from './views/pr-pane.ts'
import { mountMemoriesPane } from './views/memories-pane.ts'
import { mountPortsSection } from './views/ports-section.ts'
import { mountRoadmapPane } from './views/roadmap-pane.ts'
import { mountBrowserPane } from './views/browser-pane.ts'
import { mountVncPane } from './views/vnc-pane.ts'
import {
  mountSettingsDialog,
  openSettingsDialog,
  isSettingsDialogOpen,
  closeSettingsDialog,
  applyUiAccent,
  applyUiTint,
  isUiTintStrength,
  DEFAULT_TINT_COLOR,
  DEFAULT_TINT_STRENGTH,
  DEFAULT_ACCENT_COLOR,
} from './views/settings-dialog.ts'
import { resolveTheme, applyThemeToDocument, watchSystemTheme } from './dom/theme.ts'
import {
  restoreUiScale,
  bumpUiScale,
  resetUiScale,
  attachUiScalePinchGestures,
} from './dom/ui-scale.ts'
import {
  mountOnboardingDialog,
  openOnboardingDialog,
  shouldShowOnboarding,
} from './views/onboarding-dialog.ts'
import { mountSshStatusBanner } from './views/ssh-status-banner.ts'
import { mountApprovalDialog } from './views/approval-dialog.ts'
import { mountAskUserDialog } from './views/ask-user-dialog.ts'
import { mountSshPromptDialog } from './views/ssh-prompt-dialog.ts'
import { mountUpdatePromptDialog } from './views/update-prompt-dialog.ts'
import { registerUiKit } from './ui/index.ts'
import { installTooltips } from './dom/tooltip.ts'
import { mountConfirmDialog, showConfirmDialog } from './views/confirm-dialog.ts'
import { mountCloseConfirm } from './views/close-confirm.ts'

registerUiKit()
import {
  mountFileSearchDialog,
  openFileSearchDialog,
  closeFileSearchDialog,
  isFileSearchDialogOpen,
} from './views/file-search-dialog.ts'
import {
  mountCommandPalette,
  openCommandPalette,
  closeCommandPalette,
  isCommandPaletteOpen,
} from './views/command-palette.ts'
import {
  mountConversationSearch,
  openConversationSearch,
  closeConversationSearch,
  isConversationSearchOpen,
} from './views/conversation-search.ts'
import {
  mountKeyboardShortcutsDialog,
  openKeyboardShortcutsDialog,
  closeKeyboardShortcutsDialog,
  isKeyboardShortcutsDialogOpen,
} from './views/keyboard-shortcuts-dialog.ts'
import { startAgentController } from './controller/agent.ts'
import { attachDiffState } from './controller/diff-state.ts'
import { attachAutomationController } from './controller/automations.ts'
import { attachBestValueDefaultResolver } from './controller/best-value-default.ts'
import { loadProjects, attachAutosave } from './controller/persistence.ts'
import { startExternalCursorAgentSync } from './controller/external-cursor-agent-sync.ts'
import { loadStartupSettings } from './controller/startup-settings.ts'
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
import {
  registerPanelKeyboardShortcuts,
  matchFindInChatShortcut,
  matchUiScaleShortcut,
  matchCommandPaletteShortcut,
} from './keyboard-shortcuts.ts'
import { showErrorToast } from './views/toast.ts'
import { mountPortraitRightPanelLayout } from './views/portrait-right-panel-layout.ts'
import { mountPopoutPanelBar } from './popout/popout-panel-bar.ts'
import { applyPopoutSeed } from './popout/pane-popout-seed.ts'
import {
  isRightPanelPosition,
  isThemePreference,
  DEFAULT_THEME_PREFERENCE,
} from '@shared/types/state.ts'
import { installArtifactImagePolicy } from './markdown/artifact-image-policy.ts'
import { installSanitizerBackend } from './markdown/sanitizer-backend.ts'
import { installHighlighterBackend } from './markdown/highlighter-backend.ts'
import { installAppLinkDecorator } from './markdown/link-decorator.ts'

// Inject host markdown policies into @copse/streaming-markdown before any view
// renders: turn remote-agent artifact <img> tags into inert placeholders that
// hydrateRemoteArtifactImages() resolves after sanitization. The sanitizer
// backend resolves the native Sanitizer API synchronously (Electron) or lazily
// loads DOMPurify where it is absent; boot() awaits it before the first render.
const sanitizerReady = installSanitizerBackend()
// Highlighting is a pluggable backend too (streaming-markdown #37): without it,
// fenced code renders as plain text with no `hljs-*` token spans. Lazily load the
// highlight.js backend (code-split, off the eager path) and register it; boot()
// awaits it before the first render.
const highlighterReady = installHighlighterBackend()
installArtifactImagePolicy()
// streaming-markdown 0.10.0 ships a neutral default link decorator (#112); opt
// back into the workspace/browser `data-*` link hooks our click handlers bind.
installAppLinkDecorator()

const store = createStore()
const api = window.api

// A pane pop-out window loads this same renderer with `?popout=<mode>`. In that
// mode we boot the app normally (so the pane gets the real workspace/threads),
// but force the pane open and let popout.css hide the projects sidebar, chat,
// and titlebar so the detached window shows only that pane.
const POPOUT_MODES = new Set<RightPanelMode>([
  'explorer',
  'terminal',
  'changes',
  'prs',
  'browser',
  'memories',
  'roadmap',
  'vnc',
])
function isPopoutMode(value: string | null): value is RightPanelMode {
  return value !== null && [...POPOUT_MODES].some((mode) => mode === value)
}
function getPopoutMode(): RightPanelMode | null {
  const raw = new URLSearchParams(window.location.search).get('popout')
  return isPopoutMode(raw) ? raw : null
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
  // Monaco throws when diff compute races model disposal (e.g. staged-diff accept)
  // or when hideUnchangedRegions refresh cancels an in-flight compute.
  if (
    event.reason instanceof Error &&
    (event.reason.message === 'no diff result available' || event.reason.message === 'Canceled')
  ) {
    event.preventDefault()
    return
  }
  showErrorToast('Unexpected error', event.reason)
})

let layoutMounted = false
let unmountPopoutPanelBar: (() => void) | null = null
let handleStopShortcut: ((key: 'Escape' | 'Enter') => boolean) | null = null

async function boot(): Promise<void> {
  // Sanitizer and highlighter backends must be in place before any markdown sink
  // renders. The sanitizer resolves instantly on the native path (only awaits a
  // load if DOMPurify had to be lazily pulled in); the highlighter awaits its
  // code-split highlight.js chunk so code blocks get their hljs token spans.
  await Promise.all([sanitizerReady, highlighterReady])
  // Delegated, so it covers every `[data-tooltip]` mounted later — including
  // pane contents that render long after boot.
  installTooltips()
  mountSettingsDialog(store, api)
  mountOnboardingDialog(store, api)
  mountApprovalDialog(api, store)
  mountAskUserDialog(api, store)
  mountSshPromptDialog(api)
  mountUpdatePromptDialog(api)
  mountConfirmDialog()
  // Mounted after the confirm dialog it prompts through, so a close arriving
  // during boot has somewhere to render.
  mountCloseConfirm(api, store)
  mountFileSearchDialog(store, api)
  mountCommandPalette(store, api)
  mountKeyboardShortcutsDialog()
  mountSshStatusBanner(store, api)

  // Load persisted user preferences before the main layout mounts.
  const startupSettings = await loadStartupSettings(api.settings)
  const rawSavedModel = startupSettings.model
  const savedModel = typeof rawSavedModel === 'string' ? rawSavedModel : null
  const savedLayout = startupSettings.layout
  const savedAutoPortraitRightPanel = startupSettings.autoPortraitRightPanel
  const savedRightPanelPosition = startupSettings.rightPanelPosition
  const savedOpenLinksInBuiltInBrowser = startupSettings.openLinksInBuiltInBrowser
  const savedDeveloperMode = startupSettings.developerMode
  // Theme and editor font size persist too. Restore them here (the store
  // otherwise keeps its dark/14 defaults on every launch) and apply the theme to
  // the document root before the layout paints — panes read both from the store
  // as they mount below, so no post-mount re-theming is needed.
  const savedTheme = startupSettings.theme
  const themePreference = isThemePreference(savedTheme) ? savedTheme : DEFAULT_THEME_PREFERENCE
  // `system` resolves against the OS here; a watcher below keeps it live.
  const theme = resolveTheme(themePreference)
  const savedFontSize = startupSettings.fontSize
  const fontSize =
    typeof savedFontSize === 'number' && savedFontSize >= 8 && savedFontSize <= 32
      ? savedFontSize
      : store.getState().fontSize
  // Interface scale drives CSS --ui-scale (spacing + type tokens). Apply before
  // paint so the shell does not flash at 100% then jump.
  const uiScale = restoreUiScale(startupSettings.uiScale)
  applyThemeToDocument(theme)
  // When the preference is `system`, follow OS light/dark flips live so the app
  // re-themes without a relaunch. Reads the preference from the store each time,
  // so switching to a pinned theme in Settings stops the OS from overriding it.
  watchSystemTheme(
    () => store.getState().themePreference,
    (nextTheme) => {
      applyThemeToDocument(nextTheme)
      store.setState({ theme: nextTheme })
      store.emit('theme_changed', nextTheme)
    },
  )
  // Restore the interaction accent and whole-app tint before the layout paints
  // so controls and surfaces do not flash their defaults before shifting.
  const savedAccentColor = startupSettings.uiAccentColor
  applyUiAccent(typeof savedAccentColor === 'string' ? savedAccentColor : DEFAULT_ACCENT_COLOR)
  const savedTintColor = startupSettings.uiTintColor
  const savedTintStrength = startupSettings.uiTintStrength
  applyUiTint(
    typeof savedTintColor === 'string' ? savedTintColor : DEFAULT_TINT_COLOR,
    isUiTintStrength(savedTintStrength) ? savedTintStrength : DEFAULT_TINT_STRENGTH,
  )
  store.setState({
    settings: { model: savedModel ?? DEFAULT_APP_CHAT_MODEL },
    layout: parseSavedLayout(savedLayout),
    theme,
    themePreference,
    fontSize,
    uiScale,
    autoPortraitRightPanel:
      typeof savedAutoPortraitRightPanel === 'boolean' ? savedAutoPortraitRightPanel : true,
    rightPanelPosition: isRightPanelPosition(savedRightPanelPosition)
      ? savedRightPanelPosition
      : 'auto',
    openLinksInBuiltInBrowser:
      typeof savedOpenLinksInBuiltInBrowser === 'boolean' ? savedOpenLinksInBuiltInBrowser : true,
    developerMode: typeof savedDeveloperMode === 'boolean' ? savedDeveloperMode : false,
  })
  // Reflect the "open links in built-in browser" choice onto the document root so
  // CSS can flag external links with an icon (and re-sync when Settings saves).
  const applyExternalLinkMarks = (): void => {
    document.documentElement.classList.toggle(
      'mark-external-links',
      !store.getState().openLinksInBuiltInBrowser,
    )
  }
  applyExternalLinkMarks()
  store.on('settings_changed', applyExternalLinkMarks)
  // A pop-out window is a secondary view of the same workspace; let the main
  // window own the agent loop and config autosave so the two don't race.
  if (!popoutMode) {
    startAgentController(store, api)
    attachAutosave(store, api)
    attachBestValueDefaultResolver(store, api)
    attachAutomationController(store, api)
    // Outside Cursor cloud agents for the open project — first tick after one
    // interval, never on editor open.
    startExternalCursorAgentSync(store, api)
  } else {
    // …but the diff queue is shared workspace state, not agent ownership. Without
    // this the detached Changes pane has an empty `stagedDiffs` forever and never
    // renders its "Proposed" section (#1704). `revealOnShowDiff` stays off: a
    // pop-out is already pinned to one pane, so there is nothing to reveal.
    attachDiffState(store, api, { revealOnShowDiff: false })
  }
  attachProjectThreadCache(store)

  mountTitlebar(requireElement('titlebar'), store, api)

  // File ▸ Settings… (Cmd+,) from the native menu opens the settings dialog.
  api.menu.onSettings(() => {
    if (!isSettingsDialogOpen()) openSettingsDialog()
  })

  // File ▸ New Thread (Cmd/Ctrl+N) opens a fresh composer, mirroring the
  // sidebar's New project button. No-op until a workspace is open.
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

  // View ▸ Focus Address Bar (Cmd/Ctrl+L). Opens the Browser pane first so the
  // shortcut works from anywhere, then hands off to browser-pane.ts, which owns
  // the tabs and therefore knows which address bar is the active one.
  api.menu.onFocusBrowserUrlBar(() => {
    ensureLayout()
    openRightPanelWithWorkspace(store, api, 'browser')
    store.emit('browser_url_bar_focus_requested')
  })

  // Help ▸ Keyboard Shortcuts (Cmd/Ctrl+/) opens the shortcut cheat sheet. Unlike
  // the panel items it needs no workspace, so it works from the welcome screen too.
  api.menu.onKeyboardShortcuts(() => {
    openKeyboardShortcutsDialog()
  })

  // View ▸ Zoom In/Out/Actual Size — CSS --ui-scale (not Chromium page zoom).
  api.menu.onUiScaleZoomIn(() => {
    void bumpUiScale(store, api, 1)
  })
  api.menu.onUiScaleZoomOut(() => {
    void bumpUiScale(store, api, -1)
  })
  api.menu.onUiScaleReset(() => {
    void resetUiScale(store, api)
  })
  attachUiScalePinchGestures(store, api)

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
    // Mount the panel immediately rather than waiting for restoreProject() to
    // finish — a large project's thread load (or a slow SSH connect) can take a
    // while, and every mounted pane already renders its own empty/loading state
    // and updates reactively once workspace_changed/threads_changed fire below.
    ensureLayout()
    await restoreProject(store, api, active.id)
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
    await activatePopoutPane(popoutMode)
    return
  }

  if (await shouldShowOnboarding(api)) openOnboardingDialog()
}

function ensureLayout(): void {
  if (layoutMounted) return
  mountFullLayout()
  layoutMounted = true
  updateFilesPane()
  registerKeyboardShortcuts()
  registerPanelKeyboardShortcuts(store, api)
  if (popoutMode) {
    const paneFiles = document.getElementById('pane-files')
    if (paneFiles && !unmountPopoutPanelBar) {
      unmountPopoutPanelBar = mountPopoutPanelBar(paneFiles, store, api)
    }
  }
}

// A pop-out window hosts exactly one detached pane. Opening it also replays the
// snapshot ("seed") the parent window stashed, so the pane arrives on the same
// selection the user was looking at rather than an empty default.
async function activatePopoutPane(mode: RightPanelMode): Promise<void> {
  ensureLayout()
  openRightPanel(store, mode)
  document.documentElement.setAttribute('data-popout-mode', mode)
  const seed = await api.panes.takePopoutSeed(mode)
  await applyPopoutSeed(mode, seed, store)
}

if (popoutMode) {
  api.panes.onSwitchMode((mode) => {
    if (!POPOUT_MODES.has(mode)) return
    void activatePopoutPane(mode)
  })
}

function mountFullLayout(): void {
  // Kick off the Monaco bundle immediately so it loads in parallel with the rest
  // of the layout, but mount the editor-backed panes only once it resolves — the
  // editor library is no longer part of the initial app.js.
  const monacoReady = loadMonaco()
  mountProjectsPane(requireElement('pane-projects'), store, api)
  const inputRoot = requireElement('input-bar')
  const inputBar = mountInputBar(inputRoot, store, api, {
    portraitPanelHost: requireElement('pane-chat'),
  })
  handleStopShortcut = inputBar.handleStopShortcut
  const conversationRoot = requireElement('conversation')
  mountConversation(conversationRoot, store, api)
  mountConversationSearch(conversationRoot)
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
  mountSupervisedTasks(requireElement('terminals-list-host'), store, api)
  mountPortsSection(requireElement('terminals-list-host'), store, api)
  mountBrowserPane(
    requireElement('browser-tabs-host'),
    requireElement('browser-viewer-host'),
    store,
    api,
  )
  mountVncPane(requireElement('vnc-controls-host'), requireElement('vnc-viewer-host'), store, api)
  mountMemoriesPane(
    requireElement('memories-host'),
    requireElement('memories-viewer-host'),
    store,
    api,
  )
  mountRoadmapPane(
    requireElement('roadmap-host'),
    requireElement('roadmap-viewer-host'),
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
    mountPortraitRightPanelLayout(body, store)
    // Mount after portrait layout so its files-pane listener has already
    // selected stacked vs side-by-side geometry before widths are reconciled.
    mountPaneResizers(body, store, api)
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
    // Cmd/Ctrl+Shift+K opens the command palette (threads, projects, panels,
    // commands). Works without a workspace so its commands stay reachable.
    if (matchCommandPaletteShortcut(e)) {
      e.preventDefault()
      openCommandPalette()
    }
    // Cmd/Ctrl+F opens the in-conversation find bar (find-in-page for the chat).
    // Skipped while a modal dialog owns the screen so it can't open behind it.
    if (matchFindInChatShortcut(e)) {
      if (
        isFileSearchDialogOpen() ||
        isCommandPaletteOpen() ||
        isSettingsDialogOpen() ||
        isKeyboardShortcutsDialogOpen()
      )
        return
      e.preventDefault()
      openConversationSearch()
    }
    // Cmd/Ctrl+O is handled by the native File ▸ Open Folder… menu accelerator.
    if (meta && e.key === ',') {
      e.preventDefault()
      openSettingsDialog()
    }
    // Cmd/Ctrl+/ opens the keyboard-shortcut cheat sheet (Help ▸ Keyboard Shortcuts).
    if (meta && e.key === '/') {
      e.preventDefault()
      openKeyboardShortcutsDialog()
    }
    // Cmd/Ctrl+=/−/0 adjust the CSS --ui-scale interface size. Bound here (not
    // only via the View menu) because the old Chromium zoom roles were silent
    // in this frameless shell — same pattern as Settings (Cmd/,).
    const uiScaleAction = matchUiScaleShortcut(e)
    if (uiScaleAction) {
      e.preventDefault()
      if (uiScaleAction === 'reset') void resetUiScale(store, api)
      else void bumpUiScale(store, api, uiScaleAction === 'in' ? 1 : -1)
    }
    if (meta && e.key === 'w') {
      e.preventDefault()
      void confirmDeleteThread()
    }
    if (e.key === 'Escape') {
      if (isCommandPaletteOpen()) {
        closeCommandPalette()
        return
      }
      if (isKeyboardShortcutsDialogOpen()) {
        closeKeyboardShortcutsDialog()
        return
      }
      if (isConversationSearchOpen()) {
        closeConversationSearch()
        return
      }
      if (isFileSearchDialogOpen()) {
        closeFileSearchDialog()
        return
      }
      if (isSettingsDialogOpen()) {
        closeSettingsDialog()
        return
      }
      if (handleStopShortcut?.('Escape')) e.preventDefault()
    }
    if (e.key === 'Enter' && handleStopShortcut?.('Enter')) {
      e.preventDefault()
    }
    // Ctrl+Tab / Ctrl+Shift+Tab cycle threads, matching browser and other
    // agent apps. Ctrl specifically (not Cmd), so it composes with macOS's
    // Cmd+Tab app switcher.
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) switchToPrevThread()
      else switchToNextThread()
    }
  })
}

async function confirmDeleteThread(): Promise<void> {
  const { activeThreadId, activeProjectId, threads } = store.getState()
  if (!activeThreadId || !activeProjectId || threads.length <= 1) return
  if (
    !(await showConfirmDialog({
      message: 'Delete this thread?',
      confirmLabel: 'Delete',
      danger: true,
    }))
  ) {
    return
  }
  void api.agent.clearHistory(activeProjectId, activeThreadId)
  const index = threads.findIndex((t) => t.id === activeThreadId)
  const remaining = threads.filter((t) => t.id !== activeThreadId)
  const newActive = remaining[Math.min(index, remaining.length - 1)]?.id ?? null
  store.setState({
    threads: remaining,
    activeThreadId: newActive,
    openFile: null,
    activeDiff: null,
    stagedDiffs: [],
  })
  store.emit('threads_changed')
  store.emit('panel_changed')
}

function switchToPrevThread(): void {
  const prev = prevThreadId(store)
  if (prev) switchThread(store, prev)
}

function switchToNextThread(): void {
  const next = nextThreadId(store)
  if (next) switchThread(store, next)
}

void boot()

// package.json marks .js as CommonJS. Keep this entry explicitly ESM so esbuild
// can propagate top-level await from dependencies such as noVNC 1.7.
export {}
