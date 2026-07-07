import type { RemoteAgentProvider } from '@shared/remote-agent.ts'
import type { RemoteAgentLink, RemoteAgentPrIndexEntry } from '@shared/remote-agent-link.ts'
import { extractGithubPrUrls } from '@shared/git/github-pr-url.ts'
import { getActiveProjectId } from '../workspace.ts'
import { getCurrentBranchName } from '../github/git-service.ts'
import {
  attachThreadPrUrl,
  listAgentPrLinks,
  lookupThreadByPrUrl,
  recordThreadAgentLink,
} from '../thread-store.ts'
import { parseGithubOwnerRepo, resolveRemoteAgentRepository } from './remote-agent-shared.ts'

/**
 * Records the `agent-run ↔ PR ↔ thread` link on the launching thread (issue
 * #690, Q6). The launching project is captured by the caller at run start and
 * passed in — resolving it lazily at completion would misroute the link if the
 * user switched projects mid-run. Everything is best-effort and swallows every
 * error (including the lookups before the write): a failed link write must never
 * break an agent turn that has already launched a cloud agent.
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
 * `branch`/`repo` are resolved from the launching project. Awaited by the caller
 * so the link exists before a later {@link attachRemoteAgentPrFromText} for the
 * same turn (both hop the same per-project write queue, preserving order).
 */
export async function recordRemoteAgentLaunch(input: {
  projectId: string | null
  threadId: string
  provider: RemoteAgentProvider
  agentId: string
  runId?: string
  createdAt: number
}): Promise<void> {
  if (!input.projectId) return
  try {
    const [branch, repo] = await Promise.all([resolveBranch(), resolveRepoSlug()])
    const link: RemoteAgentLink = {
      provider: input.provider,
      agentId: input.agentId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(branch ? { branch } : {}),
      ...(repo ? { repo } : {}),
      createdAt: input.createdAt,
    }
    await recordThreadAgentLink(input.projectId, input.threadId, link)
  } catch (err) {
    console.warn('[remote-agent-link] launch record failed:', err)
  }
}

/**
 * Attach the PR the agent opened once its reply reveals it. Write-once and
 * repo-filtered (see thread-store `attachThreadPrUrl`), so a reply that also
 * references an unrelated PR — or a follow-up turn — can't repoint the link.
 */
export async function attachRemoteAgentPrFromText(
  projectId: string | null,
  threadId: string,
  text: string,
): Promise<void> {
  if (!projectId || !text) return
  try {
    const refs = extractGithubPrUrls(text)
    if (refs.length === 0) return
    await attachThreadPrUrl(projectId, threadId, refs)
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
