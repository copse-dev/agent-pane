import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { z } from 'zod'
import { prRefSchema } from '@shared/git/thread-pr-relations.ts'
import { defineHandler } from './define-handler.ts'
import { defineSenderRootHandler } from './sender-project-root.ts'
import { ghCreatePrForThreadArgs, ghPrFileDiffArgs, ghPrRefArgs } from './gh-handler-args.ts'
import { assertMainFrameSender, parseIpcArgs } from './ipc-guards.ts'
import {
  getGhCliStatus,
  getGhPrChecksState,
  getGhPrDetails,
  getGhPrFileDiff,
  invalidateGithubReadCache,
  listMyOpenPrs,
  listWorkspaceOpenPrs,
  resolveGithubPrRef,
} from '../services/github/gh-pr-service.ts'
import {
  notifyGitHubListWatchers,
  setGitHubListWatch,
} from '../services/github/backend/github-list-watch.ts'
import {
  approvePr,
  enablePrAutoMerge,
  markPrReady,
  rerunFailedPrRuns,
} from '../services/github/gh-pr-actions-service.ts'
import { createPrForThread } from '../services/github/pr-create-service.ts'
import { listActiveProjectAgentPrLinks } from '../services/remote/remote-agent-link-store.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import { getActiveProjectId } from '../services/workspace.ts'
import {
  lookupPrThreadRelationships,
  lookupThreadPrRelationships,
} from '../services/thread-store.ts'

export function registerGhHandlers(win: BrowserWindow): void {
  // PR reads and writes run for the asking window's project (#3958).
  defineSenderRootHandler(win, 'gh:status', z.tuple([]), (root) => getGhCliStatus(root), {
    sender: 'any',
  })
  defineHandler(
    win,
    'gh:invalidate-read-cache',
    z.tuple([]),
    () => {
      invalidateGithubReadCache()
      // Other windows re-read through the now-empty TTL cache instead of waiting
      // up to 30s for the next shared tick.
      notifyGitHubListWatchers()
    },
    { sender: 'any' },
  )
  // Needs `event.sender`, which `defineHandler` does not pass through.
  const listWatchTeardown = new WeakSet<WebContents>()
  ipcMain.handle('gh:set-list-watch', (event, ...rawArgs) => {
    assertMainFrameSender(event, win)
    const [watching, includeMyPrs] = parseIpcArgs(z.tuple([z.boolean(), z.boolean()]), rawArgs)
    if (!listWatchTeardown.has(event.sender)) {
      listWatchTeardown.add(event.sender)
      const watcherId = event.sender.id
      event.sender.once('destroyed', () => {
        setGitHubListWatch(watcherId, false, false)
      })
    }
    setGitHubListWatch(event.sender.id, watching, includeMyPrs)
  })
  defineSenderRootHandler(win, 'gh:list-my-open-prs', z.tuple([]), (root) => listMyOpenPrs(root), {
    sender: 'any',
  })
  defineSenderRootHandler(
    win,
    'gh:list-workspace-open-prs',
    z.tuple([]),
    (root) => listWorkspaceOpenPrs(root),
    { sender: 'any' },
  )
  defineSenderRootHandler(
    win,
    'gh:pr-checks',
    ghPrRefArgs,
    (root, owner, repo, number) => getGhPrChecksState(root, { owner, repo, number }),
    { errors: 'per-argument' },
  )
  defineSenderRootHandler(
    win,
    'gh:pr-details',
    ghPrRefArgs,
    (root, owner, repo, number) => getGhPrDetails(root, { owner, repo, number }),
    { errors: 'per-argument' },
  )
  defineSenderRootHandler(
    win,
    'gh:pr-file-diff',
    ghPrFileDiffArgs,
    (root, owner, repo, number, path) => getGhPrFileDiff(root, { owner, repo, number }, path),
    { errors: 'per-argument' },
  )
  defineHandler(win, 'gh:resolve-pr-url', z.tuple([z.url().max(2048)]), (url) =>
    resolveGithubPrRef(url),
  )
  // Local-only legacy agent/PR associations; reads thread metadata.
  defineHandler(win, 'gh:agent-pr-links', z.tuple([]), () => listActiveProjectAgentPrLinks(), {
    sender: 'any',
  })
  defineHandler(win, 'gh:pr-thread-relationships', z.tuple([prRefSchema]), (pr) => {
    const projectId = getActiveProjectId()
    return projectId ? lookupPrThreadRelationships(projectId, pr) : []
  })
  defineHandler(win, 'gh:thread-pr-relationships', z.tuple([z.string().min(1)]), (threadId) => {
    const projectId = getActiveProjectId()
    return projectId ? lookupThreadPrRelationships(projectId, threadId) : []
  })
  // PR lifecycle write actions. They mutate GitHub state, so each asserts a
  // main-frame sender (the `defineHandler` default) before acting.
  //
  // The "Create PR" chip's second half. Runs the same `createPrForThread` the
  // `gh_pr_create` tool does — trailer, target resolution and thread linking
  // included — so a PR opened from the dialog is indistinguishable from one the
  // agent opened. No model call: by this point the user has settled every
  // argument, and the dialog they just confirmed is the decision to publish.
  // The decoder admits only title/body/draft; head, base, owner and repo come
  // from the thread's checkout inside `createPrForThread`, never the renderer.
  defineHandler(
    win,
    'gh:create-pr-for-thread',
    ghCreatePrForThreadArgs,
    async (projectId, threadId, request) => {
      const context = await resolveThreadExecutionContext(projectId, threadId)
      return createPrForThread(request, context)
    },
    { errors: 'per-argument' },
  )
  defineSenderRootHandler(
    win,
    'gh:rerun-failed-runs',
    ghPrRefArgs,
    (root, owner, repo, number) => rerunFailedPrRuns(root, { owner, repo, number }),
    { errors: 'per-argument' },
  )
  defineSenderRootHandler(
    win,
    'gh:approve-pr',
    ghPrRefArgs,
    (root, owner, repo, number) => approvePr(root, { owner, repo, number }),
    { errors: 'per-argument' },
  )
  defineSenderRootHandler(
    win,
    'gh:mark-pr-ready',
    ghPrRefArgs,
    (root, owner, repo, number) => markPrReady(root, { owner, repo, number }),
    { errors: 'per-argument' },
  )
  defineSenderRootHandler(
    win,
    'gh:enable-auto-merge',
    ghPrRefArgs,
    (root, owner, repo, number) => enablePrAutoMerge(root, { owner, repo, number }),
    { errors: 'per-argument' },
  )
}
