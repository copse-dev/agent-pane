import type { RemoteAgentProvider } from '@shared/remote-agent.ts'
import type { RemoteAgentLink, RemoteAgentPrIndexEntry } from '@shared/remote-agent-link.ts'
import { extractGithubPrUrls } from '@shared/git/github-pr-url.ts'
import { getActiveProjectId } from '../workspace.ts'
import { getCurrentBranchName } from '../github/git-service.ts'
import { listAgentPrLinks, lookupThreadByPrUrl, upsertThreadAgentLink } from '../thread-store.ts'
import { parseGithubOwnerRepo, resolveRemoteAgentRepository } from './remote-agent-shared.ts'

/**
 * Records the `agent-run ↔ PR ↔ thread` link on the launching thread (issue
 * #690, Q6). The remote-agent clients only carry a `threadId`, so the active
 * project is resolved here; everything is best-effort and swallows errors — a
 * failed link write must never break an agent turn.
 */

async function resolveRepoSlug(): Promise<string | undefined> {
  try {
    const repository = await resolveRemoteAgentRepository()
    if (!repository) return undefined
    const parsed = parseGithubOwnerRepo(repository)
    return parsed ? `${parsed.owner}/${parsed.repo}` : undefined
  } catch {
    return undefined
  }
}

async function resolveBranch(): Promise<string | undefined> {
  try {
    return (await getCurrentBranchName())?.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the launch-time link when a cloud agent is first created for a thread.
 * `branch`/`repo` are resolved from the active project. Awaited by the caller so
 * the link exists before a later {@link attachRemoteAgentPrFromText} for the same
 * turn (both hop the same per-project write queue, preserving order).
 */
export async function recordRemoteAgentLaunch(input: {
  threadId: string
  provider: RemoteAgentProvider
  agentId: string
  runId?: string
  createdAt: number
}): Promise<void> {
  const projectId = getActiveProjectId()
  if (!projectId) return
  const [branch, repo] = await Promise.all([resolveBranch(), resolveRepoSlug()])
  const link: RemoteAgentLink = {
    provider: input.provider,
    agentId: input.agentId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(branch ? { branch } : {}),
    ...(repo ? { repo } : {}),
    createdAt: input.createdAt,
  }
  try {
    await upsertThreadAgentLink(projectId, input.threadId, link)
  } catch (err) {
    console.warn('[remote-agent-link] launch record failed:', err)
  }
}

/**
 * Attach the PR URL to a thread's link once the agent's output reveals it (the
 * PR the run opened surfaces only in the streamed reply). No-op when the text
 * carries no PR URL or no launch was recorded for the thread.
 */
export async function attachRemoteAgentPrFromText(threadId: string, text: string): Promise<void> {
  if (!text) return
  const refs = extractGithubPrUrls(text)
  const prUrl = refs[0]?.url
  if (!prUrl) return
  const projectId = getActiveProjectId()
  if (!projectId) return
  try {
    await upsertThreadAgentLink(projectId, threadId, { prUrl })
  } catch (err) {
    console.warn('[remote-agent-link] PR attach failed:', err)
  }
}

/** Which thread/agent owns a given PR URL, from the active project's reverse index. */
export async function findThreadForPrUrl(prUrl: string): Promise<RemoteAgentPrIndexEntry | null> {
  const projectId = getActiveProjectId()
  if (!projectId) return null
  try {
    return await lookupThreadByPrUrl(projectId, prUrl)
  } catch (err) {
    console.warn('[remote-agent-link] PR lookup failed:', err)
    return null
  }
}

/** Every agent-owned PR in the active project, for the PR pane to annotate rows. */
export async function listActiveProjectAgentPrLinks(): Promise<RemoteAgentPrIndexEntry[]> {
  const projectId = getActiveProjectId()
  if (!projectId) return []
  try {
    return await listAgentPrLinks(projectId)
  } catch (err) {
    console.warn('[remote-agent-link] list failed:', err)
    return []
  }
}
