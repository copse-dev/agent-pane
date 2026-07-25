import './app-init.ts' // MUST be first — sets app name/userData before electron-store builds
import { app, ipcMain } from 'electron'
import { attachWebContentsLockdown } from './windows/web-contents-lockdown.ts'
import {
  attachBrowserGuestWindowOpen,
  getInAppBrowserSession,
  isBrowserWebContents,
} from './windows/browser-web-contents.ts'
import { attachBrowserGuestContextMenu } from './windows/browser-context-menu.ts'
import { applyAppIcon } from './app-icon.ts'
import type { LLMMessage, StreamChunk } from '@shared/types'
import { createMainWindow } from './windows/create-main-window.ts'
import { buildAppMenu } from './windows/app-menu.ts'
import { initAutoUpdate } from './services/auto-update.ts'
import { initUpdatePrompt } from './services/update-prompt.ts'
import { checkToolAvailability } from './services/tool-availability.ts'
import { createRegistry, registerSkillTools } from './services/registry-bootstrap.ts'
import { getPackService } from './services/packs/pack-service.ts'
import {
  loadMcpServers,
  shutdownMcpServers,
  getMcpServerStatuses,
} from './services/mcp/mcp-registry.ts'
import { loadCustomTools } from './services/mcp/custom-tools-registry.ts'
import { disposeAllAcpSessions } from './services/acp/acp-session-pool.ts'
import { initApproval } from './services/approval.ts'
import { initAskUser } from './services/ask-user.ts'
import { initSshPrompt } from './services/ssh-workspace/ssh-prompt.ts'
import { initSshAskpassServer } from './services/ssh-workspace/askpass.ts'
import { initSshWorkspaceIpc } from './services/ssh-workspace/ssh-workspace-ipc.ts'
import { initDiffQueue } from './services/diff-queue.ts'
import { initFsWatcher, closeAllWatchers } from './ipc/fs-watcher.ts'
import { stopWorkspaceIndexWatcher } from './services/search/workspace-index-watcher.ts'
import { reapOversizedGortexDaemon, stopGortexDaemon } from './services/search/semantic-index.ts'
import { initTerminal } from './ipc/terminal.ts'
import { registerAllHandlers } from './ipc/register-handlers.ts'
import { initSkillsRegistry } from './services/skills/skills-registry.ts'
import { parseAgentRunPayload } from '@copse/agent/parse-agent-run-payload.ts'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import {
  runAgent,
  abortAgent,
  retryPostTurnReview,
  retryModelComparison,
  suggestThreadTitle,
  suggestTerminalTitle,
  suggestCommandSummary,
  suggestToolTurnSummary,
  testLmStudio,
  listLmStudioModels,
  invalidateLmStudioModelsCache,
} from './services/agent-service.ts'
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
import { clearAgentHistory, loadAgentHistory, saveAgentHistory } from './services/thread-store.ts'
import { getMainWindow } from './windows/create-main-window.ts'
import { setHookQueueMessageSender } from './services/hooks/hook-queue-channel.ts'
import { initProjectSandbox, shutdownProjectSandbox } from './project-sandbox/index.ts'
import { clearRemoteAgentSession } from './services/remote/remote-agent-client.ts'
import { shutdownBrowserSession } from './services/browser/session-manager.ts'
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
} from './ipc/ipc-guards.ts'
import {
  recordStartupPhase,
  startEventLoopWatchdog,
  stopEventLoopWatchdog,
} from './services/diagnostics/event-loop-watchdog.ts'
import { destroyAllTerminalSessions } from './services/exec/terminal-service.ts'
import { stopAllBackgroundProcesses } from './services/exec/background-process.ts'
import {
  prepareThreadExecutionContext,
  runWithThreadExecutionContext,
} from './services/thread-execution-context.ts'
import { runWithActiveRunIdentity } from './services/thread-models.ts'
import {
  prepareThreadCheckout,
  previewThreadCheckout,
} from './services/thread-checkout-transaction.ts'

// Prevent multiple instances stacking invisible windows at the same position.
// A second launch focuses the existing window instead. Eval harness uses an isolated userData dir.
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

    // Before we allocate our window/renderer: reap an oversized gortex daemon
    // left over from a previous (possibly SIGKILLed) session. Freeing its memory
    // while our own footprint is still minimal is what keeps a multi-GB zombie
    // from pushing the machine over its ceiling and OOM-killing us mid-boot.
    recordStartupPhase('reap-gortex')
    await reapOversizedGortexDaemon()

    recordStartupPhase('sandbox-init')
    await initProjectSandbox()

    // One-time import of pre-#644 threads into the ~/.copse/workspace store.
    // Self-contained — delete this block and thread-migration.ts to drop it.
    recordStartupPhase('thread-migration')
    const { migrateLegacyThreads } = await import('./services/thread-migration.ts')
    const migration = await migrateLegacyThreads()
    if (migration.ranMigration) {
      console.log(
        `[thread-migration] imported ${String(migration.migrated)} thread(s) from ${String(migration.projects)} project(s), skipped ${String(migration.skipped)}`,
      )
    }

    // Move provider-format history out of electron-store into per-thread
    // sidecars (issue #993). Must run after legacy thread dirs exist so
    // ownership can be resolved, and before the first window.
    recordStartupPhase('llm-history-migration')
    const { migrateLlmHistory } = await import('./services/llm-history-migration.ts')
    const historyMigration = await migrateLlmHistory()
    if (historyMigration.scanned > 0) {
      console.log(
        `[llm-history-migration] scanned ${String(historyMigration.scanned)}, migrated ${String(historyMigration.migrated)}, removed ${String(historyMigration.legacyKeysRemoved)} legacy key(s)`,
      )
    }

    recordStartupPhase('window-create')
    const win = createMainWindow()
    applyAppIcon([win])
    buildAppMenu(win)
    initUpdatePrompt(win)
    // Probe for rg/git/gh and the search backends only now: these are ~9 process
    // spawns (one of them, `gh auth status`, a network round trip), and run
    // before the window they cost the user seconds of blank screen. The window
    // is already loading its renderer while they run.
    //
    // This must still finish before `createRegistry()` below, which reads
    // `isGhAvailable()` synchronously to decide whether the read-only GitHub
    // tools are exposed at all (#523).
    recordStartupPhase('tool-availability')
    await checkToolAvailability()
    // Packaged macOS build only: background update check + prompts (no-op elsewhere).
    initAutoUpdate(win)
    // P5: boot the pack service before `createRegistry()` so persisted
    // `packDisabled` state is applied to the shared registry before
    // `syncModelComparisonTools` reads it — otherwise the fallback fresh
    // first-party registry (all packs enabled) would register the tool for a
    // pack the user turned off in a previous session.
    getPackService()
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

    initApproval(win)
    initAskUser(win)
    initSshAskpassServer(app.getPath('userData'))
    initSshPrompt(win)
    initSshWorkspaceIpc(win)
    initDiffQueue(win)
    initFsWatcher(win)
    const disposeTerminalHandlers = initTerminal(win)
    recordStartupPhase('register-handlers')
    registerAllHandlers(win, registry)
    // Register before async bootstrap so onboarding/settings can query models on first paint.
    ipcMain.handle('lmstudio:test', async (event, url: unknown, apiKey?: unknown) => {
      assertMainFrameSender(event, win)
      const [parsedUrl, parsedApiKey] = parseIpcArgs(lmStudioTestSchema, [url, apiKey])
      const result = await testLmStudio(parsedUrl, parsedApiKey)
      invalidateLmStudioModelsCache() // refetch the dropdown after a manual test
      return result
    })

    ipcMain.handle('lmstudio:models', () => listLmStudioModels())

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
        const baseUrl = parsedUrl ?? 'http://localhost:1234/v1'
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
        const baseUrl = parsedUrl ?? 'http://localhost:1234/v1'
        return getLmStudioDownloadStatus(parsedJobId, baseUrl, parsedApiKey)
      },
    )

    // Register before async bootstrap (skills/MCP) so the renderer, which loads
    // concurrently and fires a context estimate on first paint, never races a
    // missing handler. The registry these close over is populated lazily below.
    // In-memory provider history, keyed by projectId + threadId so a thread id
    // is never treated as globally unique (issue #993).
    const messageHistory = new Map<string, LLMMessage[]>()
    const historyKey = (projectId: string, threadId: string): string => `${projectId}\0${threadId}`

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
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        const {
          userContent,
          invokedSkills,
          priorTodos,
          workingBrief,
          model,
          turnTreeId,
          continuationBudgetUsed,
        } = parseAgentRunPayload(rawPrompt)

        // Hydrate from the per-thread sidecar on first use after a restart
        const cacheKey = historyKey(projectId, threadId)
        if (!messageHistory.has(cacheKey)) {
          messageHistory.set(cacheKey, await loadAgentHistory(projectId, threadId))
        }

        const priorMessages = messageHistory.get(cacheKey) ?? []
        const executionContext = await prepareThreadExecutionContext(projectId, threadId, agentHost)
        if (!executionContext) return
        const result = await runWithThreadExecutionContext(executionContext, () =>
          runWithActiveRunIdentity(threadId, () =>
            runAgent(threadId, userContent, priorMessages, agentHost, registry, {
              invokedSkills,
              priorTodos,
              ...(workingBrief !== undefined ? { workingBrief } : {}),
              ...(model !== undefined ? { model } : {}),
              ...(turnTreeId !== undefined ? { turnTreeId } : {}),
              ...(continuationBudgetUsed !== undefined ? { continuationBudgetUsed } : {}),
            }),
          ),
        )
        messageHistory.set(cacheKey, result.messages)
        await saveAgentHistory(projectId, threadId, result.messages)
      },
    )

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
        const cacheKey = historyKey(projectId, threadId)
        if (!messageHistory.has(cacheKey)) {
          messageHistory.set(cacheKey, await loadAgentHistory(projectId, threadId))
        }
        const priorMessages = messageHistory.get(cacheKey) ?? []
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
        const projectId = parseIpcArgs(zProjectId, [projectIdArg])
        const threadId = parseIpcArgs(zThreadId, [threadIdArg])
        messageHistory.delete(historyKey(projectId, threadId))
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
      const threadId = parseIpcArgs(zThreadId, [threadIdArg])
      abortAgent(threadId)
    })

    // Re-run just the post-turn review / model comparison for a thread — the
    // retry action on a failed card. Both read the current working diff, so a
    // fixable failure (a mis-loaded local model, a transient provider error)
    // recovers without re-running the whole editing turn.
    const parseRetryPayload = (payloadJson: unknown): { workingBrief?: string; model?: string } => {
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
      }
    }
    const hydrateHistory = async (projectId: string, threadId: string): Promise<LLMMessage[]> => {
      const cacheKey = historyKey(projectId, threadId)
      if (!messageHistory.has(cacheKey)) {
        messageHistory.set(cacheKey, await loadAgentHistory(projectId, threadId))
      }
      return messageHistory.get(cacheKey) ?? []
    }

    ipcMain.handle(
      'agent:retryReview',
      async (event, projectIdArg: unknown, threadIdArg: unknown, payload: unknown) => {
        assertMainFrameSender(event, win)
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

    ipcMain.handle('agent:suggestFollowUps', (event, contextJson: string) => {
      assertMainFrameSender(event, win)
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
      return suggestFollowUps(parsed.data)
    })

    recordStartupPhase('skills-mcp')
    await initSkillsRegistry()
    registerSkillTools(registry)
    await loadMcpServers(registry)
    win.webContents.send('mcp:status_changed', getMcpServerStatuses())
    await loadCustomTools(registry)

    recordStartupPhase('boot-complete')
    disposeTerminal = disposeTerminalHandlers
  })
  .catch(console.error)

let quitCleanupStarted = false
let quitCleanupFinished = false
let disposeTerminal: (() => void) | undefined

async function cleanupBeforeQuit(): Promise<void> {
  stopEventLoopWatchdog()
  await disposeAllAcpSessions()
  destroyAllTerminalSessions()
  stopAllBackgroundProcesses()
  disposeTerminal?.()
  disposeTerminal = undefined
  closeAllWatchers()
  stopWorkspaceIndexWatcher()
  shutdownBrowserSession()
  await drainWriteQueue()
  // Reap the detached gortex daemon too — left running it accumulates multi-GB
  // graphs across sessions and OOM-kills the app on a later launch.
  await Promise.allSettled([shutdownMcpServers(), shutdownProjectSandbox(), stopGortexDaemon()])
}

app.on('before-quit', (event) => {
  if (quitCleanupFinished) return
  destroyAllTerminalSessions()
  stopAllBackgroundProcesses()
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
  app.quit()
}

process.on('SIGINT', quitFromSignal)
process.on('SIGTERM', quitFromSignal)
