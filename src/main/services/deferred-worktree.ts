import type { McpToolAnnotations } from '@shared/types/mcp.ts'
import type { PreparedThreadCheckout, ThreadWorktree } from '@shared/types/worktree.ts'
import { toolNeedsWritableCheckout } from '@shared/tools/deferred-checkout-tools.ts'
import { isRecord } from '@copse/std/unknown-value.ts'
import { isProjectSandboxEnabled } from '../project-sandbox/index.ts'
import { shellRunsOutsideSandbox } from './security/command-routing-config.ts'
import {
  allocateDeferredThreadWorktree,
  type AllocateDeferredWorktreeInput,
} from './thread-checkout-transaction.ts'
import {
  adoptUpgradedThreadExecutionContext,
  getThreadExecutionContext,
  resolveThreadExecutionContext,
  type ThreadExecutionContext,
} from './thread-execution-context.ts'
import { startExecutionRootIndexing } from './search/workspace-indexing.ts'
import { getChangedPathsBetween, getCurrentCommitHash, getGitStatus } from './github/git-service.ts'

/** What the deferred turn had been reading when it asked to write. */
export interface ProjectReadState {
  head: string | null
  dirtyPaths: string[]
}

export interface DeferredWorktreeDependencies {
  allocate: (input: AllocateDeferredWorktreeInput) => Promise<PreparedThreadCheckout>
  resolve: (projectId: string, threadId: string) => Promise<ThreadExecutionContext>
  adopt: (context: ThreadExecutionContext) => void
  startIndexing: (root: string) => void
  readProjectState: (projectRoot: string) => Promise<ProjectReadState>
  changedPaths: (root: string, from: string, to: string) => Promise<string[] | null>
}

/** A just-performed allocation, with how it differs from what the turn read. */
export interface DeferredWorktreeAllocation {
  worktree: ThreadWorktree
  prepared: PreparedThreadCheckout
  projectRoot: string
  readHead: string | null
  /** Files whose committed content differs between `readHead` and the worktree base. */
  changedSinceRead: string[] | null
  /** Uncommitted project files the turn could see; carried over only when seeded. */
  uncommittedAtRead: string[]
}

export interface WriteAccessGrant {
  context: ThreadExecutionContext
  /** Present only on the call that performed the allocation. */
  allocation?: DeferredWorktreeAllocation
}

async function readProjectState(projectRoot: string): Promise<ProjectReadState> {
  const [head, status] = await Promise.all([
    getCurrentCommitHash(projectRoot),
    getGitStatus(projectRoot),
  ])
  const dirty = new Set<string>()
  for (const change of [...(status?.staged ?? []), ...(status?.unstaged ?? [])]) {
    dirty.add(change.path)
  }
  return { head, dirtyPaths: [...dirty].sort() }
}

const defaultDependencies: DeferredWorktreeDependencies = {
  allocate: allocateDeferredThreadWorktree,
  resolve: resolveThreadExecutionContext,
  adopt: adoptUpgradedThreadExecutionContext,
  startIndexing: startExecutionRootIndexing,
  readProjectState,
  changedPaths: getChangedPathsBetween,
}

type AllocationListener = (prepared: PreparedThreadCheckout) => void
const listeners = new Map<string, AllocationListener>()

/**
 * Forward a mid-turn allocation to whoever is streaming this thread's turn, so
 * the renderer re-roots its file tree, changes pane, and branch chip without
 * waiting for the turn to end. Returns the unsubscribe.
 */
export function onDeferredWorktreeAllocated(
  threadId: string,
  listener: AllocationListener,
): () => void {
  listeners.set(threadId, listener)
  return () => {
    if (listeners.get(threadId) === listener) listeners.delete(threadId)
  }
}

export function createEnsureWritableThreadCheckout(
  dependencies: DeferredWorktreeDependencies,
): (options?: { branchTitle?: string }) => Promise<WriteAccessGrant | null> {
  return async (options = {}) => {
    const context = getThreadExecutionContext()
    if (!context) return null
    if (!context.deferredWorktree) return { context }

    const { projectId, threadId, projectRoot } = context
    const readState = await dependencies.readProjectState(projectRoot)
    const prepared = await dependencies.allocate({
      projectId,
      threadId,
      ...(options.branchTitle ? { branchTitle: options.branchTitle } : {}),
    })
    const worktree = prepared.worktree
    if (!worktree) throw new Error('Worktree allocation returned no checkout')

    // A renderer IPC may have had a resolution in flight from before the
    // metadata write; that one settles to the old shared view. Resolution
    // flights are only shared while concurrent, so one retry reads fresh meta.
    let upgraded = await dependencies.resolve(projectId, threadId)
    if (upgraded.checkoutMode !== 'worktree') {
      upgraded = await dependencies.resolve(projectId, threadId)
    }
    dependencies.adopt(upgraded)
    dependencies.startIndexing(upgraded.root)
    listeners.get(threadId)?.(prepared)

    // Only the call that actually allocated reports it. A parallel call that
    // found the worktree already there is served the idempotent branch, which
    // carries no `deferredWorktree`.
    if (!prepared.deferredWorktree) return { context: upgraded }
    const changedSinceRead =
      readState.head === null
        ? null
        : readState.head === worktree.baseCommit
          ? []
          : await dependencies.changedPaths(upgraded.root, readState.head, worktree.baseCommit)
    return {
      context: upgraded,
      allocation: {
        worktree,
        prepared,
        projectRoot,
        readHead: readState.head,
        changedSinceRead,
        uncommittedAtRead: readState.dirtyPaths,
      },
    }
  }
}

export const ensureWritableThreadCheckout = createEnsureWritableThreadCheckout(defaultDependencies)

const LISTED_PATHS = 20

function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, LISTED_PATHS).map((path) => `  - ${path}`)
  if (paths.length > LISTED_PATHS)
    shown.push(`  - …and ${String(paths.length - LISTED_PATHS)} more`)
  return shown.join('\n')
}

/**
 * Model-facing account of a mid-turn allocation. Its job is to keep the
 * agent's picture of the code honest across the switch: which directory is
 * now authoritative, and exactly which files it read may not match what the
 * worktree holds.
 */
export function describeWriteAccessGrant(grant: WriteAccessGrant): string {
  const { context, allocation } = grant
  if (!allocation) {
    return context.checkoutMode === 'worktree'
      ? `This thread already writes in its own worktree at ${context.root} on branch ${context.branch ?? '(detached)'}.`
      : `This thread already has write access to ${context.root}.`
  }
  const { worktree, projectRoot, readHead, changedSinceRead, uncommittedAtRead } = allocation
  const lines = [
    `This thread now has its own worktree at ${context.root} on branch ${worktree.branch}, cut from ${worktree.baseBranch} at ${worktree.baseCommit.slice(0, 12)}.`,
    `All file, git, and shell tools now resolve against that worktree. Prefer paths relative to it. File tools treat an absolute path under ${projectRoot} (the user's checkout) as the same file in the worktree, but shell commands do not: in the shell that path is still the user's checkout and will not show your edits.`,
  ]
  if (changedSinceRead === null) {
    lines.push(
      `Could not compare the commit you were reading (${readHead?.slice(0, 12) ?? 'unknown'}) with the worktree base. Re-read files before editing them.`,
    )
  } else if (changedSinceRead.length > 0) {
    lines.push(
      `You were reading ${readHead?.slice(0, 12) ?? 'the checkout'}; the worktree base differs in ${String(changedSinceRead.length)} file(s). Re-read these before editing them:\n${listPaths(changedSinceRead)}`,
    )
  }
  if (uncommittedAtRead.length > 0) {
    lines.push(
      worktree.seededFromDirtyProject
        ? `The user's uncommitted changes (${String(uncommittedAtRead.length)} file(s)) were copied into the worktree, so what you read is what you have.`
        : `The user's checkout had uncommitted changes you may have read; they were NOT copied into the worktree, which starts clean at its base:\n${listPaths(uncommittedAtRead)}`,
    )
  }
  return lines.join('\n\n')
}

/** Shell routing facts for the deferred-checkout decision, from the raw arguments. */
function shellFacts(args: unknown): {
  sandboxEnabled: boolean
  runsOutsideSandbox: boolean
  expectsSandboxBlock: boolean
} | null {
  if (!isRecord(args)) return null
  const command = args['command']
  if (typeof command !== 'string') return null
  return {
    sandboxEnabled: isProjectSandboxEnabled(),
    runsOutsideSandbox: shellRunsOutsideSandbox(command),
    expectsSandboxBlock: args['expects_sandbox_block'] === true,
  }
}

/**
 * Registry hook: before a tool runs in a deferred thread, allocate the worktree
 * if the tool may write. Returns the model-facing note when this call caused
 * the allocation, so the tool's own result can carry it; null otherwise.
 */
export async function prepareCheckoutForTool(
  toolName: string,
  args: unknown,
  mcpAnnotations: McpToolAnnotations | undefined,
): Promise<string | null> {
  const shell = toolName === 'run_shell' ? shellFacts(args) : null
  const needsWrite = toolNeedsWritableCheckout({
    toolName,
    mcpAnnotations,
    ...(shell ? { shell } : {}),
  })
  if (!needsWrite) return null
  const grant = await ensureWritableThreadCheckout()
  return grant?.allocation ? describeWriteAccessGrant(grant) : null
}
