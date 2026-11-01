import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zProjectId, zThreadId } from './ipc-guards.ts'
import { listRunningThreadIds } from '../services/agent-service.ts'
import { readOpenAiArtifact } from '../services/remote/openai-agents-client.ts'
import {
  fetchRemoteArtifactImageDataUrl,
  refreshImportedCursorAgentThread,
  resolveRemoteArtifactDownloadUrl,
} from '../services/remote/remote-agent-client.ts'
import { listCursorCloudModels } from '../services/remote/cursor-cloud-models.ts'
import { createBestEffortExternalCursorAgentDiscovery } from '../services/remote/cursor-agent-discovery.ts'

const discoverExternalCursorAgentsFromIpc = createBestEffortExternalCursorAgentDiscovery()

export function registerRemoteAgentHandlers(
  win: BrowserWindow,
  isDispatcherThreadActive: (projectId: string, threadId: string) => boolean,
): void {
  ipcMain.handle(
    'remote-agent:download-artifact',
    async (event, agentId: unknown, path: unknown) => {
      assertMainFrameSender(event, win)
      const parsedAgentId = parseIpcArgs(z.string().min(1).max(128), [agentId])
      const parsedPath = parseIpcArgs(z.string().min(1).max(4096), [path])
      if (parsedAgentId.startsWith('openai:')) {
        const data = await readOpenAiArtifact(parsedAgentId.slice('openai:'.length), parsedPath)
        const result = await dialog.showSaveDialog(win, {
          title: 'Save agent artifact',
          defaultPath: `agent-artifact${extname(parsedPath)}`,
        })
        if (!result.canceled && result.filePath) await writeFile(result.filePath, data)
        return ''
      }
      return resolveRemoteArtifactDownloadUrl({ agentId: parsedAgentId, path: parsedPath })
    },
  )
  ipcMain.handle(
    'remote-agent:artifact-image-data-url',
    async (event, agentId: unknown, path: unknown) => {
      assertMainFrameSender(event, win)
      const parsedAgentId = parseIpcArgs(z.string().min(1).max(128), [agentId])
      const parsedPath = parseIpcArgs(z.string().min(1).max(4096), [path])
      return fetchRemoteArtifactImageDataUrl({ agentId: parsedAgentId, path: parsedPath })
    },
  )
  ipcMain.handle('remote-agent:models', (event) => {
    assertMainFrameSender(event, win)
    return listCursorCloudModels()
  })
  /**
   * Import Cursor cloud agents launched outside Copse as local thread stubs.
   * Prefer passing the renderer’s active `projectId` so sync stays scoped to the
   * open project. Caller should reload/merge project threads after imports.
   */
  ipcMain.handle('remote-agent:discover-external', (event, projectId: unknown) => {
    assertMainFrameSender(event, win)
    if (projectId === undefined || projectId === null) {
      return discoverExternalCursorAgentsFromIpc()
    }
    const id = parseIpcArgs(zProjectId, [projectId])
    return discoverExternalCursorAgentsFromIpc({ projectId: id })
  })
  ipcMain.handle(
    'remote-agent:refresh-imported-thread',
    (event, projectId: unknown, threadId: unknown) => {
      assertMainFrameSender(event, win)
      const [id, thread] = parseIpcArgs(z.tuple([zProjectId, zThreadId]), [projectId, threadId])
      return refreshImportedCursorAgentThread({
        projectId: id,
        threadId: thread,
        isThreadRunning: (candidateId) =>
          isDispatcherThreadActive(id, candidateId) || listRunningThreadIds().includes(candidateId),
      })
    },
  )
}
