import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { ipcMain, type BrowserWindow } from 'electron'
import {
  assertMainFrameSender,
  parseIpcArgs,
  zPathString,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { isResolvedPathInsideRoot, resolvePathWithinRoot } from '../services/workspace.ts'
import { gatewayReadFile } from '../project-sandbox/sandbox-fs-client.ts'
import { FS_WATCH_MAX_CONTENT_BYTES } from '../services/fs-watch-limits.ts'
import { isActiveSshWorkspace } from '../services/ssh-workspace/execution-target.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import { z } from 'zod'
import { broadcastToAppWindows } from '../windows/app-window-broadcast.ts'

const watchers = new Map<string, fs.FSWatcher>()
const watcherArgs = z.tuple([zProjectId, zThreadId, zPathString])

function watcherKey(projectId: string, threadId: string, relPath: string): string {
  return `${projectId}\0${threadId}\0${relPath}`
}

export function initFsWatcher(win: BrowserWindow): void {
  ipcMain.handle('fs:watch', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, rel] = parseIpcArgs(watcherArgs, rawArgs)
    // Node's fs.watch can only observe the local machine. Remote workspaces do
    // not claim live external-edit updates until they have a remote watcher.
    if (isActiveSshWorkspace()) return
    const root = (await resolveThreadExecutionContext(projectId, threadId)).root
    const abs = await resolvePathWithinRoot(rel, root)
    const key = watcherKey(projectId, threadId, rel)
    if (watchers.has(key)) return
    let debounce: ReturnType<typeof setTimeout> | undefined
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(abs, { persistent: false }, () => {
        clearTimeout(debounce)
        debounce = setTimeout(() => {
          void notifyFileChanged(projectId, threadId, rel, abs, root)
        }, 200)
      })
    } catch (err) {
      console.warn('[copse-panel] file watcher unavailable for', rel, err)
      return
    }
    // Deleted or unreadable files emit `error`. Without a listener that is an
    // uncaught exception in the main process — the same crash class as a
    // retired worktree's recursive watch.
    watcher.on('error', (err: unknown) => {
      console.warn('[copse-panel] file watcher failed for', rel, err)
      clearTimeout(debounce)
      watchers.get(key)?.close()
      watchers.delete(key)
    })
    watchers.set(key, watcher)
  })

  ipcMain.handle('fs:unwatch', (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, rel] = parseIpcArgs(watcherArgs, rawArgs)
    if (isActiveSshWorkspace()) return
    const key = watcherKey(projectId, threadId, rel)
    watchers.get(key)?.close()
    watchers.delete(key)
  })
}

async function notifyFileChanged(
  projectId: string,
  threadId: string,
  relPath: string,
  absPath: string,
  root: string,
): Promise<void> {
  try {
    // TOCTOU guard: `absPath` was containment-checked once at watch
    // registration, but `fs.watch` follows the live filesystem. Re-resolve the
    // real on-disk location and skip the event if a swapped symlink now points
    // outside the workspace.
    if (!(await isResolvedPathInsideRoot(absPath, root))) return
    const st = await fsp.stat(absPath)
    if (!st.isFile()) return
    if (st.size > FS_WATCH_MAX_CONTENT_BYTES) {
      broadcastToAppWindows('fs:changed', projectId, threadId, relPath, null)
      return
    }
    const content = await gatewayReadFile(absPath, root)
    broadcastToAppWindows('fs:changed', projectId, threadId, relPath, content)
  } catch {
    /* ignore missing/unreadable files */
  }
}

export function closeAllWatchers(): void {
  watchers.forEach((w) => {
    w.close()
  })
  watchers.clear()
}
