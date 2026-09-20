import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { getGitChangeStats, resetDefaultBranchCache } from './git-service.ts'
import { setGitAvailableForTest, setGhAvailableForTest } from '../tool-availability.ts'
import { getPrWorkspaceContext } from './pr-context-service.ts'
import { buildAdvisorRepoState } from '../advisor-context.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const gitAvailable = spawnSync('git', ['--version']).status === 0

describe('Changes chip committed-work totals (#2318)', { skip: !gitAvailable }, () => {
  let root = ''
  let restore: (() => void) | undefined

  function git(...args: string[]): void {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }

  async function commitFile(path: string, content: string): Promise<void> {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content)
    git('add', '--', path)
    git('commit', '-qm', `Update ${path}`)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-committed-stats-'))
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('config', 'commit.gpgsign', 'false')
    git('config', 'init.defaultBranch', 'main')
    await commitFile('tracked.txt', 'one\n')
    git('checkout', '-qb', 'feature')
    restore = setWorkspaceRootForTest(root)
    setGitAvailableForTest(true)
    setGhAvailableForTest(false)
    resetDefaultBranchCache()
  })

  afterEach(async () => {
    restore?.()
    setGitAvailableForTest(null)
    setGhAvailableForTest(null)
    resetDefaultBranchCache()
    await rm(root, { recursive: true, force: true })
  })

  it('retains the Changes chip when all branch work has been committed', async () => {
    await commitFile('tracked.txt', 'two\n')
    assert.deepEqual(await getGitChangeStats(root, { includeCommitted: true }), {
      additions: 1,
      deletions: 1,
    })
  })

  it('adds the committed, staged, unstaged and untracked sections', async () => {
    await commitFile('tracked.txt', 'two\n')
    await writeFile(join(root, 'tracked.txt'), 'three\n')
    git('add', 'tracked.txt')
    await writeFile(join(root, 'tracked.txt'), 'four\n')
    await writeFile(join(root, 'new.txt'), 'new\nlines\n')
    assert.deepEqual(await getGitChangeStats(root, { includeCommitted: true }), {
      additions: 5,
      deletions: 3,
    })
  })

  it('does not count commits that only exist on the default branch', async () => {
    await commitFile('tracked.txt', 'two\n')
    git('checkout', '-q', 'main')
    await commitFile('main-only.txt', 'not feature work\n')
    git('checkout', '-q', 'feature')
    assert.deepEqual(await getGitChangeStats(root, { includeCommitted: true }), {
      additions: 1,
      deletions: 1,
    })
  })

  it('matches the pane by excluding pushed commits already carried by an open PR', async () => {
    await commitFile('tracked.txt', 'two\n')
    git('update-ref', 'refs/remotes/origin/feature', 'HEAD')
    await commitFile('local.txt', 'local\nonly\n')
    assert.deepEqual(
      await getGitChangeStats(root, { includeCommitted: true, hasOpenPr: async () => true }),
      {
        additions: 2,
        deletions: 0,
      },
    )
    assert.deepEqual(
      await getGitChangeStats(root, { includeCommitted: true, hasOpenPr: async () => false }),
      {
        additions: 3,
        deletions: 1,
      },
    )
  })

  it('limits every tracked section to the selected nested project', async () => {
    git('checkout', '-q', 'main')
    await commitFile('nested/inside.txt', 'before\n')
    git('checkout', '-qB', 'feature', 'main')
    await commitFile('nested/inside.txt', 'after\n')
    await commitFile('outside.txt', 'outside committed\n')
    await writeFile(join(root, 'outside.txt'), 'outside staged\n')
    git('add', 'outside.txt')
    await writeFile(join(root, 'outside.txt'), 'outside unstaged\n')
    assert.deepEqual(await getGitChangeStats(join(root, 'nested'), { includeCommitted: true }), {
      additions: 1,
      deletions: 1,
    })
  })
  it('keeps PR drafting and advisor context limited to uncommitted work', async () => {
    await commitFile('tracked.txt', 'two\n')
    assert.equal(await getGitChangeStats(root), null)
    await writeFile(join(root, 'tracked.txt'), 'two\nlocal\n')
    assert.deepEqual(await getGitChangeStats(root), { additions: 1, deletions: 0 })
    assert.match(await buildAdvisorRepoState(), /1 path\(s\) changed \(\+1 \/ -0\)/)
  })

  it('uses the production follow-up context PR lookup to choose the committed base', async () => {
    await commitFile('tracked.txt', 'two\n')
    git('update-ref', 'refs/remotes/origin/feature', 'HEAD')
    await commitFile('local.txt', 'local\nonly\n')
    for (const state of ['OPEN', 'CLOSED']) {
      const context = await getPrWorkspaceContext(root, {
        runGh: async (args, options) => {
          assert.deepEqual(args, [
            'pr',
            'view',
            '--json',
            'state,mergeable,mergeStateStatus,statusCheckRollup',
          ])
          assert.equal(options?.cwd, root)
          return { stdout: JSON.stringify({ state }), stderr: '', code: 0 }
        },
      })
      assert.equal(context.hasOpenPr, state === 'OPEN')
      assert.deepEqual(
        context.changeStats,
        state === 'OPEN' ? { additions: 2, deletions: 0 } : { additions: 3, deletions: 1 },
      )
    }
  })

  it('does not apply a previous branch PR result after checkout switches during lookup', async () => {
    await commitFile('tracked.txt', 'two\n')
    git('checkout', '-qb', 'other')
    await commitFile('other.txt', 'other branch\n')
    git('update-ref', 'refs/remotes/origin/other', 'HEAD')
    git('checkout', '-q', 'feature')
    const context = await getPrWorkspaceContext(root, {
      runGh: async () => {
        git('checkout', '-q', 'other')
        return { stdout: '{"state":"OPEN"}', stderr: '', code: 0 }
      },
    })
    assert.deepEqual(context.changeStats, { additions: 2, deletions: 1 })
  })
})
