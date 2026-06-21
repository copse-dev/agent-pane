import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { getGitDiffText, parsePorcelainV1 } from './git-service.ts'
import { setWorkspaceRootForTest } from './workspace.ts'
import { setGitAvailableForTest } from './tool-availability.ts'

describe('parsePorcelainV1', () => {
  it('returns empty lists for clean tree', () => {
    const result = parsePorcelainV1('')
    assert.deepEqual(result, { staged: [], unstaged: [] })
  })

  it('parses staged and unstaged modifications', () => {
    const raw = 'M  src/foo.ts\0 M src/bar.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'src/foo.ts', status: 'modified' }])
    assert.deepEqual(result.unstaged, [{ path: 'src/bar.ts', status: 'modified' }])
  })

  it('parses untracked files', () => {
    const raw = '?? new-file.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.unstaged, [{ path: 'new-file.ts', status: 'untracked' }])
    assert.equal(result.staged.length, 0)
  })

  it('parses staged deletion', () => {
    const raw = 'D  old.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'old.ts', status: 'deleted' }])
  })

  it('parses renames', () => {
    const raw = 'R  old.ts\0new.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'new.ts', status: 'renamed' }])
  })

  it('parses both staged and unstaged on same file', () => {
    const raw = 'MM src/both.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'src/both.ts', status: 'modified' }])
    assert.deepEqual(result.unstaged, [{ path: 'src/both.ts', status: 'modified' }])
  })
})

const gitOk = spawnSync('git', ['--version']).status === 0

describe('getGitDiffText untracked files', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'tracked.txt'), 'one\n')
    git('add', 'tracked.txt')
    git('commit', '-qm', 'init')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('includes an untracked file in the diff for a specific path', async () => {
    await writeFile(join(repo, 'fresh.txt'), 'brand new\n')
    const diff = await getGitDiffText('fresh.txt')
    assert.notEqual(diff, '(no output)')
    assert.match(diff, /fresh\.txt/)
    assert.match(diff, /brand new/)
  })

  it('includes untracked files when no path is given', async () => {
    const diff = await getGitDiffText()
    assert.match(diff, /fresh\.txt/)
  })
})
