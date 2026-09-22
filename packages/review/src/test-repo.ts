// A throwaway git repository for the Stage 0 tests: one function to create it
// with an initial commit, one to commit whatever is in the tree. Test-only
// helper (imported by `*.test.ts` files), kept out of the barrel.
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TestRepo {
  readonly root: string
  git(...args: string[]): string
  write(files: Readonly<Record<string, string>>): Promise<void>
  commit(message: string): string
  remove(): Promise<void>
}

export function worktreeCount(repo: TestRepo): number {
  return repo
    .git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree ')).length
}

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'Review Test',
  GIT_AUTHOR_EMAIL: 'review@example.invalid',
  GIT_COMMITTER_NAME: 'Review Test',
  GIT_COMMITTER_EMAIL: 'review@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

export async function createTestRepo(
  files: Readonly<Record<string, string>> = {},
): Promise<TestRepo> {
  const root = await mkdtemp(join(tmpdir(), 'review-test-repo-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...IDENTITY_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  const write = async (entries: Readonly<Record<string, string>>): Promise<void> => {
    for (const [relative, content] of Object.entries(entries)) {
      const path = join(root, relative)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    }
  }
  git('init', '-q', '-b', 'main')
  await write({ '.gitignore': 'node_modules/\n', ...files })
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  return {
    root,
    git,
    write,
    commit(message: string): string {
      git('add', '-A')
      git('commit', '-q', '-m', message)
      return git('rev-parse', 'HEAD')
    },
    remove: () => rm(root, { recursive: true, force: true }),
  }
}
