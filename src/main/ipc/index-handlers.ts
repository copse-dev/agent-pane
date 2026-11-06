import { BrowserWindow, ipcMain } from 'electron'
import { dirname, relative } from 'node:path'
import { z } from 'zod'
import micromatch from 'micromatch'
import { getWorkspaceRoot } from '../services/workspace.ts'
import {
  isIndexQueryPattern,
  assertMainFrameSender,
  IpcValidationError,
  parseIpcArgs,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import {
  resolveThreadExecutionContext,
  runWithThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { expectedThreadWorktreePath, repositoryLocation } from '../services/worktree-manager.ts'
import {
  getReadyFileIndex,
  resolveFileIndexTarget,
  whenFileIndexReady,
} from '../services/search/file-index.ts'
import { resolveFileReferences } from '../services/search/file-reference-resolver.ts'
import {
  getWorkspaceIndexStatus,
  onWorkspaceIndexStatusChanged,
} from '../services/search/index-status.ts'

export function registerIndexHandlers(win: BrowserWindow): void {
  ipcMain.handle('index:query', async (event, pattern: unknown) => {
    assertMainFrameSender(event, win)
    if (pattern !== undefined && typeof pattern !== 'string') {
      throw new IpcValidationError('Index query pattern must be a string')
    }
    const query = typeof pattern === 'string' ? pattern : ''
    if (query && !isIndexQueryPattern(query)) return []
    // Renderer-global feature (command palette / `@` mention picker), scoped
    // to the renderer-selected workspace root, not any one thread's execution root.
    const root = getWorkspaceRoot()
    if (!root) return []
    const idx = await getReadyFileIndex(root)
    if (!idx) return []
    return query ? micromatch(idx.paths, `**/*${query}*`).slice(0, 20) : idx.paths.slice(0, 20)
  })

  ipcMain.handle('index:status', (event) => {
    assertMainFrameSender(event, win)
    return getWorkspaceIndexStatus()
  })

  onWorkspaceIndexStatusChanged((status) => {
    if (!win.isDestroyed()) win.webContents.send('index:status-changed', status)
  })

  ipcMain.handle(
    'index:resolve-file-references',
    async (event, rawCandidates: unknown, rawOwner: unknown) => {
      assertMainFrameSender(event, win)
      const [candidates, owner] = parseIpcArgs(
        z.tuple([
          z.array(z.string().min(1).max(4096)).max(200),
          z.object({ projectId: zProjectId, threadId: zThreadId }).strict().optional(),
        ]),
        [rawCandidates, rawOwner],
      )
      if (!owner) {
        const root = getWorkspaceRoot()
        const target = resolveFileIndexTarget()
        if (root) await whenFileIndexReady(root, target)
        return await resolveFileReferences(candidates, root, undefined, target)
      }
      const context = await resolveThreadExecutionContext(owner.projectId, owner.threadId)
      return runWithThreadExecutionContext(context, async () => {
        const root = context.root
        await whenFileIndexReady(root)

        const currentWorktreePath = expectedThreadWorktreePath(owner.projectId, owner.threadId)
        let projectRelativePath = relative(currentWorktreePath, context.root)
        if (context.checkoutMode === 'shared') {
          try {
            ;({ projectRelativePath } = await repositoryLocation(context.projectRoot))
          } catch {
            // Non-Git projects still support root-relative links.
            projectRelativePath = ''
          }
        }
        return await resolveFileReferences(candidates, root, {
          projectRoot: context.projectRoot,
          managedProjectRoot: dirname(currentWorktreePath),
          projectRelativePath,
        })
      })
    },
  )
}
