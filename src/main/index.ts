import './app-init.ts' // MUST be first — sets app name/userData before electron-store builds
import {
  armPerfTrace,
  flushPerfTrace,
  perfDumpCounters,
  perfMark,
} from './services/diagnostics/perf-trace.ts'
import {
  installIpcPerfTracing,
  installRendererPerfChannel,
} from './services/diagnostics/perf-ipc.ts'

// DEBUG BRANCH (`COPSE_PERF=1` only, inert otherwise). Armed here, above every
// other import's side effects, for two reasons: it fixes the trace origin at the
// earliest moment main can observe, and it publishes `COPSE_PERF_ORIGIN` into
// the environment before any renderer process is forked, which is what lets
// renderer timestamps share an axis with main's.
armPerfTrace()
installIpcPerfTracing()

import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { attachWebContentsLockdown } from './windows/web-contents-lockdown.ts'
import {
  attachBrowserGuestWindowOpen,
  getAgentBrowserSession,
  getInAppBrowserSession,
  isBrowserWebContents,
} from './windows/browser-web-contents.ts'
import { attachBrowserGuestContextMenu } from './windows/browser-context-menu.ts'
import { applyAppIcon } from './app-icon.ts'
import type { LLMMessage, StreamChunk } from '@shared/types'
import {
  assertPrimaryMainWindow,
  createMainWindow,
  getFocusedMainWindow,
  getMainWindow,
} from './windows/create-main-window.ts'
import { setShellOutputSink } from './services/exec/shell-output-context.ts'
import { setSecretCipher } from './services/storage/secret-cipher.ts'
import { buildAppMenu } from './windows/app-menu.ts'
import { initAutoUpdate } from './services/auto-update.ts'
import { initUpdatePrompt } from './services/update-prompt.ts'
import {
  approveClose,
  deferQuitForCloseConfirmation,
  guardWindowClose,
  initCloseConfirm,
} from './services/close-confirm.ts'
import { checkToolAvailability } from './services/tool-availability.ts'
import {
  createRegistry,
  registerSkillTools,
  syncCiInvestigatorTools,
  syncGhTools,
} from './services/registry-bootstrap.ts'
import { getPluginService } from './services/plugins/plugin-service.ts'
import {
  loadMcpServers,
  shutdownMcpServers,
  getMcpServerStatuses,
} from './services/mcp/mcp-registry.ts'
import { loadCustomTools } from './services/mcp/custom-tools-registry.ts'
import { disposeAllAcpSessions } from './services/acp/acp-session-pool.ts'
import { initApproval } from './services/approval.ts'
import { initAskUser } from './services/ask-user.ts'
import { createElectronUserAlertSender } from './services/user-alerts-electron.ts'
import { setTerminalCommandLauncher } from './services/exec/terminal-launch.ts'
import { initSshPrompt } from './services/ssh-workspace/ssh-prompt.ts'
import { initSshAskpassServer } from './services/ssh-workspace/askpass.ts'
import { initSshWorkspaceIpc } from './services/ssh-workspace/ssh-workspace-ipc.ts'
import { initDiffQueue } from './services/diff-queue.ts'
import { initFsWatcher, closeAllWatchers } from './ipc/fs-watcher.ts'
import { stopWorkspaceIndexWatcher } from './services/search/workspace-index-watcher.ts'
import {
  reapOversizedGortexDaemon,
  reclaimBloatedGortexStore,
  stopGortexDaemon,
} from './services/search/semantic-index.ts'
import { initTerminal } from './ipc/terminal.ts'
import { initVnc } from './ipc/vnc.ts'
import { registerAllHandlers } from './ipc/register-handlers.ts'
import { initSkillsRegistry } from './services/skills/skills-registry.ts'
import { parseAgentRunPayload } from '@copse/agent/parse-agent-run-payload.ts'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import {
  abortAgent,
  listRunningThreadIds,
  retryPostTurnReview,
  retryModelComparison,
  suggestThreadTitle,
  suggestTerminalTitle,
  suggestCommandSummary,
  suggestToolTurnSummary,
  testLmStudio,
  listLmStudioModels,
  listLmStudioModelInfo,
  invalidateLmStudioModelsCache,
} from './services/agent-service.ts'
import type { RetryOptions } from './services/agent-service.ts'
import { resolveComparisonModelChoices } from './services/agent-service.ts'
import {
  listFreeOpenRouterModels,
  invalidateOpenRouterModelsCache,
} from './services/providers/openrouter-models.ts'
import { invalidateCursorCloudModelsCache } from './services/remote/cursor-cloud-models.ts'
import {
  detectLmStudio,
  downloadLmStudioModel,
  getLmStudioDownloadStatus,
} from './services/providers/lm-studio-setup.ts'
import { estimateContextBreakdown } from './services/context-estimate.ts'
import { suggestFollowUps } from './services/follow-up-service.ts'
import { clearAgentHistory } from './services/thread-store.ts'
import { AgentDispatcher } from './services/agent-dispatcher.ts'
import { setHookQueueMessageSender } from './services/hooks/hook-queue-channel.ts'
import { initProjectSandbox, shutdownProjectSandbox } from './project-sandbox/index.ts'
import { clearRemoteAgentSession } from './services/remote/remote-agent-client.ts'
import {
  setBrowserSessionPlatform,
  shutdownBrowserSession,
} from './services/browser/session-manager.ts'
import { shutdownStaticPreviewServers } from './services/browser/static-preview-server.ts'
import { drainWriteQueue } from './services/storage/write-queue.ts'
import {
  assertMainFrameSender,
  estimateContextPayloadSchema,
  followUpContextSchema,
  retryReviewPayloadSchema,
  lmStudioDetectSchema,
  lmStudioDownloadSchema,
  lmStudioDownloadStatusSchema,
  lmStudioTestSchema,
  parseIpcArgs,
  zProjectId,
  zThreadId,
  describeImagesSchema,
} from './ipc/ipc-guards.ts'
import { describeImagesForHandoff } from './services/image-description.ts'
import {
  recordStartupPhase,
  startEventLoopWatchdog,
  stopEventLoopWatchdog,
} from './services/diagnostics/event-loop-watchdog.ts'
import { installProcessFaultHandlers } from './services/diagnostics/process-faults.ts'
import { reportStartupBudget } from './services/diagnostics/startup-budget.ts'
import { destroyAllTerminalSessions } from './services/exec/terminal-service.ts'
import { getSetting } from './services/storage/settings.ts'
import { DEVELOPER_MODE_SETTING } from '@shared/developer-mode.ts'
import { stopAllBackgroundProcesses } from './services/exec/background-process.ts'
import {
  cancelAllSupervisedBackgroundProcesses,
  installBackgroundProcessSupervisor,
} from './services/exec/supervised-background-process.ts'
import {
  backgroundCompletionPrompt,
  setBackgroundCompletionWakeHandler,
} from './services/exec/background-completion-wake.ts'
import { closeVideoDecoder, setVideoDecoderPlatform } from './services/video/video-decoder.ts'
import {
  prepareThreadExecutionContext,
  resolveThreadExecutionContext,
  runWithThreadExecutionContext,
} from './services/thread-execution-context.ts'
import { parkCompletedPullRequestWorktree } from './services/worktree-parking.ts'
import { runWithActiveRunIdentity } from './services/thread-models.ts'
import {
  prepareThreadCheckout,
  previewThreadCheckout,
} from './services/thread-checkout-transaction.ts'
import { getAutomationService } from './services/automations/automation-service.ts'
import { getTaskSupervisor } from './services/supervisor/task-supervisor.ts'
import { installLongTaskWakeConsumer } from './services/supervisor/long-task-wake.ts'
import { installDarkFactorySensor } from './services/supervisor/dark-factory-sensor.ts'
import { installCiWatchConsumer } from './services/github/ci-watch-service.ts'
import { CANVAS_ARTEFACT_CHANNEL, setCanvasArtefactSink } from './services/canvas-dispatch.ts'
import { setContextEstimateRefreshSink } from './services/context-estimate-notify.ts'
import { setWorkspaceChangeSink } from './services/search/workspace-change-notify.ts'
import { broadcastToAppWindows } from './windows/app-window-broadcast.ts'

// Settings encrypts API keys through whichever cipher is installed rather than
// importing `safeStorage` itself, which is what keeps `createRegistry()` and
// everything under it loadable without Electron (#1313). Installed at module
// scope, before anything can read a key: this only stores the reference, and
// `safeStorage` is not called until a key is actually read or written.
setSecretCipher({
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plainText) => safeStorage.encryptString(plainText),
  decryptString: (encrypted) => safeStorage.decryptString(encrypted),
})
const taskSupervisor = getTaskSupervisor()

// Record escaped faults and quit through the normal cleanup path so an
// uncaught watcher/`error` event drains the write queue instead of dying
// mid-write. Watcher sites also bind their own listeners; this is the backstop.
installProcessFaultHandlers({
  onUncaughtException: () => {
    approveClose()
    app.quit()
  },
})

setBrowserSessionPlatform({
  createWindow: (options) => new BrowserWindow(options),
  getAgentSession: () => getAgentBrowserSession(),
  showUrl: (url) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send('browser:show-tab', url)
  },
})

setVideoDecoderPlatform({
  createWindow: (options) => new BrowserWindow(options),
  ipcMain,
  attachWebContentsLockdown,
})

setCanvasArtefactSink((artefact) => {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(CANVAS_ARTEFACT_CHANNEL, artefact)
})

setContextEstimateRefreshSink(() => {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send('agent:refresh_context_estimate')
})

setWorkspaceChangeSink((root) => {
  broadcastToAppWindows('git:working_tree_changed', root)
})

// Prevent multiple instances stacking invisible windows at the same position.
// A second launch focuses the existing window instead. Eval harness uses an isolated userData dir.
app.on('child-process-gone', (_event, details) => {
  console.error(
    `[process] child gone type=${details.type} reason=${details.reason} exitCode=${String(details.exitCode)}`,
  )
})

app.on('web-contents-created', (_event, contents) => {
  if (isBrowserWebContents(contents)) {
    attachBrowserGuestWindowOpen(contents)
    // Native right-click menu only on the visible in-app browser pane — not on
    // headless agent automation windows (same session lockdown, no UI surface).
    if (contents.session === getInAppBrowserSession()) {
      attachBrowserGuestContextMenu(contents)
    }
    return
  }
  attachWebContentsLockdown(contents)
})

const agentEval = process.env['COPSE_AGENT_EVAL'] === '1'
// Used only by the release workflow against the final signed app bundle. It
// avoids renderer/WebDriver dependencies while still exercising Electron boot,
// node-pty, and the filesystem-native thread store from the packaged artifact.
const releaseSmokeTest = process.argv.includes('--release-smoke-test')
// `copse --acp` drives the agent over stdio for an ACP client; it must not take
// the single-instance lock (each client spawns its own) or open a window.
const acpMode = process.argv.includes('--acp')
const gotSingleInstanceLock =
  agentEval || acpMode || releaseSmokeTest ? true : app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else if (!agentEval && !acpMode && !releaseSmokeTest) {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

app
  .whenReady()
  .then(async () => {
    if (acpMode) {
      // Headless ACP agent over stdio: bootstrap tools/provider, no window.
      const { runAcpAgentMode } = await import('./services/acp/acp-app-entry.ts')
      await runAcpAgentMode()
      return
    }

    if (releaseSmokeTest) {
      const { runReleaseSmokeTest } = await import('./release-smoke.ts')
      try {
        await initProjectSandbox()
        await runReleaseSmokeTest()
        console.log('[release-smoke] packaged app checks passed')
        app.exit(0)
      } catch (err) {
        console.error('[release-smoke] packaged app checks failed:', err)
        app.exit(1)
      }
      return
    }

    // Watch the main event loop for stalls from here on. Startup is exactly when
    // a synchronous hang (migrations, sandbox init, indexing) is most likely and
    // most expensive to diagnose after the fact (issue #995).
    startEventLoopWatchdog()
    recordStartupPhase('app-ready')
    perfMark('main:app-ready')
    installRendererPerfChannel()

    // Before we allocate our window/renderer: reap an oversized gortex daemon
    // left over from a previous (possibly SIGKILLed) session. Freeing its memory
    // while our own footprint is still minimal is what keeps a multi-GB zombie
    // from pushing the machine over its ceiling and OOM-killing us mid-boot.
    recordStartupPhase('reap-gortex')
    await reapOversizedGortexDaemon()
    // Then shed a store that has bloated past its ceiling. Must follow the reap
    // and precede any tracking: the daemon holds store.sqlite open, so this
    // stops it before unlinking (otherwise the space stays held by the open
    // inode). The index is derived data and rebuilds on the next workspace open.
    await reclaimBloatedGortexStore()

    recordStartupPhase('sandbox-init')
    await initProjectSandbox()

    recordStartupPhase('window-create')
    perfMark('main:window-create')
    const win = createMainWindow()
    // The shell tool streams child output through a sink rather than reaching
    // for the window itself, so `createRegistry()` stays importable without
    // Electron (#1313). Read the window per chunk rather than capturing `win`,
    // so output still lands if the window is ever recreated.
    setShellOutputSink((chunk, taskId) => {
      getMainWindow()?.webContents.send('agent:shell_output', chunk, taskId)
    })
    applyAppIcon([win])
    const developerMode = getSetting<boolean>(DEVELOPER_MODE_SETTING, false)
    buildAppMenu(
      {
        getFocusedWindow: getFocusedMainWindow,
        createWindow: createMainWindow,
      },
      developerMode,
    )
    initUpdatePrompt(win)
    initCloseConfirm(win)
    guardWindowClose(win)
    // Probe for rg/git/gh and the search backends only now: these are ~9 process
    // spawns (one of them, `gh auth status`, a network round trip), and run
    // before the window they cost the user seconds of blank screen. The window
    // is already loading its renderer while they run.
    //
    // Started here but NOT awaited until every IPC handler is registered below.
    // `createMainWindow()` has already fired `loadFile`, so the renderer boots
    // concurrently and invokes `settings:get` / `ssh-workspace:getStates` on
    // first paint — awaiting a multi-second probe before registration left those
    // invokes hitting "No handler registered", which rejects the unguarded
    // `await api.settings.get('model')` in the renderer's boot() and aborts the
    // layout mount.
    //
    // #523's invariant (read-only GitHub tools exposed only when `gh` probed
    // usable) is preserved by re-syncing them once the probe resolves, rather
    // than by ordering the probe ahead of `createRegistry()`.
    const toolAvailability = checkToolAvailability()
    // Packaged macOS build only: background update check + prompts (no-op elsewhere).
    initAutoUpdate(win)
    // P5: boot the plugin service before `createRegistry()` so persisted
    // `pluginDisabled` state is applied to the shared registry before
    // `syncModelComparisonTools` reads it — otherwise the fallback fresh
    // first-party registry (all plugins enabled) would register the tool for a
    // plugin the user turned off in a previous session.
    getPluginService()
    const registry = createRegistry()
    // The only Electron-specific seam the agent run needs: forward stream chunks
    // to the renderer. Injecting it as an AgentHost keeps runAgent free of BrowserWindow.
    // Guard against a window destroyed mid-run (e.g. closed while the agent streams).
    const agentHost: AgentHost<StreamChunk> = {
      emit: (threadId, chunk) => {
        if (!win.isDestroyed()) win.webContents.send('agent:chunk', threadId, chunk)
      },
    }

    // C2: forward an async hook's queued message to the renderer's pending queue
    // (decision 4). Same window-guarded send as `agent:chunk`.
    setHookQueueMessageSender((payload) => {
      if (!win.isDestroyed()) win.webContents.send('agent:hook_queue_message', payload)
    })

    const alertUser = createElectronUserAlertSender(win, app.dock)
    initApproval(win, ipcMain, alertUser)
    initAskUser(win, ipcMain, alertUser)
    // Lets main-process code hand the user a running command in the Shells pane
    // (the ACP re-authentication offer). The renderer owns the PTY's xterm tab,
    // so the request is forwarded rather than spawned here.
    setTerminalCommandLauncher((command) => {
      if (!win.isDestroyed()) win.webContents.send('terminal:run_command', command)
    })
    initSshAskpassServer(app.getPath('userData'))
    initSshPrompt(win, ipcMain)
    initSshWorkspaceIpc(win)
    initDiffQueue(win, ipcMain)
    initFsWatcher(win)
    const disposeTerminalHandlers = initTerminal(win)
    const disposeVncHandlers = initVnc(win)
    recordStartupPhase('register-handlers')
    perfMark('main:register-handlers')
    registerAllHandlers(win, registry)
    getAutomationService().start((event) => {
      if (!win.isDestroyed()) win.webContents.send('automations:triggered', event)
    })
    const agentDispatcher = new AgentDispatcher(agentHost, registry)
    disposeLongTaskWake = installLongTaskWakeConsumer(taskSupervisor, agentDispatcher)
    disposeCiWatchConsumer = installCiWatchConsumer(taskSupervisor, agentDispatcher)
    disposeBackgroundProcessSupervisor = installBackgroundProcessSupervisor(taskSupervisor)
    disposeDarkFactorySensor = installDarkFactorySensor(taskSupervisor)
    disposeTaskSupervisorEvents = taskSupervisor.subscribe((task) => {
      if (!win.isDestroyed()) win.webContents.send('supervisor:changed', task.projectId)
    })
    void taskSupervisor.start().catch((error: unknown) => {
      console.error('[task-supervisor] Startup reconciliation failed:', error)
    })
    setBackgroundCompletionWakeHandler((completion) => {
      return agentDispatcher.dispatchMachine({
        projectId: completion.owner.projectId,
        threadId: completion.owner.threadId,
        operationId: completion.operationId,
        turnTreeId: completion.turnTreeId,
        payload: {
          userContent: backgroundCompletionPrompt(completion),
          invokedSkills: [],
          priorTodos: [],
        },
      })
    })

    // Register before async bootstrap so onboarding/settings can query models on first paint.
    ipcMain.handle('lmstudio:test', async (event, url: unknown, apiKey?: unknown) => {
      assertMainFrameSender(event, win)
      const [parsedUrl, parsedApiKey] = parseIpcArgs(lmStudioTestSchema, [url, apiKey])
      const result = await testLmStudio(parsedUrl, parsedApiKey)
      invalidateLmStudioModelsCache() // refetch the dropdown after a manual test
      return result
    })

    ipcMain.handle('lmstudio:models', () => listLmStudioModels())

    ipcMain.handle('lmstudio:modelInfo', () => listLmStudioModelInfo())

    ipcMain.handle('openrouter:models', () => listFreeOpenRouterModels())

    ipcMain.handle('lmstudio:detect', async (event, url?: unknown, apiKey?: unknown) => {
      assertMainFrameSender(event, win)
      const [parsedUrl, parsedApiKey] = parseIpcArgs(lmStudioDetectSchema, [url, apiKey])
      return detectLmStudio(parsedUrl, parsedApiKey)
    })

    ipcMain.handle(
      'lmstudio:download',
      async (event, modelId: unknown, url?: unknown, apiKey?: unknown) => {
        assertMainFrameSender(event, win)
        const [parsedModelId, parsedUrl, parsedApiKey] = parseIpcArgs(lmStudioDownloadSchema, [
          modelId,
          url,
          apiKey,
        ])
        const baseUrl = parsedUrl ?? 'http://127.0.0.1:1234/v1'
        const result = await downloadLmStudioModel(parsedModelId, baseUrl, parsedApiKey)
        if (result.ok) invalidateLmStudioModelsCache()
        return result
      },
    )

    ipcMain.handle(
      'lmstudio:downloadStatus',
      async (event, jobId: unknown, url?: unknown, apiKey?: unknown) => {
        assertMainFrameSender(event, win)
        const [parsedJobId, parsedUrl, parsedApiKey] = parseIpcArgs(lmStudioDownloadStatusSchema, [
          jobId,
          url,
          apiKey,
        ])
        const baseUrl = parsedUrl ?? 'http://127.0.0.1:1234/v1'
        return getLmStudioDownloadStatus(parsedJobId, baseUrl, parsedApiKey)
      },
    )

    // Register before async bootstrap (skills/MCP) so the renderer, which loads
    // concurrently and fires a context estimate on first paint, never races a
    // missing handler. The registry these close over is populated lazily below.
    ipcMain.handle(
      'agent:previewCheckout',
      async (event, projectIdArg: unknown, choiceArg: unknown, modelArg?: unknown) => {
        assertMainFrameSender(event, win)
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        if (choiceArg !== 'automatic' && choiceArg !== 'shared' && choiceArg !== 'worktree') {
          throw new Error('Invalid checkout choice')
        }
        if (modelArg !== undefined && typeof modelArg !== 'string') {
          throw new Error('Invalid checkout model')
        }
        return previewThreadCheckout({
          projectId,
          choice: choiceArg,
          ...(modelArg !== undefined ? { model: modelArg } : {}),
        })
      },
    )

    ipcMain.handle(
      'agent:prepareCheckout',
      async (
        event,
        projectIdArg: unknown,
        threadIdArg: unknown,
        promptArg: unknown,
        choiceArg: unknown,
        modelArg?: unknown,
      ) => {
        assertMainFrameSender(event, win)
        assertPrimaryMainWindow(event.sender)
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        if (typeof promptArg !== 'string' || promptArg.length > 1_000_000) {
          throw new Error('Invalid checkout prompt')
        }
        if (choiceArg !== 'automatic' && choiceArg !== 'shared' && choiceArg !== 'worktree') {
          throw new Error('Invalid checkout choice')
        }
        if (modelArg !== undefined && typeof modelArg !== 'string') {
          throw new Error('Invalid checkout model')
        }
        return prepareThreadCheckout({
          projectId,
          threadId,
          prompt: promptArg,
          choice: choiceArg,
          ...(modelArg !== undefined ? { model: modelArg } : {}),
        })
      },
    )

    ipcMain.handle(
      'agent:run',
      async (event, projectIdArg: unknown, threadIdArg: unknown, rawPrompt: string) => {
        assertMainFrameSender(event, win)
        assertPrimaryMainWindow(event.sender)
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        await agentDispatcher.dispatch({
          projectId,
          threadId,
          payload: parseAgentRunPayload(rawPrompt),
        })
        await parkCompletedPullRequestWorktree(projectId, threadId).catch((error: unknown) => {
          console.warn('[worktree] Could not park PR-backed checkout:', error)
        })
      },
    )

    ipcMain.handle('agent:describeImages', async (event, ...rawArgs: unknown[]) => {
      assertMainFrameSender(event, win)
      const [projectId, threadId, model, userPrompt, images] = parseIpcArgs(
        describeImagesSchema,
        rawArgs,
      )
      return describeImagesForHandoff({ projectId, threadId, model, userPrompt, images })
    })

    ipcMain.handle(
      'agent:estimateContext',
      async (event, projectIdArg: unknown, threadIdArg: unknown, payloadJson: string) => {
        assertMainFrameSender(event, win)
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        let rawPayload: unknown
        try {
          rawPayload = JSON.parse(payloadJson)
        } catch {
          throw new Error('agent:estimateContext: payload is not valid JSON')
        }
        const parsed = estimateContextPayloadSchema.safeParse(rawPayload)
        if (!parsed.success) {
          throw new Error('agent:estimateContext: payload failed validation')
        }
        const { draftText = '', invokedSkills = [], imageCount = 0, model } = parsed.data
        const priorMessages = await agentDispatcher.history(projectId, threadId)
        return estimateContextBreakdown(registry, {
          draftText,
          invokedSkills,
          imageCount,
          priorMessages,
          ...(model !== undefined ? { model } : {}),
        })
      },
    )

    ipcMain.handle(
      'agent:clearHistory',
      async (event, projectIdArg: unknown, threadIdArg: unknown) => {
        assertMainFrameSender(event, win)
        assertPrimaryMainWindow(event.sender)
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        agentDispatcher.forgetHistory(projectId, threadId)
        await clearAgentHistory(projectId, threadId)
        clearRemoteAgentSession(threadId)
      },
    )

    // Opening a new chat drops the cached model catalogs so the next context
    // estimate re-fetches the provider's current window (e.g. an LM Studio model
    // reloaded with a different length, or an updated OpenRouter context limit).
    ipcMain.handle('agent:refreshModelContext', (event) => {
      assertMainFrameSender(event, win)
      invalidateLmStudioModelsCache()
      invalidateOpenRouterModelsCache()
      invalidateCursorCloudModelsCache()
    })

    ipcMain.handle('agent:abort', (event, threadIdArg: unknown) => {
      assertMainFrameSender(event, win)
      assertPrimaryMainWindow(event.sender)
      const threadId = parseIpcArgs(zThreadId, [threadIdArg])
      abortAgent(threadId)
    })

    // Thread ids with a live in-process run, so a renderer that's just loaded a
    // project's threads can tell a genuinely still-running turn apart from a
    // persisted `status: 'running'` left over from a crash (#1406).
    ipcMain.handle('agent:runningThreadIds', (event) => {
      assertMainFrameSender(event, win)
      return listRunningThreadIds()
    })

    // Re-run just the post-turn review / model comparison for a thread — the
    // retry action on a failed card. Both read the current working diff, so a
    // fixable failure (a mis-loaded local model, a transient provider error)
    // recovers without re-running the whole editing turn.
    const parseRetryPayload = (payloadJson: unknown): RetryOptions => {
      if (typeof payloadJson !== 'string') return {}
      let raw: unknown
      try {
        raw = JSON.parse(payloadJson)
      } catch {
        return {}
      }
      const parsed = retryReviewPayloadSchema.safeParse(raw)
      if (!parsed.success) return {}
      // Spread only the present keys: exactOptionalPropertyTypes rejects an
      // explicit `undefined` on RetryOptions' optional fields.
      return {
        ...(parsed.data.workingBrief !== undefined
          ? { workingBrief: parsed.data.workingBrief }
          : {}),
        ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
        ...(parsed.data.comparisonModels !== undefined
          ? { comparisonModels: parsed.data.comparisonModels }
          : {}),
      }
    }
    const hydrateHistory = (projectId: string, threadId: string): Promise<LLMMessage[]> =>
      agentDispatcher.history(projectId, threadId)

    ipcMain.handle(
      'agent:retryReview',
      async (event, projectIdArg: unknown, threadIdArg: unknown, payload: unknown) => {
        assertMainFrameSender(event, win)
        assertPrimaryMainWindow(event.sender)
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        const executionContext = await prepareThreadExecutionContext(projectId, threadId, agentHost)
        if (!executionContext) return
        const prior = await hydrateHistory(projectId, threadId)
        await runWithThreadExecutionContext(executionContext, () =>
          runWithActiveRunIdentity(threadId, () =>
            retryPostTurnReview(threadId, prior, agentHost, registry, parseRetryPayload(payload)),
          ),
        )
      },
    )

    ipcMain.handle(
      'agent:retryComparison',
      async (event, projectIdArg: unknown, threadIdArg: unknown, payload: unknown) => {
        assertMainFrameSender(event, win)
        assertPrimaryMainWindow(event.sender)
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        const executionContext = await prepareThreadExecutionContext(projectId, threadId, agentHost)
        if (!executionContext) return
        const prior = await hydrateHistory(projectId, threadId)
        await runWithThreadExecutionContext(executionContext, () =>
          runWithActiveRunIdentity(threadId, () =>
            retryModelComparison(threadId, prior, agentHost, registry, parseRetryPayload(payload)),
          ),
        )
      },
    )

    // Defaults for the "Compare models" bubble's picker. Read-only: it resolves
    // the pack's own settings and starts nothing, so unlike the run below it
    // needs no execution context.
    ipcMain.handle('agent:comparisonModels', async (event, payload: unknown) => {
      assertMainFrameSender(event, win)
      return resolveComparisonModelChoices(parseRetryPayload(payload))
    })

    ipcMain.handle('agent:suggestTitle', (event, text: string) => {
      assertMainFrameSender(event, win)
      return suggestThreadTitle(text)
    })

    ipcMain.handle('agent:suggestTerminalTitle', (event, text: string) => {
      assertMainFrameSender(event, win)
      return suggestTerminalTitle(text)
    })

    ipcMain.handle('agent:suggestCommandSummary', (event, commands: string[]) => {
      assertMainFrameSender(event, win)
      return suggestCommandSummary(commands)
    })

    ipcMain.handle('agent:suggestToolTurnSummary', (event, actions: string[]) => {
      assertMainFrameSender(event, win)
      return suggestToolTurnSummary(actions)
    })

    ipcMain.handle(
      'agent:suggestFollowUps',
      async (event, projectIdArg: unknown, threadIdArg: unknown, contextJson: string) => {
        assertMainFrameSender(event, win)
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        let rawContext: unknown
        try {
          rawContext = JSON.parse(contextJson)
        } catch {
          throw new Error('agent:suggestFollowUps: context is not valid JSON')
        }
        const parsed = followUpContextSchema.safeParse(rawContext)
        if (!parsed.success) {
          throw new Error('agent:suggestFollowUps: context failed validation')
        }
        const { root } = await resolveThreadExecutionContext(projectId, threadId)
        return suggestFollowUps(parsed.data, root)
      },
    )

    // Every channel the renderer can invoke is registered by here, so it is now
    // safe to block on the probe. Both syncs read `isGhAvailable()`, which only
    // answers truthfully once this resolves — `createRegistry()` ran while the
    // probe was still out and saw a null (false) result, so this is the call
    // that actually exposes the `gh`-backed tools.
    //
    // The phase marker sits here rather than at the call above so it measures
    // what the probe still *costs* boot — the residual wait after handler
    // registration overlapped it — not its total duration.
    recordStartupPhase('tool-availability')
    await toolAvailability
    syncGhTools(registry)
    syncCiInvestigatorTools(registry)

    recordStartupPhase('skills-mcp')
    await initSkillsRegistry()
    registerSkillTools(registry)
    await loadCustomTools(registry)

    recordStartupPhase('boot-complete')
    perfMark('main:boot-complete')
    // Counters accumulated during boot (per-IPC-channel totals, thread-store and
    // storage reads) are dumped at each boundary and reset, so the "boot" figures
    // and the later "switch" figures never blur together.
    perfDumpCounters('boot-complete')
    flushPerfTrace()
    // Print the boot timeline and flag any phase over its ceiling (#994). Every
    // expensive thing above scales with something CI does not have — profile
    // size, workspace size, MCP server count — so this is the one place the
    // number is observable on a real machine. Reported here, before the
    // background work below, so the timeline covers exactly the phases that
    // gated the boot.
    reportStartupBudget()

    // MCP connects in the background rather than gating boot. Each stdio server
    // is a process launch and each http server a network round trip, under a 30s
    // per-server connect timeout (CONNECT_TIMEOUT_MS) — awaited here, one slow or
    // unreachable server delayed the whole app for everyone.
    //
    // Tools arriving after boot is already a supported mode: `loadMcpServers` is
    // re-run from IPC whenever config or workspace trust changes, and it guards
    // that with a `loadGeneration` counter. The renderer already listens on
    // `mcp:status_changed`, so the UI fills in as servers land. (Under e2e this
    // is a no-op — `loadMcpServers` returns early there and never connects.)
    void loadMcpServers(registry)
      .catch((err: unknown) => {
        console.error('[mcp] initial server load failed:', err)
      })
      .finally(() => {
        if (!win.isDestroyed()) {
          win.webContents.send('mcp:status_changed', getMcpServerStatuses())
        }
      })
    disposeTerminal = disposeTerminalHandlers
    disposeVnc = disposeVncHandlers
  })
  .catch(console.error)

let quitCleanupStarted = false
let quitCleanupFinished = false
let disposeTerminal: (() => void) | undefined
let disposeVnc: (() => Promise<void>) | undefined
let disposeLongTaskWake: (() => void) | undefined
let disposeCiWatchConsumer: (() => void) | undefined
let disposeBackgroundProcessSupervisor: (() => void) | undefined
let disposeDarkFactorySensor: (() => void) | undefined
let disposeTaskSupervisorEvents: (() => void) | undefined

async function cleanupBeforeQuit(): Promise<void> {
  stopEventLoopWatchdog()
  perfMark('main:quit')
  perfDumpCounters('quit')
  flushPerfTrace()
  getAutomationService().stop()
  disposeDarkFactorySensor?.()
  disposeDarkFactorySensor = undefined
  disposeTaskSupervisorEvents?.()
  disposeTaskSupervisorEvents = undefined
  await cancelAllSupervisedBackgroundProcesses()
  await taskSupervisor.shutdown()
  disposeBackgroundProcessSupervisor?.()
  disposeBackgroundProcessSupervisor = undefined
  disposeLongTaskWake?.()
  disposeLongTaskWake = undefined
  disposeCiWatchConsumer?.()
  disposeCiWatchConsumer = undefined
  await disposeAllAcpSessions()
  destroyAllTerminalSessions()
  stopAllBackgroundProcesses()
  disposeTerminal?.()
  disposeTerminal = undefined
  await disposeVnc?.()
  disposeVnc = undefined
  closeAllWatchers()
  stopWorkspaceIndexWatcher()
  shutdownBrowserSession()
  await shutdownStaticPreviewServers()
  await drainWriteQueue()
  // Reap the detached gortex daemon too — left running it accumulates multi-GB
  // graphs across sessions and OOM-kills the app on a later launch.
  await Promise.allSettled([shutdownMcpServers(), shutdownProjectSandbox(), stopGortexDaemon()])
}

app.on('before-quit', (event) => {
  if (quitCleanupFinished) return
  // Ask before anything below runs: the cleanup this handler starts is what
  // kills the in-flight turns the user is being warned about, so a prompt after
  // it would come too late to save them. Re-issues the quit once confirmed.
  if (deferQuitForCloseConfirmation(event)) return
  destroyAllTerminalSessions()
  stopAllBackgroundProcesses()
  // The hidden video-decoder window is not the main window, so nothing else
  // closes it — left open it would keep the app alive past the last quit.
  closeVideoDecoder()
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  void cleanupBeforeQuit()
    .catch((err: unknown) => {
      console.error('[shutdown] Cleanup failed:', err)
    })
    .finally(() => {
      quitCleanupFinished = true
      app.quit()
    })
})

function quitFromSignal(signal: NodeJS.Signals): void {
  console.log(`[shutdown] Received ${signal}; quitting`)
  // A signal is not a user at the keyboard — there is nobody to answer the
  // running-thread prompt, and blocking here would hang the shutdown.
  approveClose()
  app.quit()
}

process.on('SIGINT', quitFromSignal)
process.on('SIGTERM', quitFromSignal)
