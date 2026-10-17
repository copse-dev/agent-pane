import { z } from 'zod'
import { mobileDecisions, type MobileDecision } from './mobile-decisions.ts'
import { mobileRunId } from '../agent-service.ts'
import { listRunningThreadIds } from '../agent-service.ts'
import { pendingApprovalCountForThread, pendingApprovalRequestsForThread } from '../approval.ts'
import { pendingAskUserCountForThread, pendingAskUserQuestionsForThread } from '../ask-user.ts'
import { storageGet } from '../storage/storage.ts'
import { loadProjectThreadMetas, loadThreadMessages } from '../thread-store.ts'
import { inspectThreadCheckoutRoot } from '../thread-execution-context.ts'
import { threadHasUncommittedChanges } from '../thread-dirty-status.ts'

const projectSchema = z.array(
  z.object({
    id: z.string().regex(/^[\w-]{1,128}$/),
    name: z.string().max(200),
  }),
)
const safeId = /^[\w-]{1,128}$/

export interface MobileActivityRow {
  projectId: string
  projectName: string
  threadId: string
  title: string
  group: 'needs-you' | 'working' | 'has-changes' | 'recent'
  state: 'needs-approval' | 'needs-answer' | 'working' | 'failed' | 'finished'
  detail: string
  updatedAt: number
  lastSavedAt: number
}

export function mobileProjects(): Array<{ id: string; name: string }> {
  const parsed = projectSchema.safeParse(storageGet('projects'))
  return parsed.success ? parsed.data : []
}

/**
 * Whether a settled thread's checkout has uncommitted work worth a trip back
 * to the desktop. Inspect-only: a poll must never restore a retired worktree,
 * so a retired, PR'd or unresolvable checkout just reads as clean rather than
 * failing the whole activity feed over a cosmetic signal.
 */
async function settledThreadHasChanges(
  projectId: string,
  threadId: string,
  updatedAt: number,
): Promise<boolean> {
  try {
    const root = await inspectThreadCheckoutRoot(projectId, threadId)
    return root !== null && (await threadHasUncommittedChanges(threadId, root, updatedAt))
  } catch {
    return false
  }
}

export async function mobileActivity(): Promise<MobileActivityRow[]> {
  const running = new Set(listRunningThreadIds())
  const groups: MobileActivityRow[] = []
  for (const project of mobileProjects()) {
    const threads = await loadProjectThreadMetas(project.id)
    for (const thread of threads) {
      if (thread.archivedAt !== undefined) continue
      const approvals = pendingApprovalCountForThread(thread.id)
      const questions = pendingAskUserCountForThread(thread.id)
      const settled = approvals === 0 && questions === 0 && !running.has(thread.id)
      const state: MobileActivityRow['state'] =
        approvals > 0
          ? 'needs-approval'
          : questions > 0
            ? 'needs-answer'
            : running.has(thread.id)
              ? 'working'
              : thread.status === 'error'
                ? 'failed'
                : 'finished'
      const hasChanges = settled
        ? await settledThreadHasChanges(project.id, thread.id, thread.updatedAt)
        : false
      groups.push({
        projectId: project.id,
        projectName: project.name,
        threadId: thread.id,
        title: thread.title || 'Untitled thread',
        group:
          approvals > 0 || questions > 0
            ? 'needs-you'
            : running.has(thread.id)
              ? 'working'
              : hasChanges
                ? 'has-changes'
                : 'recent',
        state,
        detail:
          approvals > 0
            ? `${pendingApprovalRequestsForThread(thread.id)[0]?.title ?? 'Approval needed'} · ${String(approvals)} waiting`
            : questions > 0
              ? (pendingAskUserQuestionsForThread(thread.id)[0]?.question ?? 'Answer needed')
              : running.has(thread.id)
                ? 'Agent running · last saved activity shown below'
                : thread.status === 'error'
                  ? 'Last run failed'
                  : 'Latest completed output',
        updatedAt: thread.updatedAt,
        lastSavedAt: thread.updatedAt,
      })
    }
  }
  const order = { 'needs-you': 0, working: 1, 'has-changes': 2, recent: 3 }
  return groups.sort((a, b) => order[a.group] - order[b.group] || b.updatedAt - a.updatedAt)
}

export async function mobileThread(
  projectId: string,
  threadId: string,
): Promise<{
  projectName: string
  title: string
  attention: Array<{ title: string; body: string }>
  decisions: MobileDecision[]
  runId: string | null
  messages: Array<{ role: 'user' | 'assistant' | 'error'; content: string; summary: string | null }>
} | null> {
  if (!safeId.test(projectId) || !safeId.test(threadId)) return null
  const project = mobileProjects().find((item) => item.id === projectId)
  if (!project) return null
  const thread = (await loadProjectThreadMetas(projectId)).find(
    (item) => item.id === threadId && item.archivedAt === undefined,
  )
  if (!thread) return null
  const messages = (await loadThreadMessages(projectId, threadId)).slice(-40).map((message) => ({
    role: message.role,
    content: message.content.slice(0, 20_000),
    summary: message.runSummary ?? message.toolSummary ?? message.commandSummary ?? null,
  }))
  const attention = [
    ...pendingApprovalRequestsForThread(threadId).map((request) => ({
      title: request.title,
      body: request.body,
    })),
    ...pendingAskUserQuestionsForThread(threadId).map((question) => ({
      title: 'Answer needed',
      body: question.question,
    })),
  ]
  return {
    projectName: project.name,
    title: thread.title || 'Untitled thread',
    attention,
    decisions: mobileDecisions.list(projectId, threadId),
    runId: mobileRunId(threadId),
    messages,
  }
}
