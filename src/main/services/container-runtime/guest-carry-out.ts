/**
 * What the guest bundles for the host at the end of a run: every commit
 * since the carry-in base, wherever the agent left HEAD.
 *
 * The host fetches `refs/heads/work` from the bundle, so that is the ref the
 * bundle has to carry — but the agent is free to `git checkout -b feature`
 * and commit there, and the first version of this bundled `work` while
 * listing HEAD, which made the export empty ("Refusing to create empty
 * bundle") or short whenever the two had parted. Pointing `work` at HEAD
 * before bundling keeps the ref the host asks for and the commits the run
 * made the same thing. Pure over an injected `git`, so it is tested against
 * a real repository without a guest.
 */

export type GitRunner = (cwd: string, args: string[]) => string

/** The branch the host fetches from the carry-out bundle. */
export const CARRY_OUT_BRANCH = 'work'

/**
 * Commit whatever the agent left uncommitted, point the carry-out branch at
 * HEAD, and bundle everything since the base. Returns `<sha> <subject>` of
 * each commit the bundle carries, newest first; nothing is written when the
 * run made no commits.
 */
export function bundleCarryOut(
  git: GitRunner,
  workspace: string,
  base: string,
  bundlePath: string,
): string[] {
  const status = git(workspace, ['status', '--porcelain'])
  if (status.length > 0) {
    git(workspace, ['add', '-A'])
    git(workspace, ['commit', '--quiet', '-m', 'copse: end-of-run snapshot'])
  }
  const commits = git(workspace, ['log', '--format=%H %s', `${base}..HEAD`])
    .split('\n')
    .filter((line) => line.length > 0)
  if (commits.length === 0) return commits
  // `update-ref` rather than `branch -f`: the latter refuses to move the
  // branch that is checked out, which `work` still is on most runs.
  git(workspace, ['update-ref', `refs/heads/${CARRY_OUT_BRANCH}`, 'HEAD'])
  git(workspace, ['bundle', 'create', bundlePath, `${base}..refs/heads/${CARRY_OUT_BRANCH}`])
  return commits
}
