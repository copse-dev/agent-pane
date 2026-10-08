import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveGitHubApiToken } from '../github/backend/github-token.ts'
const exec = promisify(execFile)
const git = async (root: string, args: string[]): Promise<string> =>
  (await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root })).stdout.trim()

export async function githubArchiveBase(
  root: string,
): Promise<{ repository: string; commit: string }> {
  const remote = await git(root, ['remote', 'get-url', 'origin'])
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(
      remote,
    )
  if (!match?.[1])
    throw new Error('OpenAI archive provisioning requires a github.com origin remote.')
  const branch = await git(root, ['branch', '--show-current'])
  for (const ref of [
    `refs/remotes/origin/${branch}`,
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
  ]) {
    const commit = await git(root, ['merge-base', 'HEAD', ref]).catch(() => '')
    if (/^[a-f0-9]{40}$/.test(commit)) return { repository: match[1], commit }
  }
  throw new Error(
    'Fetch the GitHub origin before starting an OpenAI cloud task; no shared remote base is available.',
  )
}

/** Host-only authentication. Never follow the authenticated request's redirect. */
export async function githubArchiveUrl(
  repository: string,
  commit: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const token = await resolveGitHubApiToken()
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/tarball/${commit}`, {
    redirect: 'manual',
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
  await response.body?.cancel()
  if (response.status !== 302)
    throw new Error(
      `GitHub archive request failed (HTTP ${String(response.status)}). Check repository access and fetch origin.`,
    )
  const location = response.headers.get('location')
  if (!location) throw new Error('GitHub did not return an archive download URL.')
  let url: URL
  try {
    url = new URL(location)
  } catch {
    throw new Error('GitHub returned an invalid archive download destination.')
  }
  if (
    url.href.length > 8192 ||
    url.protocol !== 'https:' ||
    url.hostname !== 'codeload.github.com' ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/`)
  )
    throw new Error('GitHub returned an unsupported archive download destination.')
  return url.href
}
