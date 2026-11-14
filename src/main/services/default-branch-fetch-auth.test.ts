import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { quote } from 'shell-quote'
import { build } from 'esbuild'
import { fetchDefaultBranchFromHost } from './default-branch-fetch.ts'
import { fetchOriginRefs } from './git-fetch-origin.ts'
import { fetchDefaultBranch, runWorktreeGit } from './worktree-manager.ts'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  leaseSshAskpassEnv,
  resetSshAskpassForTests,
  setSshAskpassUserDataDirForTests,
} from './ssh-workspace/askpass.ts'
import { setSshPromptHandler } from './ssh-workspace/ssh-prompt.ts'

async function withAuthFixture(
  check: (fixture: {
    root: string
    project: string
    home: string
    prompts: string[]
    requests: () => number
    git: (cwd: string, args: string[]) => string
    serveRepository: (repository: string) => void
  }) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'copse-background-auth-')))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'COPSE_DIR']
  const saved = keys.map((key) => process.env[key])
  const prompts: string[] = []
  let requests = 0
  let repository: string | null = null
  const server = createServer((request, response) => {
    requests += 1
    if (
      !repository ||
      request.headers.authorization !==
        `Basic ${Buffer.from('fixture:owned-only').toString('base64')}`
    ) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="owned-fixture"' })
      response.end('Authentication required')
      return
    }
    // Real Git's dumb HTTP transport, serving only this owned bare repository.
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname.replace(
      /^\/repo\.git\//,
      '',
    )
    if (
      !/^(HEAD|info\/refs|objects\/[0-9a-f/]+|objects\/info\/packs|objects\/pack\/pack-[0-9a-f]+\.(pack|idx))$/.test(
        path,
      )
    ) {
      response.writeHead(404).end()
      return
    }
    void readFile(join(repository, path)).then(
      (bytes) => {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        response.end(bytes)
      },
      () => response.writeHead(404).end(),
    )
  })
  const git = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).trim()
  try {
    await mkdir(home)
    await mkdir(project)
    process.env['HOME'] = home
    process.env['XDG_CONFIG_HOME'] = join(home, '.config')
    process.env['COPSE_DIR'] = join(root, 'profile')
    // Empty helper resets any system credential chain; no daily credentials.
    git(root, ['config', '--file', join(home, '.gitconfig'), 'credential.helper', ''])
    const fallback = join(root, 'configured-askpass.sh')
    await writeFile(
      fallback,
      `#!/bin/sh\nprintf called >> ${quote([join(root, 'fallback-called')])}\nexit 1\n`,
      { mode: 0o700 },
    )
    git(root, ['config', '--file', join(home, '.gitconfig'), 'core.askPass', fallback])
    git(root, ['init', '-q', '-b', 'main', project])
    await writeFile(join(project, 'README.md'), 'Committed project\n')
    git(project, ['add', 'README.md'])
    git(project, [
      '-c',
      'user.name=Copse Test',
      '-c',
      'user.email=copse@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Initial',
    ])
    git(project, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    await writeFile(join(project, 'README.md'), 'Uncommitted local work\n')
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    git(project, ['remote', 'add', 'origin', `http://127.0.0.1:${String(address.port)}/repo.git`])

    resetSshAskpassForTests()
    setSshAskpassUserDataDirForTests(join(root, 'askpass'))
    setSshPromptHandler(async (request) => {
      prompts.push(request.prompt)
      return { value: '' }
    })
    const probe = leaseSshAskpassEnv(process.env)
    try {
      const wrapper = probe.env['GIT_ASKPASS']
      assert.ok(wrapper)
      // Unit bundles relocate __dirname. Point only this owned generated
      // wrapper at the real production helper source; socket/nonce/UI dispatch
      // remain the real bridge, not a fake credential callback.
      const helper = join(root, 'real-askpass-helper.mjs')
      await build({
        entryPoints: [fileURLToPath(new URL('./ssh-workspace/askpass-helper.ts', import.meta.url))],
        outfile: helper,
        platform: 'node',
        format: 'esm',
        bundle: true,
      })
      await writeFile(wrapper, `#!/bin/sh\nexec ${quote([process.execPath, helper])} "$@"\n`)
    } finally {
      probe.release()
    }
    await check({
      root,
      project,
      home,
      prompts,
      requests: () => requests,
      git,
      serveRepository: (path) => {
        repository = path
      },
    })
  } finally {
    setSshPromptHandler(null)
    resetSshAskpassForTests()
    server.closeAllConnections()
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )
    for (const [index, key] of keys.entries()) {
      const value = saved[index]
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
}

describe('default-branch HTTP authentication interaction', () => {
  it('fails background HTTP401 promptly without asking, preserving cached tip and local work', async () => {
    await withAuthFixture(async ({ root, project, prompts, requests, git }) => {
      const before = {
        head: git(project, ['rev-parse', 'HEAD']),
        cached: git(project, ['rev-parse', 'refs/remotes/origin/main']),
        index: await readFile(join(project, '.git', 'index')),
        content: await readFile(join(project, 'README.md'), 'utf8'),
      }
      const start = performance.now()
      const result = await fetchDefaultBranchFromHost(project, 'main', runWorktreeGit)
      assert.ok(result)
      assert.notEqual(result.code, 0, 'auth failure must not be reported as success')
      assert.ok(performance.now() - start < 15_000, 'must not wait for the UI prompt timeout')
      assert.ok(requests() > 0, 'real Git must reach the HTTP401 fixture')
      assert.deepEqual(prompts, [], 'opportunistic refresh must not request authentication UI')
      assert.equal(
        existsSync(join(root, 'fallback-called')),
        false,
        'no configured askpass fallback',
      )
      assert.equal(git(project, ['rev-parse', 'HEAD']), before.head)
      assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/main']), before.cached)
      assert.deepEqual(await readFile(join(project, '.git', 'index')), before.index)
      assert.equal(await readFile(join(project, 'README.md'), 'utf8'), before.content)
      assert.deepEqual(await readdir(join(root, 'profile', 'cache', 'default-branch-fetch')), [])
    })
  })

  it('still requests normal authentication for an explicit foreground git_fetch', async () => {
    await withAuthFixture(async ({ root, project, prompts, requests }) => {
      const result = await fetchOriginRefs(project, ['main'], runWorktreeGit)
      assert.match(result, /^git_fetch failed:/)
      assert.ok(requests() > 0)
      assert.ok(
        prompts.some((prompt) => /Username for .*127\.0\.0\.1/.test(prompt)),
        result,
      )
      assert.equal(
        existsSync(join(root, 'fallback-called')),
        false,
        'Copse bridge owns foreground prompt',
      )
      assert.deepEqual(await readdir(join(root, 'profile', 'cache', 'default-branch-fetch')), [])
    })
  })

  it('also suppresses fallback authentication when a configured local-looking origin rewrites to HTTP without OS containment', async () => {
    await withAuthFixture(async ({ root, project, home, prompts, requests, git }) => {
      const url = git(project, ['config', '--get', 'remote.origin.url'])
      git(root, [
        'config',
        '--file',
        join(home, '.gitconfig'),
        `url.${url}.insteadOf`,
        'owned-background-fallback',
      ])
      git(project, ['remote', 'set-url', 'origin', 'owned-background-fallback'])
      const cached = git(project, ['rev-parse', 'refs/remotes/origin/main'])
      const head = git(project, ['rev-parse', 'HEAD'])
      const index = await readFile(join(project, '.git', 'index'))
      // Inject OS availability at its existing boundary, rather than adding a
      // product flag or changing containment/approval policy for this fix.
      const sandbox = mock.method(SandboxManager, 'isSandboxingEnabled', () => false)
      const warnings = mock.method(console, 'warn', () => undefined)
      try {
        await fetchDefaultBranch(project, 'main')
        assert.ok(requests() > 0, 'real fallback Git must reach the rewritten HTTP401 origin')
        assert.deepEqual(prompts, [], 'background fallback must not request authentication UI')
        assert.equal(existsSync(join(root, 'fallback-called')), false)
        assert.equal(warnings.mock.callCount(), 1)
        assert.match(
          String(warnings.mock.calls[0]?.arguments[0]),
          /fetching origin\/main failed.*exit \d+/,
        )
        await fetchDefaultBranch(project, 'main')
        assert.equal(warnings.mock.callCount(), 1, 'unchanged failures remain deduplicated')
        assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/main']), cached)
        assert.equal(git(project, ['rev-parse', 'HEAD']), head)
        assert.deepEqual(await readFile(join(project, '.git', 'index')), index)
        assert.equal(await readFile(join(project, 'README.md'), 'utf8'), 'Uncommitted local work\n')
      } finally {
        warnings.mock.restore()
        sandbox.mock.restore()
      }
    })
  })

  it('refreshes using an already configured owned credential helper without prompting', async () => {
    await withAuthFixture(async ({ root, project, home, prompts, git, serveRepository }) => {
      const remote = join(root, 'remote.git')
      const writer = join(root, 'writer')
      git(root, ['clone', '-q', '--bare', project, remote])
      git(root, ['clone', '-q', remote, writer])
      await writeFile(join(writer, 'upstream.txt'), 'New upstream commit\n')
      git(writer, ['add', 'upstream.txt'])
      git(writer, [
        '-c',
        'user.name=Copse Test',
        '-c',
        'user.email=copse@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'Advance upstream',
      ])
      git(writer, ['push', '-q', 'origin', 'main'])
      git(remote, ['update-server-info'])
      const remoteTip = git(remote, ['rev-parse', 'main'])
      const localTip = git(project, ['rev-parse', 'HEAD'])
      const index = await readFile(join(project, '.git', 'index'))
      const helper = join(root, 'credential-helper.sh')
      await writeFile(
        helper,
        `#!/bin/sh\nif [ "$1" = get ]; then\nprintf '%s' "$GCM_INTERACTIVE" > ${quote([join(root, 'helper-mode')])}\nprintf 'username=fixture\\npassword=owned-only\\n'\nfi\n`,
        { mode: 0o700 },
      )
      git(root, [
        'config',
        '--file',
        join(home, '.gitconfig'),
        '--add',
        'credential.helper',
        helper,
      ])
      serveRepository(remote)

      const result = await fetchDefaultBranchFromHost(project, 'main', runWorktreeGit)
      assert.ok(result)
      assert.equal(result.code, 0, result.stderr)
      assert.equal(git(project, ['rev-parse', 'refs/remotes/origin/main']), remoteTip)
      assert.notEqual(remoteTip, localTip)
      assert.equal(git(project, ['rev-parse', 'HEAD']), localTip)
      assert.deepEqual(await readFile(join(project, '.git', 'index')), index)
      assert.equal(await readFile(join(project, 'README.md'), 'utf8'), 'Uncommitted local work\n')
      assert.equal(await readFile(join(root, 'helper-mode'), 'utf8'), '0')
      assert.deepEqual(prompts, [])
      assert.equal(existsSync(join(root, 'fallback-called')), false)
      assert.deepEqual(await readdir(join(root, 'profile', 'cache', 'default-branch-fetch')), [])
    })
  })
})
