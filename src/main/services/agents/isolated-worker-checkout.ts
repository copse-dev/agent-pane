import { randomUUID } from 'node:crypto'
import { errorMessage } from '@shared/errors.ts'
import type { ThreadWorktree } from '@shared/types/worktree.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { saveProjectThread, updateMetaOrThrow, appendMessage } from '../thread-store.ts'
import { getSetting } from '../storage/settings.ts'
import { withThreadResourceFence } from '../thread-resource-fence.ts'
import { getCurrentBranchName } from '../github/git-service.ts'
import {
  allocateThreadWorktree,
  validateThreadWorktree,
  retireThreadWorktree,
  WorktreeAllocationError,
} from '../worktree-manager.ts'
import { isolatedWorkerScope, withIsolatedWorkerDispatchSlot } from './isolated-worker-scope.ts'
import type { ReadonlyWorkerRequest } from './readonly-worker-batch.ts'

export interface WorkerCheckout {
  threadId: string
  path: string
  branch: string
  cleanup: 'pending' | 'retained' | 'removed'
  error?: string
}

// Use the same allocation, validation, persistence and conservative retirement
// boundaries as ordinary thread checkouts. Injection is at those boundaries.
export interface WorkerCheckoutDependencies {
  allocate: typeof allocateThreadWorktree
  validate: typeof validateThreadWorktree
  retire: typeof retireThreadWorktree
  save: typeof saveProjectThread
  update: typeof updateMetaOrThrow
  append: typeof appendMessage
  detachedHooksEnabled: () => boolean
  withDispatchSlot: typeof withIsolatedWorkerDispatchSlot
  branch: typeof getCurrentBranchName
}
const defaults: WorkerCheckoutDependencies = {
  allocate: allocateThreadWorktree,
  validate: validateThreadWorktree,
  retire: retireThreadWorktree,
  save: saveProjectThread,
  update: updateMetaOrThrow,
  append: appendMessage,
  branch: getCurrentBranchName,
  detachedHooksEnabled: () => getSetting<boolean>('cursorHooksEnabled', false),
  withDispatchSlot: withIsolatedWorkerDispatchSlot,
}

/** Cleanup is deliberately inside the handler, never triggered by a terminal task notification. */
export async function runInIsolatedWorkerCheckout(
  options: {
    parent: ThreadExecutionContext
    workerId: string
    request: ReadonlyWorkerRequest
    signal: AbortSignal
    onCheckout: (checkout: WorkerCheckout) => void
    execute: () => Promise<string>
  },
  dependencies: WorkerCheckoutDependencies = defaults,
): Promise<string> {
  const { parent, workerId, request, signal, onCheckout, execute } = options
  const childOwner = { projectId: parent.projectId, threadId: workerId }
  // Prevent archive/checkout preparation from deleting or moving a live worker's
  // checkout. This worker offers no process-spawn tools that acquire this fence.
  return dependencies.withDispatchSlot(childOwner, () =>
    withThreadResourceFence(childOwner, async () => {
      signal.throwIfAborted()
      const detachedHooksAtStart = dependencies.detachedHooksEnabled()
      const baseBranch = parent.branch ?? (await dependencies.branch(parent.root))
      if (!baseBranch) throw new Error('Isolated workers require a local Git branch.')
      await dependencies.save(parent.projectId, {
        id: workerId,
        title: `Worker: ${request.agent}`,
        status: 'running',
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        worktreeChoice: 'worktree',
        messages: [
          {
            id: randomUUID(),
            role: 'user',
            toolCalls: [],
            createdAt: Date.now(),
            content: `Worker for chat ${parent.threadId}: ${request.agent}\n\n${request.prompt}`,
          },
        ],
      })
      let worktree: ThreadWorktree | undefined
      let checkout: WorkerCheckout | undefined
      let succeeded = false
      const lifecycle = { ownershipPersisted: false, allocationRecovery: false }
      const persistOwnership = async (allocated: ThreadWorktree): Promise<void> => {
        worktree = allocated
        checkout = {
          threadId: workerId,
          path: allocated.path,
          branch: allocated.branch,
          cleanup: 'pending',
        }
        onCheckout(checkout)
        await dependencies.update(parent.projectId, workerId, {
          worktree: allocated,
          gitBranch: allocated.branch,
        })
        lifecycle.ownershipPersisted = true
      }
      try {
        signal.throwIfAborted()
        try {
          await persistOwnership(
            await dependencies.allocate({
              ...childOwner,
              projectRoot: parent.root,
              prompt: request.prompt,
              baseBranch,
              branchTitle: `worker ${request.agent}`,
              seedFromDirtyProject: true,
            }),
          )
        } catch (error) {
          if (error instanceof WorktreeAllocationError && error.recovery) {
            lifecycle.allocationRecovery = true
            await persistOwnership(error.recovery.worktree)
            await dependencies.append(parent.projectId, workerId, {
              id: randomUUID(),
              role: 'error',
              toolCalls: [],
              createdAt: Date.now(),
              content: `Worker allocation stopped before snapshot restoration completed. Retained ${error.recovery.worktree.path}; recover the seed from ${error.recovery.snapshotRef}.`,
            })
          }
          throw error
        }
        signal.throwIfAborted()
        if (!worktree) throw new Error('Worker checkout was not allocated.')
        const validated = await dependencies.validate({
          ...childOwner,
          projectRoot: parent.projectRoot,
          worktree,
        })
        const context: ThreadExecutionContext = {
          ...childOwner,
          projectRoot: parent.projectRoot,
          root: validated.root,
          branch: validated.branch,
          checkoutMode: 'worktree',
        }
        const report = await runWithThreadExecutionContext(context, () =>
          isolatedWorkerScope.run(true, execute),
        )
        signal.throwIfAborted()
        await dependencies.append(parent.projectId, workerId, {
          id: randomUUID(),
          role: 'assistant',
          content: report,
          toolCalls: [],
          createdAt: Date.now(),
        })
        succeeded = true
        return report
      } finally {
        // Allocation itself is not abortable. A cancellation during it must still
        // persist the returned owner before inspecting or retiring its checkout.
        if (worktree && checkout) {
          checkout.cleanup = 'retained'
          // Completion notifications are detached by contract, never drained here.
          // Retain their checkout even if it currently appears clean; discovery
          // or a queued command can still be waiting to touch it.
          if (
            lifecycle.ownershipPersisted &&
            !lifecycle.allocationRecovery &&
            !detachedHooksAtStart &&
            !dependencies.detachedHooksEnabled()
          ) {
            try {
              const result = await dependencies.retire({
                ...childOwner,
                projectRoot: parent.projectRoot,
                worktree,
              })
              if (result.status === 'removed') {
                await dependencies.update(parent.projectId, workerId, {
                  worktree: { ...worktree, retiredAt: Date.now() },
                  archivedAt: Date.now(),
                })
                checkout.cleanup = 'removed'
              }
            } catch (error) {
              // Inspection/persistence failure must preserve the recovery record.
              checkout.error = errorMessage(error)
            }
          }
        }
        await dependencies.update(parent.projectId, workerId, {
          status: succeeded && !signal.aborted ? 'idle' : 'error',
          updatedAt: Date.now(),
        })
      }
    }),
  )
}
