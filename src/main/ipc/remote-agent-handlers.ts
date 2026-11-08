import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { assertMainFrameSender, parseIpcArgs, zProjectId, zThreadId } from './ipc-guards.ts'
import { listRunningThreadIds } from '../services/agent-service.ts'
import { readOpenAiArtifact } from '../services/remote/openai-agents-client.ts'
import {
  refreshImportedCursorAgentThread,
  resolveRemoteArtifactDownloadUrl,
} from '../services/remote/remote-agent-client.ts'
import { listCursorCloudModels } from '../services/remote/cursor-cloud-models.ts'
import { createBestEffortExternalCursorAgentDiscovery } from '../services/remote/cursor-agent-discovery.ts'
import { artifactImageService } from '../services/remote/artifact-image/default-service.ts'
import {
  createArtifactDownloader,
  zArtifactDownloadRequest,
} from '../services/remote/artifact-download.ts'
import { getThreadMeta } from '../services/thread-store.ts'
import { senderProjectId } from './sender-project-root.ts'
import { zArtifactImageRequest } from '../services/remote/artifact-image/service.ts'

const discoverExternalCursorAgentsFromIpc = createBestEffortExternalCursorAgentDiscovery()

export function registerRemoteAgentHandlers(
  win: BrowserWindow,
  isDispatcherThreadActive: (projectId: string, threadId: string) => boolean,
): void {
  const downloadArtifact = createArtifactDownloader({
    async readThreadLink(projectId, threadId) {
      const meta = await getThreadMeta(projectId, threadId)
      if (!meta) throw new Error('unknown thread')
      return meta.remoteAgentLink ?? null
    },
    readOpenAiArtifact,
    async chooseSavePath(defaultPath) {
      const result = await dialog.showSaveDialog(win, {
        title: 'Save agent artifact',
        defaultPath,
      })
      return result.canceled ? null : result.filePath
    },
    writeFile,
    resolveCursorUrl: (agentId, path) => resolveRemoteArtifactDownloadUrl({ agentId, path }),
    openExternal: (url) => shell.openExternal(url),
  })
  ipcMain.handle('remote-agent:download-artifact', async (event, request: unknown) => {
    assertMainFrameSender(event, win)
    return downloadArtifact(parseIpcArgs(zArtifactDownloadRequest, [request]))
  })
  // Automatic artifact-image hydration: authorized against the thread's durable
  // remote-agent link and downloaded by a confined host, never by main.
  ipcMain.handle('remote-agent:artifact-image-data-url', (event, request: unknown) => {
    assertMainFrameSender(event, win)
    return artifactImageService().load(parseIpcArgs(zArtifactImageRequest, [request]))
  })
  ipcMain.handle('remote-agent:models', (event) => {
    assertMainFrameSender(event, win)
    return listCursorCloudModels()
  })
  /**
   * Import Cursor cloud agents launched outside Copse as local thread stubs.
   * Prefer passing the renderer’s active `projectId` so sync stays scoped to the
   * open project; without one, the asking window's project is used, never the
   * process-global one (#3958). Caller should reload/merge project threads
   * after imports.
   */
  ipcMain.handle('remote-agent:discover-external', (event, projectId: unknown) => {
    assertMainFrameSender(event, win)
    if (projectId === undefined || projectId === null) {
      return discoverExternalCursorAgentsFromIpc({ projectId: senderProjectId(event.sender) })
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
