import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { internalGitEnv, internalGitTransport, withGitInvocationArgs } from './git-invocation.ts'
import { internalGit } from './internal-git-exec.ts'
import { runCommand } from '../exec/command-runner.ts'
import {
  initProjectSandbox,
  isProjectSandboxEnabled,
  shutdownProjectSandbox,
} from '../../project-sandbox/index.ts'
import { setProjectSandboxEnabled, spawnInProjectSandbox } from '../../project-sandbox/spawn.ts'

describe('internal Git policy', () => {
  const cleanups: string[] = []

  afterEach(async () => {
    for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true })
  })

  async function fixture(): Promise<{
    repo: string
    marker: string
    script: string
    git: (args: string[]) => string
  }> {
    const temp = await mkdtemp(join(tmpdir(), 'copse-git-policy-'))
    cleanups.push(temp)
    const repo = join(temp, 'repo')
    const marker = join(temp, 'outside-repo-marker')
    const script = join(repo, 'helper.sh')
    await mkdir(repo)
    const git = (args: string[]): string =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
        {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Copse Test',
            GIT_AUTHOR_EMAIL: 'copse@example.invalid',
            GIT_COMMITTER_NAME: 'Copse Test',
            GIT_COMMITTER_EMAIL: 'copse@example.invalid',
          },
        },
      )
    git(['init', '-q', '-b', 'main'])
    await writeFile(join(repo, 'tracked.txt'), 'before\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-q', '-m', 'initial'])
    // An absolute marker outside the checkout proves this without relying on
    // a sandbox being available. No network, secrets, or persistent payload.
    await writeFile(
      script,
      `#!/bin/sh\nprintf executed > '${marker.replaceAll("'", "'\\''")}'\nprintf 'token\\0'\n`,
      { mode: 0o700 },
    )
    return { repo, marker, script, git }
  }

  it('blocks aliases and caller-supplied global config overrides', () => {
    for (const args of [
      [],
      ['repo-alias'],
      ['commit', '-m', 'bypass'],
      ['-c', 'core.fsmonitor=evil', 'status'],
    ]) {
      assert.throws(() => withGitInvocationArgs(args), /Unsupported internal Git command/)
    }
  })

  it('admits cherry-pick and bundle only in the shapes run adoption and transfer use', () => {
    const sha = 'a'.repeat(40)
    for (const args of [
      ['cherry-pick', '--abort'],
      ['cherry-pick', '--no-edit', '--allow-empty-message', sha, 'b'.repeat(64)],
      ['cherry-pick', '--no-edit', sha],
    ]) {
      assert.deepEqual(withGitInvocationArgs(args).slice(-args.length), args)
    }
    for (const args of [
      ['cherry-pick', sha],
      ['cherry-pick', '--no-edit'],
      // A strategy names an external `git-merge-<strategy>` program.
      ['cherry-pick', '--no-edit', '-s', 'payload', sha],
      ['cherry-pick', '--no-edit', '--strategy=payload', sha],
      ['cherry-pick', '--no-edit', '-S', sha],
      ['cherry-pick', '--edit', sha],
      ['cherry-pick', '--no-edit', 'HEAD~1'],
    ]) {
      assert.throws(() => withGitInvocationArgs(args), /Unsupported internal Git cherry-pick/)
    }
    for (const subcommand of ['create', 'verify', 'list-heads']) {
      assert.ok(withGitInvocationArgs(['bundle', subcommand, 'x.bundle']).includes(subcommand))
    }
    for (const args of [['bundle'], ['bundle', 'unbundle', 'x.bundle']]) {
      assert.throws(() => withGitInvocationArgs(args), /Unsupported internal Git bundle/)
    }
  })

  it('admits grep only in the LFS-scan shapes the hosted transfer uses', () => {
    const sha = 'a'.repeat(40)
    for (const args of [
      // The two calls in `prepareGitTransfer`.
      [
        'grep',
        '-I',
        '-E',
        'filter[=[:space:]]+lfs',
        sha,
        '--',
        '.gitattributes',
        '**/.gitattributes',
      ],
      ['grep', '-I', '-l', '-E', '^version https://git-lfs.github.com/spec/v1$', sha],
      ['grep', '-I', '-E', 'lfs', 'b'.repeat(64)],
      ['grep', '-E', 'lfs', '--', 'a.txt'],
      ['grep', 'lfs'],
    ]) {
      const [, ...rest] = args
      const prepared = withGitInvocationArgs(args)
      assert.deepEqual(prepared.slice(prepared.indexOf('grep')), ['grep', '--no-textconv', ...rest])
    }
    for (const args of [
      // Git accepts unambiguous abbreviations of `--open-files-in-pager`.
      ['grep', '--open=/payload', 'x', sha],
      ['grep', '--open-files=/payload', 'x', sha],
      ['grep', '--open-files-in-pager=/payload', 'x', sha],
      // A bundled short flag carries the pager program after `-O`.
      ['grep', '-IO/payload', 'x', sha],
      ['grep', '-O/payload', 'x', sha],
      ['grep', '-O', '/payload', 'x', sha],
      // After the injected `--no-textconv`, this would run textconv drivers.
      ['grep', '-I', '-E', '--textconv', 'x', sha],
      ['grep', '-I', '-E', 'x', sha, '--textconv'],
      ['grep', '-IE', 'x', sha],
      ['grep', '-e', 'x', sha],
      ['grep', '-I', '-E'],
      ['grep', '-I', '-E', 'x', 'HEAD'],
      ['grep', '-I', '-E', 'x', sha, 'a.txt'],
    ]) {
      assert.throws(() => withGitInvocationArgs(args), /Unsupported internal Git grep/)
    }
  })

  it('never runs a grep pager or textconv program on the host runner', async () => {
    const { repo, marker, script, git } = await fixture()
    git(['config', 'diff.untrusted.textconv', script])
    await writeFile(join(repo, '.gitattributes'), '*.txt diff=untrusted\n')
    git(['add', '.gitattributes'])
    git(['commit', '-q', '-m', 'attributes'])
    const head = git(['rev-parse', 'HEAD']).trim()
    // `token` is the textconv output, so that search matches and exits 0.
    for (const args of [
      [`--open=${script}`, 'before'],
      ['--textconv', 'token', head],
    ]) {
      git(['grep', ...args])
      assert.equal(existsSync(marker), true, 'fixture must execute without the policy')
      await rm(marker)
      await assert.rejects(internalGit(repo, ['grep', ...args]), /Unsupported internal Git grep/)
    }
    assert.equal(
      await internalGit(repo, ['grep', '-I', '-l', '-E', '^before$', head, '--', 'tracked.txt']),
      `${head}:tracked.txt`,
    )
    assert.equal(existsSync(marker), false)
  })

  it('admits clone only as a local, checkout-free, template-free submodule copy', () => {
    const exact = [
      'clone',
      '--no-checkout',
      '--template=',
      '--separate-git-dir',
      '/repo/.git/worktrees/t/modules/lib',
      '--',
      '/repo/.git/modules/lib',
      '/thread/lib',
    ]
    assert.deepEqual(withGitInvocationArgs(exact).slice(-exact.length), exact)
    for (const args of [
      ['clone', '/repo/.git/modules/lib', '/thread/lib'],
      ['clone', '--upload-pack=/payload', ...exact.slice(1)],
      ['clone', '--config', 'core.fsmonitor=/payload', ...exact.slice(1)],
      ['clone', '--recurse-submodules', ...exact.slice(1)],
      [...exact.slice(0, 2), '--template=/payload/hooks', ...exact.slice(3)],
      [...exact, 'extra'],
    ]) {
      assert.throws(() => withGitInvocationArgs(args), /Unsupported internal Git clone/)
    }
    // A local clone may use the file transport and nothing else; fetch and
    // push keep their remote transports; every other command gets none.
    assert.equal(internalGitTransport('clone'), 'local')
    assert.equal(internalGitEnv({}, internalGitTransport('clone'))['GIT_ALLOW_PROTOCOL'], 'file')
    assert.equal(internalGitTransport('fetch'), 'remote')
    assert.equal(internalGitTransport('push'), 'remote')
    assert.equal(internalGitTransport('status'), 'none')
    assert.equal(internalGitTransport('-c'), 'none')
    assert.equal(internalGitEnv({}, 'network')['GIT_ALLOW_PROTOCOL'], 'https:http:ssh')
    assert.deepEqual(
      withGitInvocationArgs(['fetch', 'https://example.invalid/repo'], 'internal-network'),
      withGitInvocationArgs(['fetch', 'https://example.invalid/repo'], 'internal'),
    )
  })

  it('strips config/executable injection while retaining backup index and identity', () => {
    const env = internalGitEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'payload',
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=payload'",
      GIT_EXTERNAL_DIFF: 'payload',
      GIT_EXEC_PATH: '/payload',
      GIT_SSH: '/payload/ssh',
      GIT_SSH_COMMAND: '/payload/ssh --option',
      GIT_SSH_VARIANT: 'ssh',
      GIT_PROXY_COMMAND: '/payload/proxy',
      GIT_ASKPASS: '/payload/askpass',
      SSH_ASKPASS: '/payload/askpass',
      SSH_ASKPASS_REQUIRE: 'force',
      GIT_DIR: '/other-repo',
      GIT_COMMON_DIR: '/other-common-dir',
      GIT_WORK_TREE: '/other-work-tree',
      GIT_NAMESPACE: 'other-namespace',
      GIT_OBJECT_DIRECTORY: '/other-objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/alternate-objects',
      GIT_INDEX_FILE: '/scratch/index',
      GIT_AUTHOR_NAME: 'Copse',
    })
    assert.equal(env['GIT_CONFIG_COUNT'], undefined)
    assert.equal(env['GIT_CONFIG_PARAMETERS'], undefined)
    assert.equal(env['GIT_EXTERNAL_DIFF'], undefined)
    assert.equal(env['GIT_EXEC_PATH'], undefined)
    assert.equal(env['GIT_SSH'], undefined)
    assert.equal(env['GIT_SSH_COMMAND'], undefined)
    assert.equal(env['GIT_SSH_VARIANT'], undefined)
    assert.equal(env['GIT_PROXY_COMMAND'], undefined)
    assert.equal(env['GIT_ASKPASS'], undefined)
    assert.equal(env['SSH_ASKPASS'], undefined)
    assert.equal(env['SSH_ASKPASS_REQUIRE'], undefined)
    assert.equal(env['GIT_DIR'], undefined)
    assert.equal(env['GIT_COMMON_DIR'], undefined)
    assert.equal(env['GIT_WORK_TREE'], undefined)
    assert.equal(env['GIT_NAMESPACE'], undefined)
    assert.equal(env['GIT_OBJECT_DIRECTORY'], undefined)
    assert.equal(env['GIT_ALTERNATE_OBJECT_DIRECTORIES'], undefined)
    assert.equal(env['GIT_INDEX_FILE'], '/scratch/index')
    assert.equal(env['GIT_AUTHOR_NAME'], 'Copse')
    assert.equal(env['GIT_ALLOW_PROTOCOL'], '')
  })

  it('limits the user-command profile to explicit add/commit without disabling helpers', () => {
    const args = ['commit', '-m', 'literal message']
    assert.deepEqual(withGitInvocationArgs(args, 'user-command'), [
      '--no-pager',
      '-c',
      'color.ui=false',
      ...args,
    ])
    for (const command of ['repo-alias', '-c', 'status']) {
      assert.throws(
        () => withGitInvocationArgs([command], 'user-command'),
        /Unsupported user Git command/,
      )
    }
  })

  it('refuses a configured command when its required sandbox is unavailable', async () => {
    const { repo, git } = await fixture()
    await assert.rejects(
      async () =>
        runCommand('git', ['commit', '--allow-empty', '-m', 'must not run'], {
          cwd: repo,
          gitConfig: 'user-command',
          requireSandbox: true,
        }),
      /requires an active local project sandbox/,
    )
    assert.equal(git(['rev-list', '--count', 'HEAD']).trim(), '1')
  })

  it(
    'does not fall back to a raw spawn when the sandbox stops during cwd validation',
    { skip: process.platform !== 'darwin' },
    async (t) => {
      const { repo } = await fixture()
      await initProjectSandbox()
      if (!isProjectSandboxEnabled()) {
        t.skip('ASRT sandbox unavailable')
        return
      }
      try {
        const pending = spawnInProjectSandbox(process.execPath, ['-e', 'process.exit(0)'], {
          cwd: repo,
          requireSandbox: true,
          stdio: 'pipe',
        })
        setProjectSandboxEnabled(false)
        await assert.rejects(pending, /sandbox became unavailable/)
      } finally {
        await shutdownProjectSandbox()
      }
    },
  )

  it('never invokes an included fsmonitor during unsandboxed status or diff', async () => {
    const { repo, marker, script, git } = await fixture()
    const included = join(repo, 'included.config')
    git(['config', '--file', included, 'core.fsmonitor', script])
    git(['config', 'include.path', included])
    await writeFile(join(repo, 'tracked.txt'), 'after\n')
    git(['status', '--porcelain=v1'])
    assert.equal(existsSync(marker), true, 'fixture must execute without the policy')
    await rm(marker)
    for (const args of [
      ['status', '--porcelain=v1'],
      ['diff', '--', 'tracked.txt'],
    ]) {
      const result = await runCommand('git', args, {
        cwd: repo,
        unsandboxed: true,
        // A caller's env must not undo the policy after preparation.
        env: {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.fsmonitor',
          GIT_CONFIG_VALUE_0: script,
        },
      })
      assert.equal(result.code, 0, result.stderr)
      assert.equal(existsSync(marker), false)
      assert.ok(result.stdout.includes('tracked.txt'))
    }
  })

  it('renders ordinary diffs without external diff or textconv programs', async () => {
    const { repo, marker, script, git } = await fixture()
    git(['config', 'diff.external', script])
    git(['config', 'diff.untrusted.command', script])
    git(['config', 'diff.untrusted.textconv', script])
    await writeFile(join(repo, '.gitattributes'), '*.txt diff=untrusted\n')
    await writeFile(join(repo, 'tracked.txt'), 'after\n')
    const result = await runCommand('git', ['diff', '--', 'tracked.txt'], {
      cwd: repo,
      unsandboxed: true,
      env: { GIT_EXTERNAL_DIFF: script },
    })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /\+after/)
    assert.equal(existsSync(marker), false)
  })

  it('does not run hooks or a configured signer for automatic snapshots', async () => {
    const { repo, marker, script, git } = await fixture()
    const hooks = join(repo, 'repo-hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'reference-transaction'), `#!/bin/sh\nexec '${script}'\n`, {
      mode: 0o700,
    })
    git(['config', 'core.hooksPath', hooks])
    git(['config', 'commit.gpgSign', 'true'])
    git(['config', 'gpg.program', script])
    await writeFile(join(repo, 'tracked.txt'), 'after\n')
    const env = {
      GIT_AUTHOR_NAME: 'Copse',
      GIT_AUTHOR_EMAIL: 'copse@example.invalid',
      GIT_COMMITTER_NAME: 'Copse',
      GIT_COMMITTER_EMAIL: 'copse@example.invalid',
    }
    const tree = git(['rev-parse', 'HEAD^{tree}']).trim()
    const snapshot = await runCommand('git', ['commit-tree', tree, '-m', 'automatic snapshot'], {
      cwd: repo,
      env,
      unsandboxed: true,
    })
    assert.equal(snapshot.code, 0, snapshot.stderr)
    for (const args of [
      ['add', 'tracked.txt'],
      ['update-ref', 'refs/copse/test-snapshot', snapshot.stdout.trim()],
    ]) {
      const result = await runCommand('git', args, { cwd: repo, env, unsandboxed: true })
      assert.equal(result.code, 0, result.stderr)
    }
    assert.equal(existsSync(marker), false)
  })
})
