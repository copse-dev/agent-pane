import './app-init.ts' // MUST be first — sets app name/userData before electron-store builds
import { app, ipcMain } from 'electron'
import { attachWebContentsLockdown } from './windows/web-contents-lockdown.ts'
import {
  attachBrowserGuestWindowOpen,
  isBrowserWebContents,
} from './windows/browser-web-contents.ts'
import { applyAppIcon } from './app-icon.ts'
import type { LLMMessage } from '@shared/types'
import { createMainWindow } from './windows/create-main-window.ts'
import { buildAppMenu } from './windows/app-menu.ts'
import { checkToolAvailability } from './services/tool-availability.ts'
import { createRegistry, registerSkillTools } from './services/registry-bootstrap.ts'
import {
  loadMcpServers,
  shutdownMcpServers,
  getMcpServerStatuses,
} from './services/mcp-registry.ts'
import { loadCustomTools } from './services/custom-tools-registry.ts'
import { initApproval } from './services/approval.ts'
import { initDiffQueue } from './services/diff-queue.ts'
import { initFsWatcher, closeAllWatchers } from './ipc/fs-watcher.ts'
import { stopWorkspaceIndexWatcher } from './services/workspace-index-watcher.ts'
import { initTerminal } from './ipc/terminal.ts'
import { registerAllHandlers } from './ipc/register-handlers.ts'
import { initSkillsRegistry } from './services/skills-registry.ts'
import { parseAgentRunPayload } from '@shared/agent/parse-agent-run-payload.ts'
import type { AgentHost } from '@shared/agent/agent-host.ts'
import {
  runAgent,
  abortAgent,
  suggestThreadTitle,
  suggestTerminalTitle,
  testLmStudio,
  listLmStudioModels,
  invalidateLmStudioModelsCache,
} from './services/agent-service.ts'
import { listFreeOpenRouterModels } from './services/openrouter-models.ts'
import {
  detectLmStudio,
  downloadLmStudioModel,
  getLmStudioDownloadStatus,
} from './services/lm-studio-setup.ts'
import { estimateContextBreakdown } from './services/context-estimate.ts'
import { suggestFollowUps } from './services/follow-up-service.ts'
import type { FollowUpContext } from '@shared/follow-ups/types.ts'
import { storageGet, storageSet } from './services/storage.ts'
import { getMainWindow } from './windows/create-main-window.ts'
import { initProjectSandbox, shutdownProjectSandbox } from './project-sandbox/index.ts'
import { clearRemoteAgentSession } from './services/remote-agent-client.ts'
import { shutdownBrowserSession } from './services/browser/session-manager.ts'
import { drainWriteQueue } from './services/write-queue.ts'
import { assertMainFrameSender } from './ipc/ipc-guards.ts'
import { destroyAllTerminalSessions } from './services/terminal-service.ts'

// Prevent multiple instances stacking invisible windows at the same position.
// A second launch focuses the existing window instead. Eval harness uses an isolated userData dir.
app.on('web-contents-created', (_event, contents) => {
  if (isBrowserWebContents(contents)) {
    attachBrowserGuestWindowOpen(contents)
    return
  }
  attachWebContentsLockdown(contents)
})

const agentEval = process.env.COPSE_AGENT_EVAL === '1'
// `copse --acp` drives the agent over stdio for an ACP client; it must not take
// the single-instance lock (each client spawns its own) or open a window.
const acpMode = process.argv.includes('--acp')
const gotSingleInstanceLock = agentEval || acpMode ? true : app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else if (!agentEval && !acpMode) {
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

    await checkToolAvailability()
    await initProjectSandbox()

    const win = createMainWindow()
    applyAppIcon([win])
    buildAppMenu(win)
    const registry = createRegistry()
    // The only Electron-specific seam the agent run needs: forward stream chunks
    // to the renderer. Injecting it as an AgentHost keeps runAgent free of BrowserWindow.
    // Guard against a window destroyed mid-run (e.g. closed while the agent streams).
    const agentHost: AgentHost = {
      emit: (threadId, chunk) => {
        if (!win.isDestroyed()) win.webContents.send('agent:chunk', threadId, chunk)
      },
    }

    initApproval(win)
    initDiffQueue(win)
    initFsWatcher(win)
    const disposeTerminalHandlers = initTerminal(win)
    registerAllHandlers(win, registry)

    // Register before async bootstrap so onboarding/settings can query models on first paint.
    ipcMain.handle('lmstudio:test', async (_e, url: string, apiKey?: string) => {
      const result = await testLmStudio(url, apiKey)
      invalidateLmStudioModelsCache() // refetch the dropdown after a manual test
      return result
    })

    ipcMain.handle('lmstudio:models', () => listLmStudioModels())

    ipcMain.handle('openrouter:models', () => listFreeOpenRouterModels())

    ipcMain.handle('lmstudio:detect', async (_e, url?: string, apiKey?: string) =>
      detectLmStudio(url, apiKey),
    )

    ipcMain.handle(
      'lmstudio:download',
      async (_e, modelId: string, url?: string, apiKey?: string) => {
        const baseUrl = url ?? 'http://localhost:1234/v1'
        const result = await downloadLmStudioModel(modelId, baseUrl, apiKey)
        if (result.ok) invalidateLmStudioModelsCache()
        return result
      },
    )

    ipcMain.handle(
      'lmstudio:downloadStatus',
      async (_e, jobId: string, url?: string, apiKey?: string) => {
        const baseUrl = url ?? 'http://localhost:1234/v1'
        return getLmStudioDownloadStatus(jobId, baseUrl, apiKey)
      },
    )

    // Register before async bootstrap (skills/MCP) so the renderer, which loads
    // concurrently and fires a context estimate on first paint, never races a
    // missing handler. The registry these close over is populated lazily below.
    const messageHistory = new Map<string, LLMMessage[]>()

    ipcMain.handle('agent:run', async (event, threadId: string, rawPrompt: string) => {
      assertMainFrameSender(event, win)
      const { userContent, invokedSkills, priorTodos, workingBrief } =
        parseAgentRunPayload(rawPrompt)

      // Hydrate from persisted storage on first use after a restart
      if (!messageHistory.has(threadId)) {
        const stored = storageGet(`llm-history:${threadId}`)
        if (Array.isArray(stored)) {
          messageHistory.set(threadId, stored as LLMMessage[])
        }
      }

      const priorMessages = messageHistory.get(threadId) ?? []
      const result = await runAgent(threadId, userContent, priorMessages, agentHost, registry, {
        invokedSkills,
        priorTodos,
        ...(workingBrief !== undefined ? { workingBrief } : {}),
      })
      messageHistory.set(threadId, result.messages)
      storageSet(`llm-history:${threadId}`, result.messages)
    })

    ipcMain.handle(
      'agent:estimateContext',
      async (event, threadId: string, payloadJson: string) => {
        assertMainFrameSender(event, win)
        const {
          draftText = '',
          invokedSkills = [],
          imageCount = 0,
        } = JSON.parse(payloadJson) as {
          draftText?: string
          invokedSkills?: string[]
          imageCount?: number
        }
        if (!messageHistory.has(threadId)) {
          const stored = storageGet(`llm-history:${threadId}`)
          if (Array.isArray(stored)) messageHistory.set(threadId, stored as LLMMessage[])
        }
        const priorMessages = messageHistory.get(threadId) ?? []
        return estimateContextBreakdown(registry, {
          draftText,
          invokedSkills,
          imageCount,
          priorMessages,
        })
      },
    )

    ipcMain.handle('agent:clearHistory', (event, threadId: string) => {
      assertMainFrameSender(event, win)
      messageHistory.delete(threadId)
      storageSet(`llm-history:${threadId}`, null)
      clearRemoteAgentSession(threadId)
    })

    ipcMain.handle('agent:abort', (event, threadId: string) => {
      assertMainFrameSender(event, win)
      abortAgent(threadId)
    })

    ipcMain.handle('agent:suggestTitle', (event, text: string) => {
      assertMainFrameSender(event, win)
      return suggestThreadTitle(text)
    })

    ipcMain.handle('agent:suggestTerminalTitle', (event, text: string) => {
      assertMainFrameSender(event, win)
      return suggestTerminalTitle(text)
    })

    ipcMain.handle('agent:suggestFollowUps', (event, contextJson: string) => {
      assertMainFrameSender(event, win)
      const context = JSON.parse(contextJson) as FollowUpContext
      return suggestFollowUps(context)
    })

    await initSkillsRegistry()
    registerSkillTools(registry)
    await loadMcpServers(registry)
    win.webContents.send('mcp:status_changed', getMcpServerStatuses())
    await loadCustomTools(registry)

    disposeTerminal = disposeTerminalHandlers
  })
  .catch(console.error)

let quitCleanupStarted = false
let quitCleanupFinished = false
let disposeTerminal: (() => void) | undefined

async function cleanupBeforeQuit(): Promise<void> {
  destroyAllTerminalSessions()
  disposeTerminal?.()
  disposeTerminal = undefined
  closeAllWatchers()
  stopWorkspaceIndexWatcher()
  shutdownBrowserSession()
  await drainWriteQueue()
  await Promise.allSettled([shutdownMcpServers(), shutdownProjectSandbox()])
}

app.on('before-quit', (event) => {
  if (quitCleanupFinished) return
  destroyAllTerminalSessions()
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
