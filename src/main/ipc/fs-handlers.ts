import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'
import { resolvePathWithinRoot } from '../services/workspace.ts'
import {
  assertFsWriteContent,
  assertMainFrameSender,
  parseIpcArgs,
  zPathString,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { threadPathArgs } from './thread-path-args.ts'
import {
  resolveThreadExecutionContext,
  runWithThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { scheduleIndexRebuild } from '../services/search/workspace-index-watcher.ts'
import {
  gatewayListDir,
  gatewayReadFile,
  gatewayReadImage,
  gatewayReaddir,
  gatewayWriteFile,
} from '../project-sandbox/sandbox-fs-client.ts'

export function registerFsHandlers(win: BrowserWindow): void {
  ipcMain.handle('fs:read-file', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, root)
    return gatewayReadFile(abs, root)
  })

  ipcMain.handle('fs:read-image', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    // Missing or oversized previews are routine (a thread can outlive its worktree
    // files), so report them as data; a rejected handler makes Electron log a stack.
    try {
      const { root } = await resolveThreadExecutionContext(projectId, threadId)
      const abs = await resolvePathWithinRoot(relPath, root)
      return { ok: true, data: await gatewayReadImage(abs, root, relPath) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('fs:write-file', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath, content] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zPathString, z.string()]),
      rawArgs,
    )
    assertFsWriteContent(content)
    const context = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, context.root)
    await gatewayWriteFile(abs, content, context.root)
    runWithThreadExecutionContext(context, () => {
      scheduleIndexRebuild(context.root)
    })
  })

  ipcMain.handle('fs:readdir', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(threadPathArgs, rawArgs)
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(relPath, root)
    return gatewayReaddir(abs, root)
  })

  ipcMain.handle('fs:list-dir', async (event, projectIdArg, threadIdArg, pathArg) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, relPath] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zPathString.optional()]),
      [projectIdArg, threadIdArg, pathArg],
    )
    const { root } = await resolveThreadExecutionContext(projectId, threadId)
    const abs = await resolvePathWithinRoot(nonEmptyStringOr(relPath, '.'), root)
    const dirents = await gatewayListDir(abs, root)
    return dirents
      .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  })
}
