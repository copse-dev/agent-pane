// Stage 0's ground: two checkouts of the repository under review, materialised
// as detached git worktrees under the review's scratch directory — the
// merge-base with the base ref, and the head. For the author's own tree the
// head is HEAD plus the working tree's uncommitted changes (tracked edits
// applied as a patch, untracked non-ignored files copied), because that is the
// change the author is asking about.
//
// Git runs on the HOST here, over the user's own repository, as the trusted
// orchestrator — with hooks disabled, since a repo-controlled hook is exactly
// the code the cell exists to contain. Nothing from the checkouts is executed
// by this module.
import { execFile } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { removeTree } from './remove-tree.ts'

const execFileAsync = promisify(execFile)

/** The shape `execFile` rejects with when the command exits non-zero. */
const execFailureSchema = z.object({
  code: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
})

/** `core.hooksPath=/dev/null` so a repository cannot run a hook on the host. */
const DISABLE_GIT_HOOKS = ['-c', 'core.hooksPath=/dev/null'] as const

export interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>

/** The default runner: `git` from PATH, hooks disabled, output as UTF-8. */
export const runGit: GitRunner = async (cwd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...DISABLE_GIT_HOOKS, ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return { stdout, stderr, code: 0 }
  } catch (err: unknown) {
    // A non-zero exit rejects with the output attached; anything else (ENOENT,
    // a signal) is a real failure of the runner and propagates.
    const failure = execFailureSchema.safeParse(err)
    if (!failure.success || failure.data.code === undefined) throw err
    return {
      stdout: failure.data.stdout ?? '',
      stderr: failure.data.stderr ?? '',
      code: failure.data.code,
    }
  }
}

export class CheckoutError extends Error {
  constructor(action: string, result: GitResult) {
    const detail = (result.stderr || result.stdout).trim()
    super(detail ? `${action}: ${detail}` : `${action} exited with code ${String(result.code)}`)
    this.name = 'CheckoutError'
  }
}

async function requireGit(
  git: GitRunner,
  cwd: string,
  args: string[],
  action: string,
): Promise<string> {
  const result = await git(cwd, args)
  if (result.code !== 0) throw new CheckoutError(action, result)
  return result.stdout.trim()
}

export interface MaterialiseCheckoutsInput {
  /** Any directory inside the repository. */
  readonly repoRoot: string
  /** The ref the change is against; the merge-base with the head is what gets checked out. */
  readonly baseRef: string
  /**
   * The change under review. Default `HEAD`: the author's own tree. A
   * contributor's branch is any other ref the repository holds — a fetched
   * `refs/pull/<n>/head`, say — and is reviewed as committed: the working
   * tree is never overlaid on a head that is not HEAD.
   */
  readonly headRef?: string
  /** Created by the caller; the checkouts land in `base/` and `head/` beneath it. */
  readonly scratchDir: string
  /** Include the working tree's uncommitted changes in the head checkout. */
  readonly includeWorkingTree: boolean
  readonly git?: GitRunner
}

export interface MaterialisedCheckouts {
  readonly repositoryRoot: string
  readonly base: string
  readonly head: string
  readonly mergeBase: string
  readonly headCommit: string
  /**
   * The repository's common git directory. Both worktrees point their `.git`
   * file at it, so a command in the cell that consults git (a build stamping
   * the commit, a test shelling out to `git rev-parse`) needs it readable.
   */
  readonly gitCommonDir: string
  /** Whether the head checkout carries uncommitted changes beyond `headCommit`. */
  readonly dirty: boolean
  /** Remove both worktrees and prune their registration. Idempotent. */
  cleanup(): Promise<void>
}

/** The working tree's untracked, non-ignored files, repo-relative. */
async function untrackedFiles(git: GitRunner, root: string): Promise<string[]> {
  const result = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (result.code !== 0) throw new CheckoutError('Cannot list untracked files', result)
  return result.stdout.split('\0').filter((entry) => entry.length > 0)
}

export async function materialiseCheckouts(
  input: MaterialiseCheckoutsInput,
): Promise<MaterialisedCheckouts> {
  const git = input.git ?? runGit
  const repositoryRoot = await requireGit(
    git,
    input.repoRoot,
    ['rev-parse', '--show-toplevel'],
    'Cannot resolve repository root',
  )
  const headRef = input.headRef ?? 'HEAD'
  const headCommit = await requireGit(
    git,
    repositoryRoot,
    ['rev-parse', '--verify', `${headRef}^{commit}`],
    `Cannot resolve ${headRef}`,
  )
  const mergeBase = await requireGit(
    git,
    repositoryRoot,
    ['merge-base', input.baseRef, headCommit],
    `Cannot find the merge-base of ${input.baseRef} and ${headRef}`,
  )
  const includeWorkingTree = input.includeWorkingTree && headRef === 'HEAD'
  const gitCommonDir = resolve(
    repositoryRoot,
    await requireGit(
      git,
      repositoryRoot,
      ['rev-parse', '--git-common-dir'],
      'Cannot resolve the git directory',
    ),
  )

  const base = resolve(input.scratchDir, 'base')
  const head = resolve(input.scratchDir, 'head')
  const worktrees: string[] = []
  const cleanup = async (): Promise<void> => {
    for (const path of worktrees.splice(0)) {
      await git(repositoryRoot, ['worktree', 'remove', '--force', path])
      await removeTree(path)
    }
    await git(repositoryRoot, ['worktree', 'prune'])
  }

  try {
    await requireGit(
      git,
      repositoryRoot,
      ['worktree', 'add', '--detach', base, mergeBase],
      'Cannot create the base checkout',
    )
    worktrees.push(base)
    await requireGit(
      git,
      repositoryRoot,
      ['worktree', 'add', '--detach', head, headCommit],
      'Cannot create the head checkout',
    )
    worktrees.push(head)

    let dirty = false
    if (includeWorkingTree) {
      // Tracked changes, staged or not, as one binary patch applied to the head
      // worktree. `git diff HEAD` covers both the index and the working tree.
      const patch = await git(repositoryRoot, ['diff', '--binary', 'HEAD'])
      if (patch.code !== 0) throw new CheckoutError('Cannot diff the working tree', patch)
      if (patch.stdout.length > 0) {
        dirty = true
        const patchPath = join(input.scratchDir, 'working-tree.patch')
        await writeFile(patchPath, patch.stdout)
        await requireGit(
          git,
          head,
          ['apply', '--binary', '--whitespace=nowarn', patchPath],
          'Cannot apply the working tree changes to the head checkout',
        )
        await rm(patchPath, { force: true })
      }
      for (const relative of await untrackedFiles(git, repositoryRoot)) {
        dirty = true
        const target = join(head, relative)
        await mkdir(dirname(target), { recursive: true })
        await cp(join(repositoryRoot, relative), target, { recursive: true })
      }
    }

    return { repositoryRoot, base, head, mergeBase, headCommit, gitCommonDir, dirty, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}
