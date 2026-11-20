import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { internalGit, internalGitBundleCreate } from './internal-git-exec.ts'

function plainGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('internalGit', () => {
  let dir = ''
  let repo = ''
  let bundle = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copse-internal-git-'))
    repo = join(dir, 'repo')
    bundle = join(dir, 'carry-out.bundle')
    mkdirSync(repo)
    plainGit(repo, ['init', '-q', '-b', 'main'])
    plainGit(repo, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@x',
      'commit',
      '--allow-empty',
      '-qm',
      'init',
    ])
    plainGit(repo, ['bundle', 'create', '-q', bundle, 'HEAD', 'main'])
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('fetches from a local bundle', async () => {
    await internalGit(repo, ['fetch', '--no-tags', bundle, 'refs/heads/main:refs/copse/test'])
    assert.equal(
      await internalGit(repo, ['rev-parse', 'refs/copse/test']),
      plainGit(repo, ['rev-parse', 'HEAD']),
    )
  })

  // Carry-out imports a bundle by path. A checkout whose config rewrites that
  // path to an ssh:// URL must not get its `core.sshCommand` run on the host.
  it("never runs a checkout's ssh command when insteadOf rewrites a bundle path", async () => {
    const marker = join(dir, 'ssh-ran')
    const ssh = join(dir, 'ssh.sh')
    writeFileSync(ssh, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o700 })
    plainGit(repo, ['config', 'core.sshCommand', ssh])
    plainGit(repo, ['config', 'url.ssh://example.invalid/.insteadOf', '/'])

    await assert.rejects(
      internalGit(repo, ['fetch', '--no-tags', bundle, 'refs/heads/main:refs/copse/test']),
    )
    assert.equal(existsSync(marker), false, 'core.sshCommand ran')
  })

  // With an alternate object store, fetch asks `core.alternateRefsCommand` for
  // the alternate's refs, even over the `file` transport alone.
  it("never runs a checkout's alternateRefsCommand while fetching a bundle", async () => {
    const alternate = join(dir, 'alternate')
    mkdirSync(alternate)
    plainGit(alternate, ['init', '-q', '-b', 'other'])
    plainGit(alternate, [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@x',
      'commit',
      '--allow-empty',
      '-qm',
      'alternate',
    ])
    const target = join(dir, 'target')
    mkdirSync(target)
    plainGit(target, ['init', '-q', '-b', 'other'])
    writeFileSync(
      join(target, '.git/objects/info/alternates'),
      `${join(alternate, '.git/objects')}\n`,
    )
    const marker = join(dir, 'alternate-refs-ran')
    const command = join(dir, 'alternate-refs.sh')
    writeFileSync(command, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o700 })
    plainGit(target, ['config', 'core.alternateRefsCommand', command])

    await internalGit(target, ['fetch', '--no-tags', bundle, 'refs/heads/main:refs/copse/test'])
    assert.equal(existsSync(marker), false, 'core.alternateRefsCommand ran')
    assert.equal(
      await internalGit(target, ['rev-parse', 'refs/copse/test']),
      plainGit(repo, ['rev-parse', 'HEAD']),
    )
  })

  it("keeps Git's own error when a bundle fails outside a partial clone", async () => {
    await assert.rejects(
      internalGitBundleCreate(repo, join(dir, 'x.bundle'), ['refs/heads/missing']),
      (error: unknown) => error instanceof Error && !/partial clone/.test(error.message),
    )
  })
})
