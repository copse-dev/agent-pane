import assert from 'node:assert/strict'
import { it } from 'node:test'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  symlinkSync,
  chmodSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { githubArchiveBase, githubArchiveUrl } from './openai-archive.ts'
import { prepareGitTransfer } from './openai-git-transfer.ts'
import { setupHostedArchive } from './openai-archive-worker.ts'
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

it('restores a >50 MiB pinned archive plus unpushed, binary, deleted, executable and untracked changes exactly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-git-'))
  try {
    const host = join(root, 'host'),
      guest = join(root, 'guest'),
      files = join(root, 'files')
    mkdirSync(host)
    mkdirSync(join(guest, 'inputs'), { recursive: true })
    git(host, ['init', '-b', 'feature'])
    git(host, ['config', 'user.name', 'Test'])
    git(host, ['config', 'user.email', 'test@example.com'])
    writeFileSync(join(host, 'large.bin'), randomBytes(51 * 1024 * 1024))
    writeFileSync(join(host, 'remove.txt'), 'remove')
    writeFileSync(join(host, '.gitignore'), 'secret\n')
    git(host, ['add', '.'])
    git(host, ['commit', '-m', 'remote'])
    git(host, ['remote', 'add', 'origin', 'git@github.com:example/project.git'])
    git(host, ['update-ref', 'refs/remotes/origin/feature', 'HEAD'])
    const archiveBase = await githubArchiveBase(host)
    assert.equal(archiveBase.repository, 'example/project')
    const archive = execFileSync(
      'git',
      ['archive', '--format=tar.gz', '--prefix=source/', archiveBase.commit],
      { cwd: host, maxBuffer: 60 * 1024 * 1024 },
    )
    rmSync(join(host, 'remove.txt'))
    writeFileSync(join(host, 'binary'), Buffer.from([0, 255, 1]))
    git(host, ['add', '.'])
    git(host, ['commit', '-m', 'unpushed'])
    writeFileSync(join(host, 'script'), '#!/bin/sh\ntrue\n')
    chmodSync(join(host, 'script'), 0o755)
    symlinkSync('script', join(host, 'link'))
    writeFileSync(join(host, 'secret'), 'never upload')
    const transfer = await prepareGitTransfer(host, files, archiveBase.commit)
    const metadata = readFileSync(join(files, 'archive-metadata.json'), 'utf8')
    // Metadata originates in our producer; avoid interpreting it in the test.
    writeFileSync(
      join(guest, 'inputs/archive.json'),
      metadata.replace(
        /}$/,
        ',"url":"https://codeload.github.com/example/project/archive?token=temporary"}',
      ),
    )
    copyFileSync(join(files, 'source.bundle'), join(guest, 'inputs/source.bundle'))
    assert.ok(readFileSync(join(files, 'source.bundle')).length < 4096)
    await setupHostedArchive(guest, transfer.base, async (_url, init) => {
      assert.equal(init?.redirect, 'error')
      assert.equal(new Headers(init.headers).get('authorization'), null)
      return new Response(archive)
    })
    assert.equal(git(join(guest, 'repo'), ['rev-parse', 'HEAD']), transfer.base)
    assert.equal(git(join(guest, 'repo'), ['rev-parse', 'HEAD^{tree}']), transfer.tree)
    assert.equal(existsSync(join(guest, 'inputs/archive.json')), false)
    assert.equal(existsSync(join(guest, 'repo/secret')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('blocks LFS attributes before archive or hosted API requests are needed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-lfs-'))
  try {
    git(root, ['init'])
    git(root, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    ])
    for (const [name, contents] of [
      ['.gitattributes', '*.bin filter=lfs diff=lfs merge=lfs -text\n'],
      ['pointer', 'version https://git-lfs.github.com/spec/v1\noid sha256:abcd\nsize 100\n'],
      ['.lfsconfig', '[lfs]\nurl = https://example.com/lfs\n'],
    ]) {
      assert.ok(name && contents)
      writeFileSync(join(root, name), contents)
      await assert.rejects(
        prepareGitTransfer(root, join(root, '.git/transfer'), git(root, ['rev-parse', 'HEAD'])),
        /Git LFS repositories/,
      )
      rmSync(join(root, name))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('captures only an allowlisted manual GitHub redirect and never forwards authorization', async () => {
  const previous = process.env['GH_TOKEN']
  process.env['GH_TOKEN'] = 'host-only-test-token'
  try {
    const url = await githubArchiveUrl(
      'example/project',
      'a'.repeat(40),
      AbortSignal.timeout(1000),
      async (url, init) => {
        assert.equal(
          new URL(typeof url === 'string' || url instanceof URL ? url : url.url).host,
          'api.github.com',
        )
        assert.equal(init?.redirect, 'manual')
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer host-only-test-token')
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://codeload.github.com/example/project/legacy.tar.gz/abc?token=temporary',
          },
        })
      },
    )
    assert.ok(!url.includes('host-only'))
    for (const location of [
      'https://evil.example/project',
      'https://codeload.github.com/other/repo/a',
      'http://codeload.github.com/example/project/a',
    ])
      await assert.rejects(
        githubArchiveUrl(
          'example/project',
          'a'.repeat(40),
          AbortSignal.timeout(1000),
          async () => new Response(null, { status: 302, headers: { location } }),
        ),
        /unsupported archive/,
      )
  } finally {
    if (previous === undefined) delete process.env['GH_TOKEN']
    else process.env['GH_TOKEN'] = previous
  }
})

it('fails closed for expired URLs and archive tree mismatches, without leaving the URL file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-errors-'))
  try {
    git(root, ['init'])
    git(root, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    ])
    const archive = execFileSync(
      'git',
      ['archive', '--format=tar.gz', '--prefix=source/', 'HEAD'],
      { cwd: root },
    )
    for (const scenario of ['expired', 'mismatch']) {
      const guest = join(root, scenario)
      mkdirSync(join(guest, 'inputs'), { recursive: true })
      writeFileSync(
        join(guest, 'inputs/archive.json'),
        JSON.stringify({
          tree: 'a'.repeat(40),
          snapshotTree: 'a'.repeat(40),
          commit: 'unused',
          url: 'https://codeload.github.com/example/project/archive?token=secret',
        }),
      )
      await assert.rejects(
        setupHostedArchive(guest, 'a'.repeat(40), async () =>
          scenario === 'expired' ? new Response(null, { status: 404 }) : new Response(archive),
        ),
        scenario === 'expired' ? /URL expired/ : /tree does not match/,
      )
      assert.equal(existsSync(join(guest, 'inputs/archive.json')), false)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects an oversized local binary overlay with an actionable error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-overlay-'))
  try {
    git(root, ['init'])
    git(root, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'base',
    ])
    const base = git(root, ['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'large-local.bin'), randomBytes(41 * 1024 * 1024))
    await assert.rejects(
      prepareGitTransfer(root, join(root, '.git/transfer'), base),
      /Local changes exceed the hosted upload budget/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
