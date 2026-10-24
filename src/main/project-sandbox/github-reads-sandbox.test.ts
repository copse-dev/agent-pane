import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import { it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { classifySandboxDenial } from '../services/security/sandbox-denial-signatures.ts'
import { SandboxGitHubReads } from '../services/github/sandbox-github-reads.ts'
import { baseSandboxConfig, workspaceSandboxOverlay } from './config.ts'
import { setSandboxGitHubReadRoute } from './network-scope.ts'
import { withSandboxOnlyAccess, withSandboxOnlyEnv, type SandboxOnlySpawnAccess } from './spawn.ts'

/**
 * Sandboxed GitHub reads through the real project sandbox (macOS Seatbelt or
 * Linux bubblewrap): a contained `git fetch` from an SSH-style github.com
 * remote, and on macOS a `gh api` read, reach Copse's handler and a fake
 * GitHub, while writes come back as a recognised sandbox denial. The fake
 * GitHub serves git smart HTTP with `git http-backend` from a local bare
 * repository, standing in for github.com behind the handler's upstream seam.
 *
 * Needs to create sandboxes and bind sockets, so it cannot run inside another
 * sandbox (an agent's own shell).
 */

const TOKEN = 'ghp_DesktopTokenForTheFakeGitHub0123456789'

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/**
 * The environment without the runner's own git configuration. A rewrite of
 * the same prefix there wins over the route (docs/shell-permissions.md,
 * "Limits"), and CI's setup action rewrites `git@github.com:` to HTTPS through
 * `GIT_CONFIG_*` variables.
 */
function withoutAmbientGitConfig(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)) out[key] = value
  }
  return { ...out, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
}

/** git smart HTTP over CGI, the way GitHub would answer it. */
function serveGit(
  root: string,
  req: IncomingMessage,
  res: import('node:http').ServerResponse,
): void {
  const url = new URL(req.url ?? '/', 'http://fake')
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      HTTP_GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
    },
  })
  req.pipe(child.stdin)
  const parts: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => parts.push(chunk))
  child.on('close', () => {
    const output = Buffer.concat(parts)
    const split = output.indexOf('\r\n\r\n')
    const headerText = output.subarray(0, split).toString('utf8')
    const body = output.subarray(split + 4)
    let status = 200
    const headers: Record<string, string> = {}
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0])
      else headers[name] = value
    }
    res.writeHead(status, headers)
    res.end(body)
  })
}

it(
  'serves contained gh and git fetch reads through the host and refuses writes as a sandbox denial',
  { skip: process.platform === 'win32', timeout: 120_000 },
  async (t) => {
    if (spawnSync('git', ['--version']).status !== 0) {
      t.skip('requires git')
      return
    }
    const scratch = realpathSync(mkdtempSync('/tmp/ghr-it-'))
    const upstreamRoot = join(scratch, 'upstream')
    const workspace = join(scratch, 'ws')
    mkdirSync(join(upstreamRoot, 'o'), { recursive: true })
    mkdirSync(workspace)
    // The repository "on GitHub", with one commit.
    const seed = join(scratch, 'seed')
    mkdirSync(seed)
    git(seed, 'init', '-q', '-b', 'main')
    git(
      seed,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@e',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'c',
    )
    const head = git(seed, 'rev-parse', 'HEAD')
    git(scratch, 'clone', '-q', '--bare', seed, join(upstreamRoot, 'o', 'r.git'))
    // The project, whose origin is an SSH remote the sandbox cannot use itself.
    git(workspace, 'init', '-q', '-b', 'main')
    git(workspace, 'remote', 'add', 'origin', 'git@github.com:o/r.git')

    const seen: Array<{ url: string; authorization: string | undefined }> = []
    const fake: Server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', authorization: req.headers.authorization })
      if ((req.url ?? '').startsWith('/o/r.git/')) {
        serveGit(upstreamRoot, req, res)
        return
      }
      req.resume()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ full_name: 'o/r', fake: true }))
    })
    await new Promise<void>((resolveListen) => {
      fake.listen(0, '127.0.0.1', resolveListen)
    })
    const address = fake.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0

    await SandboxManager.initialize(baseSandboxConfig(), undefined, false)
    const reads = await SandboxGitHubReads.start({
      token: () => Promise.resolve(TOKEN),
      parentDir: scratch,
      upstream: (options) => httpRequest({ ...options, host: '127.0.0.1', port }),
    })
    setSandboxGitHubReadRoute({ socketPath: reads.gitSocketPath })
    try {
      const access = await reads.spawnFor('integration-thread')
      const run = async (
        command: string,
        withAccess: SandboxOnlySpawnAccess | null,
      ): Promise<{ status: number | null; output: string }> => {
        const overlay = workspaceSandboxOverlay(workspace)
        const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
          command,
          '/bin/sh',
          withAccess ? withSandboxOnlyAccess(overlay, withAccess) : overlay,
        )
        const [file = '', ...args] = argv
        // Asynchronous: the sandbox's proxy and the handler run in this process.
        return new Promise((resolveRun) => {
          const child = spawn(file, args, {
            cwd: workspace,
            env: withSandboxOnlyEnv(
              { ...withoutAmbientGitConfig(env), GIT_TERMINAL_PROMPT: '0' },
              withAccess ?? undefined,
            ),
          })
          let output = ''
          child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
          child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
          const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
          child.on('close', (status) => {
            clearTimeout(timer)
            resolveRun({ status, output })
          })
        })
      }

      // Without the route the sandbox has no way to GitHub at all.
      const contained = await run('git fetch origin', null)
      assert.notEqual(contained.status, 0, contained.output)
      assert.equal(seen.length, 0)

      // With it, the SSH remote is fetched over the handler, token added on the host.
      const fetched = await run('git fetch origin && git rev-parse origin/main', access)
      assert.equal(fetched.status, 0, fetched.output)
      assert.match(fetched.output, new RegExp(head))
      assert.ok(seen.some((entry) => entry.url.startsWith('/o/r.git/info/refs')))
      const basic = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`
      assert.ok(seen.every((entry) => entry.authorization === basic))
      // The command saw the session secret, never the token.
      assert.ok(!fetched.output.includes(TOKEN))

      // A push is refused before it reaches GitHub, as a recognised sandbox block.
      const before = seen.length
      const pushed = await run('git push origin refs/remotes/origin/main:refs/heads/x 2>&1', access)
      assert.notEqual(pushed.status, 0, pushed.output)
      assert.equal(seen.length, before)
      assert.equal(
        classifySandboxDenial(
          pushed.output,
          'git push origin refs/remotes/origin/main:refs/heads/x',
        )?.operation,
        'git push (GitHub write)',
        pushed.output,
      )

      if (process.platform === 'darwin' && spawnSync('gh', ['--version']).status === 0) {
        const read = await run('gh api repos/o/r', access)
        assert.equal(read.status, 0, read.output)
        assert.match(read.output, /"full_name":"o\/r"/)
        assert.equal(seen.at(-1)?.authorization, `token ${TOKEN}`)

        const writes = seen.length
        const issue = await run('gh api -X POST repos/o/r/issues -f title=x', access)
        assert.notEqual(issue.status, 0, issue.output)
        assert.equal(seen.length, writes)
        assert.equal(
          classifySandboxDenial(issue.output, 'gh api -X POST repos/o/r/issues')?.operation,
          'GitHub write',
        )

        // gh in the same sandbox without the per-spawn socket grant cannot connect.
        const ungranted = await run('gh api repos/o/r', {
          ...access,
          allowUnixSockets: [],
        })
        assert.notEqual(ungranted.status, 0, ungranted.output)
      }
    } finally {
      setSandboxGitHubReadRoute(null)
      await reads.close()
      await SandboxManager.reset()
      fake.close()
      rmSync(scratch, { recursive: true, force: true })
    }
  },
)
