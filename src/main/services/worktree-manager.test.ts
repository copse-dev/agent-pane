import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { threadWorktreeBranchName } from '@shared/git/worktree-policy.ts'
import { setGitAvailableForTest } from './tool-availability.ts'
import {
  clearAllowedWorkspaceRootsForTest,
  getInternalWorkspaceRootRegistration,
} from './workspace.ts'
import {
  allocateThreadWorktree,
  expectedThreadWorktreePath,
  listProjectWorktrees,
  managedThreadIdForPath,
  parseWorktreePorcelain,
  pruneSafeOrphans,
  retireThreadWorktree,
  validateThreadWorktree,
} from './worktree-manager.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Copse Test',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse Test',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    },
  })
}

async function repository(root: string, name: string): Promise<string> {
  const repo = join(root, name)
  await mkdir(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  await writeFile(join(repo, 'README.md'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'initial'])
  return repo
}

describe('parseWorktreePorcelain', () => {
  it('parses nul-delimited paths and optional states without quoting assumptions', () => {
    const raw = [
      'worktree /repo with space',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/line\nbreak',
      'HEAD def',
      'detached',
      'locked maintenance',
      '',
    ].join('\0')

    assert.deepEqual(parseWorktreePorcelain(raw), [
      {
        path: '/repo with space',
        head: 'abc',
        branch: 'main',
        bare: false,
        detached: false,
        locked: null,
        prunable: null,
      },
      {
        path: '/repo/line\nbreak',
        head: 'def',
        branch: null,
        bare: false,
        detached: true,
        locked: 'maintenance',
        prunable: null,
      },
    ])
  })
})

describe('worktree manager', () => {
  const cleanups: string[] = []
  let previousRoot: string | undefined

  async function setup(): Promise<{ temp: string; repo: string }> {
    previousRoot = process.env['COPSE_WORKTREES_DIR']
    const temp = await mkdtemp(join(tmpdir(), 'copse-worktree-manager-'))
    cleanups.push(temp)
    process.env['COPSE_WORKTREES_DIR'] = join(temp, 'worktrees')
    setGitAvailableForTest(true)
    return { temp, repo: await repository(temp, 'repo') }
  }

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKTREES_DIR']
    else process.env['COPSE_WORKTREES_DIR'] = previousRoot
    previousRoot = undefined
    setGitAvailableForTest(null)
    clearAllowedWorkspaceRootsForTest()
    for (const path of cleanups.splice(0).reverse()) {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('allocates, lists, validates, and safely retires a clean linked checkout', async () => {
    const { repo } = await setup()
    const beforeBranch = git(repo, ['branch', '--show-current']).trim()
    const worktree = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: repo,
      prompt: 'Fix the flicker',
      baseBranch: 'main',
    })

    assert.equal(worktree.path, expectedThreadWorktreePath('project-1', 'thread-1'))
    assert.equal(worktree.seededFromDirtyProject, false)
    assert.equal(git(repo, ['branch', '--show-current']).trim(), beforeBranch)
    assert.equal(git(worktree.path, ['branch', '--show-current']).trim(), worktree.branch)
    assert.equal(managedThreadIdForPath('project-1', worktree.path), 'thread-1')
    assert.ok((await listProjectWorktrees(repo)).some((record) => record.path === worktree.path))

    clearAllowedWorkspaceRootsForTest()
    const validated = await validateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: repo,
      worktree,
    })
    assert.equal(validated.root, worktree.path)
    assert.match(validated.gitDir, /[/\\]worktrees[/\\]/)

    assert.deepEqual(
      await retireThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: repo,
        worktree,
      }),
      { status: 'removed', branch: worktree.branch },
    )
    assert.ok(!(await listProjectWorktrees(repo)).some((record) => record.path === worktree.path))
  })

  it('preserves a project subdirectory as the effective execution root', async () => {
    const { repo } = await setup()
    const projectRoot = join(repo, 'packages', 'app')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(projectRoot, 'package.json'), '{"private":true}\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'add nested project'])

    const worktree = await allocateThreadWorktree({
      projectId: 'nested-project',
      threadId: 'nested-thread',
      projectRoot,
      prompt: 'Work in the package',
      baseBranch: 'main',
    })
    const expectedRoot = join(worktree.path, 'packages', 'app')
    const validated = await validateThreadWorktree({
      projectId: 'nested-project',
      threadId: 'nested-thread',
      projectRoot,
      worktree,
    })

    assert.equal(validated.path, worktree.path)
    assert.equal(validated.root, expectedRoot)
    assert.equal(
      await readFile(join(validated.root, 'package.json'), 'utf-8'),
      '{"private":true}\n',
    )
    assert.equal(getInternalWorkspaceRootRegistration(validated.root)?.checkoutRoot, worktree.path)
    assert.ok(
      (await listProjectWorktrees(projectRoot)).some((record) => record.path === worktree.path),
    )
  })

  it(
    'does not execute repository hooks while creating a managed checkout',
    { skip: process.platform === 'win32' },
    async () => {
      const { temp, repo } = await setup()
      const marker = join(temp, 'hook-ran')
      const hook = join(repo, '.git', 'hooks', 'post-checkout')
      await writeFile(hook, `#!/bin/sh\nprintf ran > '${marker}'\n`)
      await chmod(hook, 0o755)

      await allocateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-no-hooks',
        projectRoot: repo,
        prompt: 'Do not run hooks',
        baseBranch: 'main',
      })

      await assert.rejects(readFile(marker, 'utf-8'))
    },
  )

  it('seeds staged, unstaged, untracked, deleted, renamed, and binary content but not ignored files', async () => {
    const { repo } = await setup()
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n')
    await writeFile(join(repo, 'staged.txt'), 'staged base\n')
    await writeFile(join(repo, 'unstaged.txt'), 'unstaged base\n')
    await writeFile(join(repo, 'deleted.txt'), 'delete me\n')
    await writeFile(join(repo, 'rename-old.txt'), 'rename me\n')
    await writeFile(join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    git(repo, ['add', '.'])
    git(repo, ['commit', '-q', '-m', 'seed fixtures'])

    await writeFile(join(repo, 'staged.txt'), 'staged changed\n')
    git(repo, ['add', 'staged.txt'])
    await writeFile(join(repo, 'unstaged.txt'), 'unstaged changed\n')
    await writeFile(join(repo, 'untracked.txt'), 'untracked\n')
    await unlink(join(repo, 'deleted.txt'))
    await rename(join(repo, 'rename-old.txt'), join(repo, 'rename-new.txt'))
    await writeFile(join(repo, 'binary.bin'), Buffer.from([255, 0, 8, 7]))
    await writeFile(join(repo, 'ignored.txt'), 'do not copy\n')

    const beforeStatus = git(repo, ['status', '--porcelain=v1', '-z'])
    const worktree = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-dirty',
      projectRoot: repo,
      prompt: 'Preserve dirty content',
      baseBranch: 'main',
    })

    assert.equal(worktree.seededFromDirtyProject, true)
    assert.equal(await readFile(join(worktree.path, 'staged.txt'), 'utf-8'), 'staged changed\n')
    assert.equal(await readFile(join(worktree.path, 'unstaged.txt'), 'utf-8'), 'unstaged changed\n')
    assert.equal(await readFile(join(worktree.path, 'untracked.txt'), 'utf-8'), 'untracked\n')
    await assert.rejects(readFile(join(worktree.path, 'deleted.txt'), 'utf-8'))
    await assert.rejects(readFile(join(worktree.path, 'rename-old.txt'), 'utf-8'))
    assert.equal(await readFile(join(worktree.path, 'rename-new.txt'), 'utf-8'), 'rename me\n')
    assert.deepEqual(await readFile(join(worktree.path, 'binary.bin')), Buffer.from([255, 0, 8, 7]))
    await assert.rejects(readFile(join(worktree.path, 'ignored.txt'), 'utf-8'))

    assert.equal(git(repo, ['status', '--porcelain=v1', '-z']), beforeStatus)
    assert.match(git(repo, ['diff', '--cached', '--', 'staged.txt']), /staged changed/)
    assert.equal(git(repo, ['diff', '--cached', '--', 'unstaged.txt']), '')
    assert.equal(git(repo, ['branch', '--show-current']).trim(), 'main')
    assert.equal(
      git(repo, ['for-each-ref', '--format=%(refname)', 'refs/copse/backups']).trim(),
      '',
    )
  })

  it('serializes concurrent allocations and suffixes branch collisions deterministically', async () => {
    const { repo } = await setup()
    const colliding = threadWorktreeBranchName('Same prompt', 'thread-a')
    git(repo, ['branch', colliding])

    const [first, second] = await Promise.all([
      allocateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-a',
        projectRoot: repo,
        prompt: 'Same prompt',
        baseBranch: 'main',
      }),
      allocateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-b',
        projectRoot: repo,
        prompt: 'Same prompt',
        baseBranch: 'main',
      }),
    ])

    assert.equal(first.branch, `${colliding}-2`)
    assert.notEqual(first.path, second.path)
    assert.notEqual(first.branch, second.branch)
    const records = await listProjectWorktrees(repo)
    assert.ok(records.some((record) => record.path === first.path))
    assert.ok(records.some((record) => record.path === second.path))
  })

  it('rejects missing, mismatched, and foreign persisted worktree authority', async () => {
    const { temp, repo } = await setup()
    const worktree = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-1',
      projectRoot: repo,
      prompt: 'Validate authority',
      baseBranch: 'main',
    })

    await assert.rejects(
      validateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: repo,
        worktree: { ...worktree, path: join(temp, 'attacker-path') },
      }),
      /does not match/,
    )
    await assert.rejects(
      validateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: repo,
        worktree: { ...worktree, branch: 'wrong-branch' },
      }),
      /branch mismatch/,
    )
    await assert.rejects(
      validateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: repo,
        worktree: { ...worktree, baseBranch: worktree.branch },
      }),
      /must differ/,
    )
    await assert.rejects(
      validateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: repo,
        worktree: { ...worktree, baseCommit: 'not-a-commit' },
      }),
      /malformed/,
    )

    const otherRepo = await repository(temp, 'other-repo')
    await assert.rejects(
      validateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: otherRepo,
        worktree,
      }),
      /not registered|different repository|base commit/,
    )

    await rm(worktree.path, { recursive: true, force: true })
    await assert.rejects(
      validateThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-1',
        projectRoot: repo,
        worktree,
      }),
      /missing/,
    )
  })

  it('blocks retirement when a worktree is dirty or contains unmerged commits', async () => {
    const { repo } = await setup()
    const dirty = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-dirty',
      projectRoot: repo,
      prompt: 'Dirty retirement',
      baseBranch: 'main',
    })
    await writeFile(join(dirty.path, 'rename-me.txt'), 'dirty\n')
    git(dirty.path, ['add', 'rename-me.txt'])
    git(dirty.path, ['commit', '-q', '-m', 'rename fixture'])
    git(repo, ['merge', '--no-edit', dirty.branch])
    await rename(join(dirty.path, 'rename-me.txt'), join(dirty.path, 'renamed.txt'))
    git(dirty.path, ['add', '-A'])
    assert.deepEqual(
      await retireThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-dirty',
        projectRoot: repo,
        worktree: dirty,
      }),
      { status: 'blocked-dirty', paths: ['renamed.txt', 'rename-me.txt'] },
    )

    const ahead = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-ahead',
      projectRoot: repo,
      prompt: 'Ahead retirement',
      baseBranch: 'main',
    })
    await writeFile(join(ahead.path, 'ahead.txt'), 'ahead\n')
    git(ahead.path, ['add', '.'])
    git(ahead.path, ['commit', '-q', '-m', 'ahead'])
    assert.deepEqual(
      await retireThreadWorktree({
        projectId: 'project-1',
        threadId: 'thread-ahead',
        projectRoot: repo,
        worktree: ahead,
      }),
      {
        status: 'blocked-unmerged',
        branch: ahead.branch,
        baseBranch: 'main',
      },
    )
  })

  it('retains ignored files during explicit retirement and orphan pruning', async () => {
    const { repo } = await setup()
    await writeFile(join(repo, '.gitignore'), 'ignored/\n')
    git(repo, ['add', '.gitignore'])
    git(repo, ['commit', '-q', '-m', 'ignore local artifacts'])
    const worktree = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-ignored',
      projectRoot: repo,
      prompt: 'Ignored content retention',
      baseBranch: 'main',
    })
    await mkdir(join(worktree.path, 'ignored'))
    const artifact = join(worktree.path, 'ignored', 'valuable.txt')
    await writeFile(artifact, 'keep me\n')

    const retired = await retireThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-ignored',
      projectRoot: repo,
      worktree,
    })
    assert.equal(retired.status, 'blocked-dirty')
    assert.ok(retired.paths.includes('ignored/'))
    assert.equal(await readFile(artifact, 'utf-8'), 'keep me\n')

    const report = await pruneSafeOrphans({
      projectId: 'project-1',
      projectRoot: repo,
      knownThreadIds: new Set(),
      baseBranch: 'main',
    })
    assert.deepEqual(report.pruned, [])
    assert.ok(
      report.retained.some(
        (entry) =>
          entry.threadId === 'thread-ignored' &&
          entry.reason === 'dirty' &&
          entry.paths?.includes('ignored/'),
      ),
    )
    assert.equal(await readFile(artifact, 'utf-8'), 'keep me\n')
  })

  it('prunes only clean merged ownerless worktrees and itemizes retained recovery cases', async () => {
    const { repo } = await setup()
    const known = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-known',
      projectRoot: repo,
      prompt: 'Known thread',
      baseBranch: 'main',
    })
    const safe = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-safe',
      projectRoot: repo,
      prompt: 'Safe orphan',
      baseBranch: 'main',
    })
    const dirty = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-dirty-orphan',
      projectRoot: repo,
      prompt: 'Dirty orphan',
      baseBranch: 'main',
    })
    await writeFile(join(dirty.path, 'dirty.txt'), 'dirty\n')
    const ahead = await allocateThreadWorktree({
      projectId: 'project-1',
      threadId: 'thread-ahead-orphan',
      projectRoot: repo,
      prompt: 'Ahead orphan',
      baseBranch: 'main',
    })
    await writeFile(join(ahead.path, 'ahead.txt'), 'ahead\n')
    git(ahead.path, ['add', '.'])
    git(ahead.path, ['commit', '-q', '-m', 'ahead'])

    const report = await pruneSafeOrphans({
      projectId: 'project-1',
      projectRoot: repo,
      knownThreadIds: new Set(['thread-known']),
      baseBranch: 'main',
    })

    assert.deepEqual(report.pruned, [
      { threadId: 'thread-safe', path: safe.path, branch: safe.branch },
    ])
    assert.deepEqual(
      report.retained
        .map(({ threadId, reason }) => ({ threadId, reason }))
        .sort((a, b) => a.threadId.localeCompare(b.threadId)),
      [
        { threadId: 'thread-ahead-orphan', reason: 'unmerged' },
        { threadId: 'thread-dirty-orphan', reason: 'dirty' },
      ],
    )
    const paths = (await listProjectWorktrees(repo)).map((record) => record.path)
    assert.ok(paths.includes(known.path))
    assert.ok(!paths.includes(safe.path))
    assert.ok(paths.includes(dirty.path))
    assert.ok(paths.includes(ahead.path))
  })
})
