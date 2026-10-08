export { githubArchiveBase } from './openai-archive-base.ts'
import { requestGithubArchiveUrl } from './openai-archive-download.ts'
import { resolveGitHubApiToken } from '../github/backend/github-token.ts'
export async function githubArchiveUrl(
  repository: string,
  commit: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return requestGithubArchiveUrl(
    repository,
    commit,
    signal,
    await resolveGitHubApiToken(),
    fetchImpl,
  )
}
