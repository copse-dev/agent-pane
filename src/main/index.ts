import './app-init.ts' // MUST be first — sets app name/userData before electron-store builds
import { app, ipcMain } from 'electron'
import type { UserContent, LLMMessage } from '@shared/types'
import { createMainWindow } from './windows/create-main-window.ts'
import { buildAppMenu } from './windows/app-menu.ts'
import { getApiKey } from './services/settings.ts'
import { checkToolAvailability } from './services/tool-availability.ts'
import { createRegistry } from './services/registry-bootstrap.ts'
import { loadMcpServers, shutdownMcpServers } from './services/mcp-registry.ts'
import { initApproval } from './services/approval.ts'
import { initDiffQueue } from './services/diff-queue.ts'
import { initFsWatcher, closeAllWatchers } from './ipc/fs-watcher.ts'
import { registerAllHandlers } from './ipc/register-handlers.ts'
import {
  runAgent,
  abortAgent,
  suggestThreadTitle,
  testLmStudio,
  listLmStudioModels,
  invalidateLmStudioModelsCache,
} from './services/agent-service.ts'
import { getMainWindow } from './windows/create-main-window.ts'

// Prevent multiple instances stacking invisible windows at the same position.
// A second launch focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
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
    // A key saved in Settings is an explicit user choice, so let it override any
    // (possibly stale) ANTHROPIC_API_KEY / OPENAI_API_KEY inherited from the
    // shell. Only fall back to the inherited env var when nothing is stored.
    const storedAnthropic = getApiKey('anthropic')
    if (storedAnthropic) process.env.ANTHROPIC_API_KEY = storedAnthropic
    const storedOpenai = getApiKey('openai')
    if (storedOpenai) process.env.OPENAI_API_KEY = storedOpenai

    await checkToolAvailability()

    const win = createMainWindow()
    buildAppMenu(win)
    const registry = createRegistry()

    initApproval(win)
    initDiffQueue(win)
    initFsWatcher(win)
    registerAllHandlers(win, registry)

    await loadMcpServers(registry)

    const messageHistory = new Map<string, LLMMessage[]>()

    ipcMain.handle('agent:run', async (_e, threadId: string, rawPrompt: string) => {
      let userContent: UserContent
      try {
        userContent = JSON.parse(rawPrompt) as UserContent
      } catch {
        userContent = rawPrompt
      }
      const priorMessages = messageHistory.get(threadId) ?? []
      const result = await runAgent(threadId, userContent, priorMessages, win, registry)
      messageHistory.set(threadId, result.messages)
    })

    ipcMain.handle('agent:abort', (_e, threadId: string) => {
      abortAgent(threadId)
    })

    ipcMain.handle('agent:suggestTitle', (_e, text: string) => suggestThreadTitle(text))

    ipcMain.handle('lmstudio:test', async (_e, url: string, apiKey?: string) => {
      const result = await testLmStudio(url, apiKey)
      invalidateLmStudioModelsCache() // refetch the dropdown after a manual test
      return result
    })

    ipcMain.handle('lmstudio:models', () => listLmStudioModels())
  })
  .catch(console.error)

app.on('before-quit', () => {
  closeAllWatchers()
  void shutdownMcpServers()
})
