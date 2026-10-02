import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runCommand } from './exec/command-runner.ts'

// Starter guidance written to a newly-created project's AGENT.md. Kept in the
// main process (not the renderer) so the file is written at the trust boundary
// alongside the folder itself; the text steers the agent to plan and ask before
// acting in a codebase it has never seen.
export const STARTER_AGENT_MD = `# Project guide

This is a new project scaffolded in Copse. Add project-specific context here that
you want the coding agent to follow on every turn.

## Working style

- This project is new and may have no existing conventions yet. Before making
  changes, explore the codebase, then propose a plan and ask clarifying questions.
- Prefer plan mode: lay out what you intend to do and confirm the approach before
  writing code or running destructive commands.
- Keep changes small and reviewable; prefer to ask rather than assume when an
  intent is ambiguous.
`

/**
 * Populate a freshly-created project folder: starter AGENT.md + README.md, then
 * a Git repository on `main` whose first commit holds them. `projectMissing`
 * says the folder was created by this call, so it is removed again on failure.
 */
export async function scaffoldProject(
  projectPath: string,
  name: string,
  projectMissing: boolean,
): Promise<void> {
  await writeFile(join(projectPath, 'AGENT.md'), STARTER_AGENT_MD, 'utf8')
  await writeFile(join(projectPath, 'README.md'), `# ${name}\n\n`, 'utf8')
  // git init -b main keeps the initial branch name stable regardless of the
  // user's global init.defaultBranch / git template config.
  //
  // Unsandboxed, like `runWorktreeGit`: the new project sits outside the
  // *current* workspace's sandbox until the caller's `registerAllowedWorkspaceRoot`
  // moves the boundary, so a sandboxed spawn cannot write `.git/` there. The
  // file scaffolding above is main-process `fs` and never hit that wall, which is
  // why the failure only surfaced once the exit code was checked.
  //
  // The scaffold is then committed so the repo has a real HEAD and a clean
  // tree. Left untracked, the two starter files read as the user's
  // uncommitted work: the first send shows the "checkout has uncommitted
  // changes" banner, and an isolated worktree has no commit to start from.
  // The internal Git policy has no plain `commit` (that is the
  // permission-gated user profile), so this uses the same plumbing as the
  // automatic snapshots, with an explicit identity: a fresh machine may have
  // no user.name, and no hook or signing config can interfere.
  const gitStep = async (label: string, args: string[]): Promise<string> => {
    const result = await runCommand('git', args, {
      cwd: projectPath,
      timeout_ms: 0,
      unsandboxed: true,
    })
    // `runCommand` resolves with the exit code rather than rejecting, so an
    // unchecked call silently accepts a failed step: the folder scaffolds,
    // the project registers, and the user gets a "project" that is not a
    // usable repository — with the reason discarded at the only point that
    // had it. Everything downstream (branch chip, Changes, worktrees) then
    // fails in ways that never mention Git.
    if (result.code !== 0) {
      // A folder we created ourselves is ours to remove. Leaving it behind
      // would trap the retry: the emptiness check above rejects the same name
      // on the second attempt. A pre-existing (empty) folder is the user's,
      // so it stays.
      if (projectMissing) await rm(projectPath, { recursive: true, force: true })
      const detail = (result.stderr || result.stdout).trim()
      throw new Error(`Could not ${label} in ${projectPath}${detail ? `: ${detail}` : ''}`)
    }
    return result.stdout.trim()
  }
  await gitStep('initialise a Git repository', ['init', '-b', 'main'])
  await gitStep('stage the starter files', ['add', '-A'])
  const tree = await gitStep('write the initial tree', ['write-tree'])
  const commit = await gitStep('create the initial commit', [
    '-c',
    'user.name=Copse',
    '-c',
    'user.email=copse@copse.invalid',
    'commit-tree',
    tree,
    '-m',
    'Initial commit',
  ])
  await gitStep('point main at the initial commit', ['update-ref', 'refs/heads/main', commit])
}
