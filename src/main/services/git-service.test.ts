import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { classifyGitBlob, getGitDiffText, getGitFileDiff, parsePorcelainV1 } from './git-service.ts'
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

  it('ignores local codesearch database status entries', () => {
    const raw = '?? .codesearch.db/\0 M .codesearch.db/index\0?? src/file.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.unstaged, [{ path: 'src/file.ts', status: 'untracked' }])
    assert.equal(result.staged.length, 0)
  })

  it('parses staged deletion', () => {
    const raw = 'D  old.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'old.ts', status: 'deleted' }])
  })

  it('parses renames (record path is the destination, paired token is the source)', () => {
    const raw = 'R  new.ts\0old.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'new.ts', status: 'renamed' }])
  })

  it('stays aligned after a rename when parsing subsequent records', () => {
    const raw = 'R  new.ts\0old.ts\0 M after.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'new.ts', status: 'renamed' }])
    assert.deepEqual(result.unstaged, [{ path: 'after.ts', status: 'modified' }])
  })

  it('does not mis-align when a rename record is missing its paired token (#130)', () => {
    const raw = 'R  new.ts\0 M after.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'new.ts', status: 'renamed' }])
    assert.deepEqual(result.unstaged, [{ path: 'after.ts', status: 'modified' }])
  })

  it('parses both staged and unstaged on same file', () => {
    const raw = 'MM src/both.ts\0'
    const result = parsePorcelainV1(raw)
    assert.deepEqual(result.staged, [{ path: 'src/both.ts', status: 'modified' }])
    assert.deepEqual(result.unstaged, [{ path: 'src/both.ts', status: 'modified' }])
  })
})

describe('classifyGitBlob (#130)', () => {
  it('treats a non-zero exit as a missing blob, not an empty file', () => {
    const result = classifyGitBlob('', 128)
    assert.deepEqual(result, { content: '', exists: false, isBinary: false })
  })

  it('treats a clean exit with empty output as a genuinely empty file', () => {
    const result = classifyGitBlob('', 0)
    assert.deepEqual(result, { content: '', exists: true, isBinary: false })
  })

  it('detects binary content (NUL bytes) and substitutes a placeholder', () => {
    const result = classifyGitBlob('abc\0def', 0)
    assert.equal(result.exists, true)
    assert.equal(result.isBinary, true)
    assert.match(result.content, /Binary file/)
    assert.doesNotMatch(result.content, /def/)
  })

  it('returns text content unchanged for a normal blob', () => {
    const result = classifyGitBlob('hello\nworld\n', 0)
    assert.deepEqual(result, { content: 'hello\nworld\n', exists: true, isBinary: false })
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

describe('getGitFileDiff image preview', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]) => spawnSync('git', args, { cwd: repo })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-image-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
    git('add', 'logo.png')
    git('commit', '-qm', 'init')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('returns data URLs for a modified image', async () => {
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xff, 0xff, 0xff]),
    )
    const diff = await getGitFileDiff('logo.png', false)
    assert.ok(diff)
    assert.match(diff!.beforeImage ?? '', /^data:image\/png;base64,/)
    assert.match(diff!.afterImage ?? '', /^data:image\/png;base64,/)
    assert.notEqual(diff!.beforeImage, diff!.afterImage)
  })

  it('returns only the after image for an untracked image', async () => {
    await writeFile(
      join(repo, 'new.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc, 0xdd]),
    )
    const diff = await getGitFileDiff('new.png', false)
    assert.ok(diff)
    assert.equal(diff!.beforeImage, null)
    assert.match(diff!.afterImage ?? '', /^data:image\/png;base64,/)
  })

  it('returns before and after images for a staged modification', async () => {
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x11, 0x22, 0x33, 0x44]),
    )
    git('add', 'logo.png')
    const diff = await getGitFileDiff('logo.png', true)
    assert.ok(diff)
    assert.match(diff!.beforeImage ?? '', /^data:image\/png;base64,/)
    assert.match(diff!.afterImage ?? '', /^data:image\/png;base64,/)
    assert.notEqual(diff!.beforeImage, diff!.afterImage)
  })
})
