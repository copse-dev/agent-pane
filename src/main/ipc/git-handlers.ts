import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import { hasBackgroundProcessesForThread } from '../services/exec/background-process.ts'
import {
  assertMainFrameSender,
  parseIpcArgs,
  zGitBranchName,
  zPathString,
  zProjectId,
  zThreadId,
} from './ipc-guards.ts'
import { threadPathArgs } from './thread-path-args.ts'
import {
  inspectThreadCheckoutAttachment,
  inspectThreadCheckoutRoot,
  reattachThreadCheckout,
  restoreThreadCheckout,
} from '../services/thread-execution-context.ts'
import {
  checkoutThreadGitBranch,
  resolveWatchedGitExecutionRoot,
  resolveWatchedGitRoot,
} from '../services/thread-git-roots.ts'
import { listRunningThreadIds } from '../services/agent-service.ts'
import {
  getBranches,
  getCommittedChanges,
  getCommittedFileDiff,
  getCurrentBranchName,
  getDefaultBranch,
  getGitChangeStats,
  getGitFileDiff,
  getGitPromptState,
  getGitStatus,
  readThreadChangeSummary,
  getGitWorkingFileDiff,
  isInsideGitWorkTree,
  resetDefaultBranchCache,
} from '../services/github/git-service.ts'
import { createThreadChangeSummaryReader } from '../services/github/thread-change-summary.ts'
import {
  branchHasOpenPr,
  branchMergedThrough,
  getGitBranchStatus,
} from '../services/github/pr-context-service.ts'
import { getRestorableSessionBackup, restoreSessionBackup } from '../services/worktree-backup.ts'
import { isGitAvailableForTarget } from '../services/tool-availability.ts'

export function registerGitHandlers(
  win: BrowserWindow,
  isDispatcherThreadActive: (projectId: string, threadId: string) => boolean,
): void {
  const threadOwnerArgs = z.tuple([zProjectId, zThreadId])

  ipcMain.handle('git:is-available', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    const root = await resolveWatchedGitRoot(projectId, threadId)
    return (await isGitAvailableForTarget()) && (await isInsideGitWorkTree(root))
  })
  ipcMain.handle('git:status', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getGitStatus(await resolveWatchedGitRoot(projectId, threadId))
  })
  // Inspect-only: resolves each thread's checkout without restoring worktrees, syncing
  // metadata, or ensureWorkingTreeWatched.
  const readThreadChangeSummaries = createThreadChangeSummaryReader({
    resolveRoot: inspectThreadCheckoutRoot,
    read: readThreadChangeSummary,
  })
  ipcMain.handle('git:thread-change-summary', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [refs, opts] = parseIpcArgs(
      z.tuple([
        z.array(z.object({ projectId: zProjectId, threadId: zThreadId })).max(200),
        z.object({ fresh: z.boolean().optional() }).optional(),
      ]),
      rawArgs,
    )
    return readThreadChangeSummaries(refs, opts?.fresh === true ? { fresh: true } : {})
  })
  ipcMain.handle('git:change-stats', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    const root = await resolveWatchedGitRoot(projectId, threadId)
    return getGitChangeStats(root, {
      includeCommitted: true,
      hasOpenPr: (branch) => branchHasOpenPr(projectId, branch, root),
      mergedThrough: (branch) => branchMergedThrough(projectId, branch, root),
    })
  })
  ipcMain.handle('git:file-diff', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, filePath, isStaged] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zPathString, z.boolean()]),
      rawArgs,
    )
    const root = await resolveWatchedGitRoot(projectId, threadId)
    return getGitFileDiff(filePath, isStaged, root)
  })
  ipcMain.handle('git:committed-changes', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    const root = await resolveWatchedGitRoot(projectId, threadId)
    return getCommittedChanges(root, {
      hasOpenPr: (branch) => branchHasOpenPr(projectId, branch, root),
      mergedThrough: (branch) => branchMergedThrough(projectId, branch, root),
    })
  })
  ipcMain.handle('git:committed-file-diff', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, filePath] = parseIpcArgs(threadPathArgs, rawArgs)
    const root = await resolveWatchedGitRoot(projectId, threadId)
    return getCommittedFileDiff(filePath, root, {
      hasOpenPr: (branch) => branchHasOpenPr(projectId, branch, root),
      mergedThrough: (branch) => branchMergedThrough(projectId, branch, root),
    })
  })
  ipcMain.handle('git:working-file-diff', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, filePath] = parseIpcArgs(threadPathArgs, rawArgs)
    const root = await resolveWatchedGitRoot(projectId, threadId)
    return getGitWorkingFileDiff(filePath, root)
  })
  ipcMain.handle('git:current-branch', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getCurrentBranchName(await resolveWatchedGitRoot(projectId, threadId))
  })
  ipcMain.handle('git:branch-status', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    // Git-ref charset only, no leading dash: the branch reaches `gh pr list
    // --head <branch>` and must never be option-shaped (#580).
    const [projectId, threadId, branch] = parseIpcArgs(
      z.tuple([
        zProjectId,
        zThreadId,
        z
          .string()
          .max(256)
          .regex(/^[A-Za-z0-9_][A-Za-z0-9_\-./]*$/)
          .optional(),
      ]),
      rawArgs,
    )
    const root = await resolveWatchedGitRoot(projectId, threadId)
    return getGitBranchStatus(projectId, branch, root)
  })
  const threadCheckoutBusy = (projectId: string, threadId: string): boolean =>
    isDispatcherThreadActive(projectId, threadId) ||
    listRunningThreadIds().includes(threadId) ||
    hasBackgroundProcessesForThread({ projectId, threadId })
  ipcMain.handle('git:worktree-attachment', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return inspectThreadCheckoutAttachment(projectId, threadId, threadCheckoutBusy)
  })
  ipcMain.handle('git:reattach-worktree', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return reattachThreadCheckout(projectId, threadId, threadCheckoutBusy)
  })
  ipcMain.handle('git:restore-worktree', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return restoreThreadCheckout(projectId, threadId, threadCheckoutBusy)
  })
  ipcMain.handle('git:prompt-state', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getGitPromptState(await resolveWatchedGitExecutionRoot(projectId, threadId))
  })
  ipcMain.handle('git:checkout-branch', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId, targetBranch] = parseIpcArgs(
      z.tuple([zProjectId, zThreadId, zGitBranchName]),
      rawArgs,
    )
    await checkoutThreadGitBranch(projectId, threadId, targetBranch)
  })
  ipcMain.handle('git:list-branches', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getBranches(await resolveWatchedGitRoot(projectId, threadId))
  })
  ipcMain.handle('agent:reset-default-branch-cache', (event) => {
    assertMainFrameSender(event, win)
    resetDefaultBranchCache()
  })
  ipcMain.handle('git:get-default-branch', async (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [projectId, threadId] = parseIpcArgs(threadOwnerArgs, rawArgs)
    return getDefaultBranch(await resolveWatchedGitRoot(projectId, threadId))
  })
  ipcMain.handle(
    'git:session-backup',
    async (event, projectIdArg: unknown, threadIdArg: unknown) => {
      assertMainFrameSender(event, win)
      const projectId = parseIpcArgs(zProjectId, [projectIdArg])
      const threadId = parseIpcArgs(zThreadId, [threadIdArg])
      return getRestorableSessionBackup(
        { projectId, threadId },
        await resolveWatchedGitRoot(projectId, threadId),
      )
    },
  )
  ipcMain.handle(
    'git:restore-backup',
    async (event, projectIdArg: unknown, threadIdArg: unknown) => {
      assertMainFrameSender(event, win)
      const projectId = parseIpcArgs(zProjectId, [projectIdArg])
      const threadId = parseIpcArgs(zThreadId, [threadIdArg])
      return restoreSessionBackup(
        { projectId, threadId },
        await resolveWatchedGitRoot(projectId, threadId),
      )
    },
  )
}
