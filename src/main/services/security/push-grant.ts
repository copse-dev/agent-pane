import { getCurrentBranchName, getDefaultBranch } from '../github/git-service.ts'

/**
 * Session-only, thread-scoped grants to fast-forward push a thread's own
 * branch without asking again. The brevet-card threads asked 11 times to push
 * the branch the agent was working on, one click each.
 *
 * A grant covers `git_push` of exactly one branch from one checkout, and only
 * a fast-forward (no `expected_remote_sha`, so no replaced history). It is
 * offered only for the branch checked out where the agent runs, never the
 * repository's default branch, and never when the default branch is unknown.
 * It dies with the process and is never shared between threads.
 */
export interface PushGrantTarget {
  root: string
  branch: string
}

const grants = new Map<string, Set<string>>()

function key(target: PushGrantTarget): string {
  return `${target.root}\0${target.branch}`
}

/**
 * The push a chat grant may cover, or null. `args` is the tool's own input:
 * exactly `{ branch }`, naming the checked-out, non-default branch.
 */
export async function chatPushTarget(
  args: unknown,
  root: string | null,
): Promise<PushGrantTarget | null> {
  if (root === null || typeof args !== 'object' || args === null) return null
  const keys = Object.keys(args)
  if (keys.length !== 1 || keys[0] !== 'branch') return null
  const branch: unknown = Reflect.get(args, 'branch')
  if (typeof branch !== 'string' || branch.length === 0) return null
  const [current, fallback] = await Promise.all([
    getCurrentBranchName(root),
    getDefaultBranch(root),
  ])
  if (current !== branch || fallback === null || fallback === branch) return null
  return { root, branch }
}

export function grantChatPush(threadId: string, target: PushGrantTarget): void {
  const granted = grants.get(threadId) ?? new Set<string>()
  granted.add(key(target))
  grants.set(threadId, granted)
}

export function hasChatPushGrant(threadId: string, target: PushGrantTarget): boolean {
  return grants.get(threadId)?.has(key(target)) === true
}

export function clearChatPushGrants(): void {
  grants.clear()
}
