import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planScopedNetwork, scopedNetworkEnv } from './network-scoped-shell.ts'
import { repoNetworkFactsFromConfig } from './git-network-facts.ts'

/**
 * Real git against planted config: what a contained command can write into a
 * shared checkout's `.git/config` between the gate's scan and git's own read.
 * Each case runs once without the scoped env, to show the planted program does
 * run, and once with it, where it must not.
 */
describe('scoped git env against planted config', () => {
  const identity = {
    GIT_AUTHOR_NAME: 'Copse Test',
    GIT_AUTHOR_EMAIL: 'copse@example.invalid',
    GIT_COMMITTER_NAME: 'Copse Test',
    GIT_COMMITTER_EMAIL: 'copse@example.invalid',
  }
  const run = (cwd: string, args: string[], env: Record<string, string> = {}): number => {
    // Drop GIT_CONFIG_* inherited from the runner so only the case's own apply.
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_CONFIG_')),
    )
    return (
      spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd,
        env: { ...base, ...identity, ...env },
        stdio: 'pipe',
      }).status ?? -1
    )
  }

  function fixture(): { dir: string; remote: string; local: string; marker: string } {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-scoped-git-')))
    const remote = join(dir, 'remote.git')
    const seed = join(dir, 'seed')
    const local = join(dir, 'local')
    execFileSync('git', ['init', '-q', '--bare', remote])
    mkdirSync(seed)
    run(seed, ['init', '-q'])
    writeFileSync(join(seed, 'a.txt'), 'a\n')
    run(seed, ['add', '.'])
    run(seed, ['commit', '-q', '-m', 'a'])
    run(seed, ['push', '-q', remote, 'HEAD:refs/heads/main'])
    run(dir, ['clone', '-q', '-b', 'main', remote, local])
    // Another commit for the fetch to negotiate.
    writeFileSync(join(seed, 'b.txt'), 'b\n')
    run(seed, ['add', '.'])
    run(seed, ['commit', '-q', '-m', 'b'])
    run(seed, ['push', '-q', remote, 'HEAD:refs/heads/main'])
    return { dir, remote, local, marker: join(dir, 'ran') }
  }

  /** The env a scoped run of `command` gets, with `file` allowed so the local remote is reachable. */
  function scopedEnv(command: string, local: string): Record<string, string> {
    const facts = repoNetworkFactsFromConfig(
      '[remote "origin"]\n\turl = https://github.com/acme/app\n',
      [local],
      join(local, '.git', 'hooks'),
    )
    const assessment = planScopedNetwork(command, facts)
    if (assessment.action !== 'scope') assert.fail(`expected a scope: ${assessment.reason}`)
    return {
      ...scopedNetworkEnv(assessment.plan, { githubToken: null }),
      GIT_ALLOW_PROTOCOL: 'file',
    }
  }

  it('does not run an alternate-refs command planted for fetch negotiation', () => {
    const { dir, local, marker } = fixture()
    try {
      const alternate = join(dir, 'alt.git')
      execFileSync('git', ['clone', '-q', '--bare', join(dir, 'remote.git'), alternate])
      writeFileSync(join(local, '.git', 'objects', 'info', 'alternates'), `${alternate}/objects\n`)
      run(local, [
        'config',
        'core.alternateRefsCommand',
        `touch ${marker}; git --git-dir="$1" for-each-ref '--format=%(objectname)'`,
      ])

      run(local, ['fetch', '-q', 'origin'])
      assert.ok(existsSync(marker), 'control: the planted command runs during a plain fetch')
      rmSync(marker)
      run(local, ['update-ref', '-d', 'refs/remotes/origin/main'])

      run(local, ['fetch', '-q', 'origin'], scopedEnv('git fetch origin', local))
      assert.equal(existsSync(marker), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not run a remote helper named by remote.*.vcs or an ext:: URL', () => {
    const { dir, local, marker } = fixture()
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'git-remote-evil'), `#!/bin/sh\ntouch ${marker}\n`)
      chmodSync(join(bin, 'git-remote-evil'), 0o755)
      run(local, ['config', 'remote.origin.vcs', 'evil'])
      const path = `${bin}:${process.env['PATH'] ?? ''}`

      run(local, ['fetch', '-q', 'origin'], { PATH: path })
      assert.ok(existsSync(marker), 'control: the helper runs during a plain fetch')
      rmSync(marker)

      run(local, ['fetch', '-q', 'origin'], { ...scopedEnv('git fetch origin', local), PATH: path })
      assert.equal(existsSync(marker), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs a push with the hooks directory the gate pinned, not a planted one', () => {
    const { dir, local, marker } = fixture()
    try {
      const planted = join(dir, 'planted-hooks')
      mkdirSync(planted)
      writeFileSync(join(planted, 'pre-push'), `#!/bin/sh\ntouch ${marker}\n`)
      chmodSync(join(planted, 'pre-push'), 0o755)
      run(local, ['config', 'core.hooksPath', planted])
      run(local, ['checkout', '-q', '-b', 'feature'])

      run(local, ['push', '-q', 'origin', 'feature'])
      assert.ok(existsSync(marker), 'control: the planted hook runs during a plain push')
      rmSync(marker)

      run(
        local,
        ['push', '-q', 'origin', 'feature:feature-2'],
        scopedEnv('git push origin feature', local),
      )
      assert.equal(existsSync(marker), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
