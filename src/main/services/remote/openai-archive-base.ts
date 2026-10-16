import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
