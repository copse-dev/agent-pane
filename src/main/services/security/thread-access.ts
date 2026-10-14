import { isAbsolute, join, relative, sep } from 'node:path'
import { threadAccessApproval } from '@shared/approval-copy.ts'
import { getActiveRunThread } from '../active-run-identity.ts'
import { currentThreadExecutionContext } from '../thread-execution-context-store.ts'
import { getSetting, updateSetting } from '../storage/settings.ts'

type ThreadAccess = 'read' | 'send'
const keys = { read: 'threadReadAccess', send: 'threadSendAccess' } as const
const revisions = new Map<string, number>()

export function hasThreadAccess(threadId: string | null, access: ThreadAccess): boolean {
  return threadId !== null && getSetting<string[]>(keys[access], []).includes(threadId)
}

export async function revokeThreadAccess(threadId: string, access: ThreadAccess): Promise<void> {
  const key = `${threadId}:${access}`
  revisions.set(key, (revisions.get(key) ?? 0) + 1)
  await updateSetting<string[]>(keys[access], [], (grants) =>
    grants.filter((id) => id !== threadId),
  )
}

// Coalesce simultaneous reads without letting one thread reuse another's consent.
const pending = new Map<string, Promise<boolean>>()

export async function ensureThreadAccess(
  access: ThreadAccess,
  signal?: AbortSignal,
): Promise<boolean> {
  const threadId = getActiveRunThread()
  if (!threadId || signal?.aborted) return false
  if (hasThreadAccess(threadId, access)) return true
  const key = `${threadId}:${access}`
  const revision = revisions.get(key) ?? 0
  const existing = pending.get(key)
  if (existing) return (await existing) && !signal?.aborted
  const request = (async (): Promise<boolean> => {
    const { requestApproval } = await import('../approval.ts')
    const { approved } = await requestApproval(
      {
        ...threadAccessApproval(access),
        type: 'mcp',
        cause: access === 'read' ? 'thread-read-access' : 'thread-send-access',
        scope: `thread-${access}`,
        subject: `thread-${access}-access`,
      },
      signal,
    )
    if (!approved || signal?.aborted || (revisions.get(key) ?? 0) !== revision) return false
    await updateSetting<string[]>(keys[access], [], (grants) =>
      signal?.aborted || (revisions.get(key) ?? 0) !== revision
        ? grants
        : [...new Set([...grants, threadId])],
    )
    return (revisions.get(key) ?? 0) === revision && hasThreadAccess(threadId, access)
  })()
  pending.set(key, request)
  try {
    return await request
  } finally {
    pending.delete(key)
  }
}

export function threadChatReadRoot(chatRoot: string): string | null {
  const threadId = getActiveRunThread()
  if (!threadId || hasThreadAccess(threadId, 'read')) return chatRoot
  const context = currentThreadExecutionContext()
  return context?.threadId === threadId ? join(chatRoot, context.projectId, context.threadId) : null
}

/** Own transcript remains readable; browsing the store or another thread needs consent. */
export function needsOtherThreadRead(path: string, chatRoot: string): boolean {
  const parts = relative(chatRoot, path).split(sep)
  if (parts[0] === '..' || isAbsolute(relative(chatRoot, path))) return false
  const context = currentThreadExecutionContext()
  return !(
    context &&
    context.threadId === getActiveRunThread() &&
    parts[0] === context.projectId &&
    parts[1] === context.threadId
  )
}

export async function ensureChatStoreRead(path: string, chatRoot: string): Promise<void> {
  // Renderer browsing and store persistence are human/app operations, not agent reads.
  if (!getActiveRunThread() || !needsOtherThreadRead(path, chatRoot)) return
  if (!(await ensureThreadAccess('read')))
    throw new Error('Read access to other threads was declined.')
}
