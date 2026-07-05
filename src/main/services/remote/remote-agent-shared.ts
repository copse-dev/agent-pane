import type { LLMMessage, StreamChunk, UserContent } from '@shared/types'
import type { RemoteAgentProvider } from '@shared/remote-agent.ts'
import { getGithubRepoSlug } from '../github/git-service.ts'
import { getActiveProjectRoot, getWorkspaceRoot } from '../workspace.ts'

/**
 * Options for a single remote-agent turn. Shared by every provider adapter
 * (Cursor, Claude Managed Agents, …) so the dispatcher in remote-agent-client
 * can route to any of them with one shape.
 */
export interface RemoteAgentRunOptions {
  threadId: string
  provider: RemoteAgentProvider
  userPrompt: UserContent
  signal: AbortSignal
  onChunk: (chunk: StreamChunk) => void
  /** Prior local conversation, dumped into the first prompt on remote hand-off. */
  priorMessages?: LLMMessage[]
  fetchImpl?: typeof fetch
}

export interface RemoteAgentRunResult {
  assistantText: string
  inputTokens: number
  outputTokens: number
  messages: Array<{ role: 'assistant'; content: string }>
}

export type GithubRepoSlugResolver = (root: string | null) => Promise<string | null>

/**
 * GitHub repository URL for the active project, or null when the project is not
 * a git repo (or has no GitHub remote). Providers that can run without a
 * repository treat null as "no repo attached"; providers that must clone one
 * raise their own error.
 */
export async function resolveRemoteAgentRepository(
  options: { getGithubRepoSlug?: GithubRepoSlugResolver } = {},
): Promise<string | null> {
  const resolveSlug = options.getGithubRepoSlug ?? getGithubRepoSlug
  const slug = await resolveSlug(getActiveProjectRoot() ?? getWorkspaceRoot())
  return slug ? `https://github.com/${slug}` : null
}

/** Parse `owner` and `repo` out of a GitHub repository URL or `owner/repo` slug. */
export function parseGithubOwnerRepo(repository: string): { owner: string; repo: string } | null {
  const trimmed = repository.trim()
  const slugMatch = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(trimmed)
  if (slugMatch) {
    const [, owner, repo] = slugMatch
    if (owner && repo) return { owner, repo }
  }
  try {
    const url = new URL(trimmed)
    const parts = url.pathname.replace(/^\/+/, '').split('/')
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') }
    }
  } catch {
    /* not a URL */
  }
  return null
}
