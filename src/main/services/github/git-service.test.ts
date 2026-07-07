import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  classifyGitBlob,
  getDefaultBranch,
  getGitDiffText,
  getGitFileDiff,
  getGitShowText,
  parsePorcelainV1,
  resolveWorkspaceRelativeGitPath,
  sumDiffNumstat,
  toGitShowPath,
} from './git-service.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setGitAvailableForTest } from '../tool-availability.ts'
import { DEFAULT_GIT_BRANCH } from '@shared/types/git.ts'

describe('sumDiffNumstat', () => {
  it('sums additions and deletions across rows', () => {
    const raw = '3\t1\tsrc/foo.ts\n10\t5\tsrc/bar.ts\n'
    assert.deepEqual(sumDiffNumstat(raw), { additions: 13, deletions: 6 })
  })

  it('treats binary placeholder dashes as zero', () => {
    const raw = '-\t-\tlogo.png\n2\t0\tsrc/baz.ts\n'
    assert.deepEqual(sumDiffNumstat(raw), { additions: 2, deletions: 0 })
  })

  it('returns zeros for empty output', () => {
    assert.deepEqual(sumDiffNumstat(''), { additions: 0, deletions: 0 })
  })
})

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

  const git = (...args: string[]): SpawnSyncReturns<Buffer> => spawnSync('git', args, { cwd: repo })

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

describe('getGitFileDiff staged blob', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-file-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    const lines = ['// header', 'export const value = 1']
    await writeFile(join(repo, 'staged.ts'), `${lines.join('\n')}\n`)
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(join(repo, 'staged.ts'), '// header\nexport const value = 2\n')
    git('add', 'staged.ts')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('reads HEAD and index blobs for a staged file', async () => {
    const diff = await getGitFileDiff('staged.ts', true)
    assert.ok(diff)
    assert.match(diff.before, /value = 1/)
    assert.match(diff.after, /value = 2/)
    assert.notEqual(diff.before, diff.after)
  })
})

describe('getGitFileDiff image preview', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<Buffer> => spawnSync('git', args, { cwd: repo })

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
    assert.match(diff.beforeImage ?? '', /^data:image\/png;base64,/)
    assert.match(diff.afterImage ?? '', /^data:image\/png;base64,/)
    assert.notEqual(diff.beforeImage, diff.afterImage)
  })

  it('returns only the after image for an untracked image', async () => {
    await writeFile(
      join(repo, 'new.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa, 0xbb, 0xcc, 0xdd]),
    )
    const diff = await getGitFileDiff('new.png', false)
    assert.ok(diff)
    assert.equal(diff.beforeImage, null)
    assert.match(diff.afterImage ?? '', /^data:image\/png;base64,/)
  })

  it('returns before and after images for a staged modification', async () => {
    await writeFile(
      join(repo, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x11, 0x22, 0x33, 0x44]),
    )
    git('add', 'logo.png')
    const diff = await getGitFileDiff('logo.png', true)
    assert.ok(diff)
    assert.match(diff.beforeImage ?? '', /^data:image\/png;base64,/)
    assert.match(diff.afterImage ?? '', /^data:image\/png;base64,/)
    assert.notEqual(diff.beforeImage, diff.afterImage)
  })
})

describe('getGitFileDiff unstaged blob', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-unstaged-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(
      join(repo, 'README.md'),
      ['# Title', '', 'Intro paragraph.', '', '## Section', ''].join('\n'),
    )
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(
      join(repo, 'README.md'),
      ['# Title', '', 'Intro paragraph.', '', '', '', '', '', '## Section', ''].join('\n'),
    )
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('returns index content as before and working tree as after for unstaged edits', async () => {
    const diff = await getGitFileDiff('README.md', false)
    assert.ok(diff)
    assert.match(diff.before, /Intro paragraph\.\n\n## Section/)
    assert.match(diff.after, /Intro paragraph\.\n\n\n\n\n\n## Section/)
    assert.notEqual(diff.before, diff.after)
  })
})

describe('toGitShowPath', () => {
  it('prefixes workspace-relative paths for git show', () => {
    assert.equal(toGitShowPath('README.md'), './README.md')
    assert.equal(toGitShowPath('./README.md'), './README.md')
    assert.equal(toGitShowPath('src/foo.ts'), './src/foo.ts')
  })
})

describe('resolveWorkspaceRelativeGitPath', () => {
  let root = ''
  let restore: (() => void) | undefined

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'copse-git-rel-path-'))
    await mkdir(join(root, 'src'), { recursive: true })
    restore = setWorkspaceRootForTest(root)
  })

  after(async () => {
    restore?.()
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('keeps an in-workspace relative path unchanged', () => {
    assert.equal(resolveWorkspaceRelativeGitPath('src/foo.ts'), join('src', 'foo.ts'))
  })

  it('normalizes a redundant in-workspace path', () => {
    assert.equal(resolveWorkspaceRelativeGitPath('./src/../src/foo.ts'), join('src', 'foo.ts'))
  })

  it('maps an absolute in-workspace path back to workspace-relative', () => {
    assert.equal(
      resolveWorkspaceRelativeGitPath(join(root, 'src', 'foo.ts')),
      join('src', 'foo.ts'),
    )
  })

  it('rejects a path that escapes the workspace root', () => {
    assert.throws(() => resolveWorkspaceRelativeGitPath('../escape.ts'), /outside workspace/)
  })
})

describe('getGitFileDiff subdirectory workspace', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-subdir-diff-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await mkdir(join(repo, 'widget'), { recursive: true })
    await writeFile(
      join(repo, 'widget', 'README.md'),
      ['# Title', '', 'Intro paragraph.', '', '## Section', ''].join('\n'),
    )
    git('add', '.')
    git('commit', '-qm', 'init')
    await writeFile(
      join(repo, 'widget', 'README.md'),
      ['# Title', '', 'Intro paragraph.', '', '', '', '', '', '## Section', ''].join('\n'),
    )
    restore = setWorkspaceRootForTest(join(repo, 'widget'))
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('reads index/HEAD blobs when the workspace is a repo subdirectory', async () => {
    const diff = await getGitFileDiff('README.md', false)
    assert.ok(diff)
    assert.match(diff.before, /Intro paragraph\.\n\n## Section/)
    assert.match(diff.after, /Intro paragraph\.\n\n\n\n\n\n## Section/)
    assert.notEqual(diff.before, diff.after)
  })
})

describe('getGitShowText', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-show-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await writeFile(join(repo, 'file.txt'), 'first version\n')
    git('add', '.')
    git('commit', '-qm', 'add file')
    await writeFile(join(repo, 'file.txt'), 'second version\n')
    git('commit', '-aqm', 'change file')
    restore = setWorkspaceRootForTest(repo)
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('shows a file at a specific ref via ref:path', async () => {
    const atParent = await getGitShowText('HEAD~1', 'file.txt')
    assert.equal(atParent, 'first version')
    const atHead = await getGitShowText('HEAD', 'file.txt')
    assert.equal(atHead, 'second version')
  })

  it('shows a commit (message + diff) when no path is given', async () => {
    const out = await getGitShowText('HEAD')
    assert.match(out, /change file/)
    assert.match(out, /-first version/)
    assert.match(out, /\+second version/)
  })

  it('rejects a ref that embeds an inline :path', async () => {
    const out = await getGitShowText('HEAD:file.txt')
    assert.match(out, /pass a file path via the `path` argument/)
  })

  it('rejects a path that escapes the workspace root', async () => {
    const out = await getGitShowText('HEAD', '../escape.txt')
    assert.match(out, /outside workspace/)
  })

  it('rejects a ref that would be parsed as a git option (option injection)', async () => {
    const escaped = join(repo, 'escaped-by-option-injection.txt')
    const out = await getGitShowText(`--output=${escaped}`)
    assert.match(out, /cannot start with "-"/)
    // The rejection must happen before git runs, so no file is written.
    const written = await readFile(escaped, 'utf8').catch(() => null)
    assert.equal(written, null)
  })

  it('reports a blank ref', async () => {
    const out = await getGitShowText('  ')
    assert.match(out, /ref .* is required/)
  })
})

describe('getGitShowText subdirectory workspace', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-show-subdir-'))
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    await mkdir(join(repo, 'widget'), { recursive: true })
    await writeFile(join(repo, 'widget', 'file.txt'), 'inside workspace\n')
    await writeFile(join(repo, 'outside.txt'), 'outside workspace\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    restore = setWorkspaceRootForTest(join(repo, 'widget'))
    setGitAvailableForTest(true)
  })

  after(async () => {
    setGitAvailableForTest(null)
    restore?.()
    if (repo) await rm(repo, { recursive: true, force: true })
  })

  it('resolves ref:path relative to the workspace subdirectory', async () => {
    const out = await getGitShowText('HEAD', 'file.txt')
    assert.equal(out, 'inside workspace')
  })

  it('limits the commit view to the workspace subtree', async () => {
    const out = await getGitShowText('HEAD')
    assert.match(out, /widget\/file\.txt/)
    assert.doesNotMatch(out, /outside\.txt/)
  })
})

describe('getDefaultBranch', { skip: !gitOk && 'git not installed' }, () => {
  let repo = ''
  let restore: (() => void) | undefined

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' })

  afterEach(() => {
    restore?.()
    restore = undefined
  })

  after(async () => {
    if (repo) await rm(repo, { recursive: true, force: true })
    repo = ''
  })

  it('uses init.defaultBranch from git config when origin is absent', async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-default-branch-'))
    git('init', '-q')
    git('config', 'init.defaultBranch', 'develop')
    restore = setWorkspaceRootForTest(repo)

    assert.equal(await getDefaultBranch(), 'develop')
  })

  it(`falls back to ${DEFAULT_GIT_BRANCH} when no remote and no configured default`, async () => {
    repo = await mkdtemp(join(tmpdir(), 'copse-git-default-branch-fallback-'))
    git('init', '-q')
    git('config', '--unset', 'init.defaultBranch')
    restore = setWorkspaceRootForTest(repo)

    assert.equal(await getDefaultBranch(), DEFAULT_GIT_BRANCH)
  })
})
