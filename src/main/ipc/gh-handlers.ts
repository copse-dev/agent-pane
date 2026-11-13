import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { z } from 'zod'
import { prRefSchema } from '@shared/git/thread-pr-relations.ts'
import { defineHandler, defineSenderHandler } from './define-handler.ts'
import {
  defineSenderRootHandler,
  senderProjectId,
  senderProjectRoot,
} from './sender-project-root.ts'
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
import {
  getCurrentBranchName,
  getDefaultBranch,
  getGithubRepoSlug,
} from '../services/github/git-service.ts'
import { confirmNativeAction } from '../services/native-human-confirmation.ts'
import { listProjectAgentPrLinks } from '../services/remote/remote-agent-link-store.ts'
import { resolveThreadExecutionContext } from '../services/thread-execution-context.ts'
import {
  lookupPrThreadRelationships,
  lookupThreadPrRelationships,
} from '../services/thread-store.ts'

/**
 * The project-scoped PR lookups behind `gh:agent-pr-links` and the PR/thread
 * relationship channels. Each reads the project `projectOf` names for its
 * sender (the asking window's, in production), never the process-global active
 * project, so two windows on two projects each see their own (#3958).
 */
type AgentPrLinks = ReturnType<typeof listProjectAgentPrLinks>
type PrThreadRelationships = ReturnType<typeof lookupPrThreadRelationships>
type ThreadPrRelationships = ReturnType<typeof lookupThreadPrRelationships>
type PrRef = Parameters<typeof lookupPrThreadRelationships>[1]

export function senderProjectPrReaders<Sender>(projectOf: (sender: Sender) => string | null): {
  agentPrLinks: (sender: Sender) => AgentPrLinks
  prThreadRelationships: (sender: Sender, pr: PrRef) => PrThreadRelationships
  threadPrRelationships: (sender: Sender, threadId: string) => ThreadPrRelationships
} {
  return {
    agentPrLinks: async (sender): AgentPrLinks => {
      const projectId = projectOf(sender)
      return projectId ? listProjectAgentPrLinks(projectId) : []
    },
    prThreadRelationships: async (sender, pr): PrThreadRelationships => {
      const projectId = projectOf(sender)
      return projectId ? lookupPrThreadRelationships(projectId, pr) : []
    },
    threadPrRelationships: (sender, threadId): ThreadPrRelationships => {
      const projectId = projectOf(sender)
      return projectId ? lookupThreadPrRelationships(projectId, threadId) : Promise.resolve([])
    },
  }
}

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
  // Local-only legacy agent/PR associations; reads thread metadata. These and
  // the relationship lookups below read the asking window's project (#3958).
  const prReaders = senderProjectPrReaders(senderProjectId)
  defineSenderHandler(win, 'gh:agent-pr-links', z.tuple([]), prReaders.agentPrLinks, {
    sender: 'any',
  })
  defineSenderHandler(
    win,
    'gh:pr-thread-relationships',
    z.tuple([prRefSchema]),
    prReaders.prThreadRelationships,
  )
  defineSenderHandler(
    win,
    'gh:thread-pr-relationships',
    z.tuple([z.string().min(1)]),
    prReaders.threadPrRelationships,
  )
  // A renderer proposal needs an OS-owned decision before a GitHub mutation.
  //
  // The "Create PR" chip's second half. Runs the same `createPrForThread` the
  // `gh_pr_create` tool does — trailer, target resolution and thread linking
  // included — so a PR opened from the dialog is indistinguishable from one the
  // agent opened. Main resolves the target and asks for an OS-owned decision.
  // The decoder admits only title/body/draft; head, base, owner and repo come
  // from the thread's checkout inside `createPrForThread`, never the renderer.
  defineSenderHandler(
    win,
    'gh:create-pr-for-thread',
    ghCreatePrForThreadArgs,
    async (sender, projectId, threadId, request) => {
      const context = await resolveThreadExecutionContext(projectId, threadId)
      const workspaceRepo = await getGithubRepoSlug(context.root)
      const target = workspaceRepo ?? '(unknown)'
      const head = await getCurrentBranchName(context.root)
      const base = await getDefaultBranch(context.root)
      if (
        !(await confirmNativeAction(sender, {
          title: 'Create GitHub pull request?',
          detail: `Publish a pull request from ${JSON.stringify(context.root)}?\n\nRepository: ${target}\nHead: ${head ?? '(unknown)'}\nBase: ${base ?? '(unknown)'}\nDraft: ${request.draft === true ? 'yes' : 'no'}\nTitle: ${request.title}\n\nBody:\n${request.body ?? ''}`,
          approveLabel: 'Create pull request',
        }))
      )
        throw new Error('Pull request creation was not confirmed')
      return createPrForThread(request, context)
    },
    { errors: 'per-argument' },
  )
  defineSenderHandler(
    win,
    'gh:rerun-failed-runs',
    ghPrRefArgs,
    async (sender, owner, repo, number) => {
      const root = senderProjectRoot(sender)
      if (
        !(await confirmNativeAction(sender, {
          title: 'Rerun GitHub checks?',
          detail: `Rerun failed checks for ${owner}/${repo}#${String(number)}?`,
        }))
      )
        throw new Error('GitHub check rerun was not confirmed')
      return rerunFailedPrRuns(root, { owner, repo, number })
    },
    { errors: 'per-argument' },
  )
  defineSenderHandler(
    win,
    'gh:approve-pr',
    ghPrRefArgs,
    async (sender, owner, repo, number) => {
      const root = senderProjectRoot(sender)
      if (
        !(await confirmNativeAction(sender, {
          title: 'Approve GitHub pull request?',
          detail: `Submit your approval on ${owner}/${repo}#${String(number)}?`,
          approveLabel: 'Approve pull request',
        }))
      )
        throw new Error('Pull request approval was not confirmed')
      return approvePr(root, { owner, repo, number })
    },
    { errors: 'per-argument' },
  )
  defineSenderHandler(
    win,
    'gh:mark-pr-ready',
    ghPrRefArgs,
    async (sender, owner, repo, number) => {
      const root = senderProjectRoot(sender)
      if (
        !(await confirmNativeAction(sender, {
          title: 'Mark GitHub pull request ready?',
          detail: `Mark ${owner}/${repo}#${String(number)} ready for review?`,
        }))
      )
        throw new Error('Marking pull request ready was not confirmed')
      return markPrReady(root, { owner, repo, number })
    },
    { errors: 'per-argument' },
  )
  defineSenderHandler(
    win,
    'gh:enable-auto-merge',
    ghPrRefArgs,
    async (sender, owner, repo, number) => {
      const root = senderProjectRoot(sender)
      if (
        !(await confirmNativeAction(sender, {
          title: 'Enable GitHub auto-merge?',
          detail: `Automatically merge ${owner}/${repo}#${String(number)} when checks pass?`,
          approveLabel: 'Enable auto-merge',
        }))
      )
        throw new Error('Auto-merge was not confirmed')
      return enablePrAutoMerge(root, { owner, repo, number })
    },
    { errors: 'per-argument' },
  )
}
