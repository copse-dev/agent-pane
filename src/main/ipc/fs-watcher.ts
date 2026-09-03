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
import {
  isActiveSshWorkspace,
  resolveSshExecutionTargetForCwd,
} from '../services/ssh-workspace/execution-target.ts'
import {
  stopRemoteFilePolling,
  unwatchRemotePath,
  watchRemotePath,
} from '../services/ssh-workspace/remote-file-poller.ts'
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
    const root = (await resolveThreadExecutionContext(projectId, threadId)).root
    const abs = await resolvePathWithinRoot(rel, root)
    const key = watcherKey(projectId, threadId, rel)
    // Node's fs.watch can only observe the local machine, so a remote workspace
    // must never reach the local watcher below — an unresolvable host means no
    // updates rather than a watch on a same-named local path.
    if (isActiveSshWorkspace()) {
      const target = resolveSshExecutionTargetForCwd(root)
      if (target?.kind !== 'ssh') return
      watchRemotePath(
        key,
        { hostId: target.hostId, remoteRoot: root, absPath: abs },
        (_k, size) => {
          void notifyRemoteFileChanged(projectId, threadId, rel, abs, root, size)
        },
      )
      return
    }
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
    const key = watcherKey(projectId, threadId, rel)
    if (isActiveSshWorkspace()) {
      unwatchRemotePath(key)
      return
    }
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

/**
 * Remote counterpart of {@link notifyFileChanged}.
 *
 * Separate because the poll already carries the size, and because the local
 * version's `fsp.stat` would stat a *local* path that may not exist (or worse,
 * may exist and be unrelated). The containment re-check is kept: it runs
 * through the active path backend, so on a remote workspace it re-resolves over
 * SSH and still catches a symlink swapped to point outside the root.
 */
async function notifyRemoteFileChanged(
  projectId: string,
  threadId: string,
  relPath: string,
  absPath: string,
  root: string,
  size: number,
): Promise<void> {
  try {
    if (!(await isResolvedPathInsideRoot(absPath, root))) return
    if (size > FS_WATCH_MAX_CONTENT_BYTES) {
      broadcastToAppWindows('fs:changed', projectId, threadId, relPath, null)
      return
    }
    const content = await gatewayReadFile(absPath, root)
    broadcastToAppWindows('fs:changed', projectId, threadId, relPath, content)
  } catch {
    /* ignore unreadable files — the next tick retries */
  }
}

export function closeAllWatchers(): void {
  watchers.forEach((w) => {
    w.close()
  })
  watchers.clear()
  stopRemoteFilePolling()
}
