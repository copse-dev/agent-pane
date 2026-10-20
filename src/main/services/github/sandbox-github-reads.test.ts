import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SandboxGitHubReads, SANDBOX_GITHUB_READ_ONLY_NOTE } from './sandbox-github-reads.ts'
import { SANDBOX_GITHUB_SESSION_HEADER } from './sandbox-github-reads-config.ts'

/**
 * The desktop's sandboxed GitHub read handler, over its real unix sockets,
 * with a fake GitHub on loopback standing in for the real hosts (the
 * handler's injected upstream). Binding sockets needs to run outside the
 * agent sandbox.
 */

const REAL_TOKEN = 'ghp_RealTokenValue0123456789abcdefABCD'

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

function send(
  socketPath: string,
  options: { method?: string; path: string; headers?: OutgoingHttpHeaders; body?: string },
): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers ?? {},
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (chunk: Buffer) => parts.push(chunk))
        res.on('end', () => {
          resolveReply({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

function secretFrom(env: Record<string, string | undefined>): string {
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('GIT_CONFIG_VALUE_') && value?.startsWith(SANDBOX_GITHUB_SESSION_HEADER)) {
      return value.slice(SANDBOX_GITHUB_SESSION_HEADER.length + 2)
    }
  }
  throw new Error('no session secret in the environment')
}

function aliasFrom(env: Record<string, string | undefined>): string {
  const key = env['GIT_CONFIG_KEY_0'] ?? ''
  const match = /^url\.http:\/\/([^/]+)\/\.insteadOf$/.exec(key)
  if (!match?.[1]) throw new Error('no alias in the environment')
  return match[1]
}

describe('SandboxGitHubReads', () => {
  let fake: Server
  let port = 0
  const seen: Seen[] = []
  const logs: string[] = []
  let parent = ''
  let reads: SandboxGitHubReads

  before(async () => {
    fake = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: req.url }))
      })
    })
    await new Promise<void>((resolveListen) => {
      fake.listen(0, '127.0.0.1', resolveListen)
    })
    const address = fake.address()
    port = typeof address === 'object' && address !== null ? address.port : 0
    parent = mkdtempSync('/tmp/sgh-')
    reads = await SandboxGitHubReads.start({
      token: () => Promise.resolve(REAL_TOKEN),
      parentDir: parent,
      platform: 'darwin',
      upstream: (options) => httpRequest({ ...options, host: '127.0.0.1', port }),
      onLog: (entry) => logs.push(JSON.stringify(entry)),
    })
  })

  after(async () => {
    await reads.close()
    fake.close()
    rmSync(parent, { recursive: true, force: true })
  })

  beforeEach(() => {
    seen.length = 0
  })

  it('keeps its sockets private to the user', async () => {
    const access = await reads.spawnFor('thread-perm')
    const socket = access.allowUnixSockets[0] ?? ''
    assert.equal(statSync(reads.gitSocketPath).mode & 0o777, 0o600)
    assert.equal(statSync(socket).mode & 0o777, 0o600)
    assert.equal(statSync(join(reads.gitSocketPath, '..')).mode & 0o777, 0o700)
    assert.equal(statSync(join(socket, '..')).mode & 0o777, 0o700)
  })

  it('gives one session per thread and routes gh only where Seatbelt can allow the socket', async () => {
    const first = await reads.spawnFor('thread-a')
    const again = await reads.spawnFor('thread-a')
    const other = await reads.spawnFor('thread-b')
    assert.deepEqual(first.allowUnixSockets, again.allowUnixSockets)
    assert.notDeepEqual(first.allowUnixSockets, other.allowUnixSockets)
    assert.notEqual(secretFrom(first.env({})), secretFrom(other.env({})))
    assert.match(secretFrom(first.env({})), /^copse_sgh_[0-9a-f]{64}$/)
    assert.ok(first.env({})['GH_CONFIG_DIR'])

    const linuxParent = mkdtempSync('/tmp/sgh-')
    const linux = await SandboxGitHubReads.start({
      token: () => Promise.resolve(null),
      parentDir: linuxParent,
      platform: 'linux',
    })
    try {
      const access = await linux.spawnFor('thread-a')
      assert.deepEqual(access.allowUnixSockets, [])
      assert.deepEqual(access.allowRead, [])
      assert.ok(!Object.hasOwn(access.env({}), 'GH_CONFIG_DIR'))
      assert.ok(aliasFrom(access.env({})).endsWith('.github.copse.internal'))
    } finally {
      await linux.close()
      rmSync(linuxParent, { recursive: true, force: true })
    }
  })

  it('forwards a gh read with the desktop token, never the session secret', async () => {
    const access = await reads.spawnFor('thread-a')
    const secret = secretFrom(access.env({}))
    const reply = await send(access.allowUnixSockets[0] ?? '', {
      path: '/repos/o/r',
      headers: { Host: 'api.github.com', Authorization: `token ${secret}` },
    })
    assert.equal(reply.status, 200, reply.body)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.headers.authorization, `token ${REAL_TOKEN}`)
    assert.ok(!JSON.stringify(seen).includes(secret))
  })

  it('answers 401 and forwards nothing without the right secret', async () => {
    const a = await reads.spawnFor('thread-a')
    const b = await reads.spawnFor('thread-b')
    const ghSocket = a.allowUnixSockets[0] ?? ''
    const alias = aliasFrom(a.env({}))
    const cases: Array<{ socket: string; path: string; headers: OutgoingHttpHeaders }> = [
      // gh: missing, wrong, and another thread's secret on this thread's socket.
      { socket: ghSocket, path: '/user', headers: { Host: 'api.github.com' } },
      {
        socket: ghSocket,
        path: '/user',
        headers: { Host: 'api.github.com', Authorization: 'token copse_sgh_wrong' },
      },
      {
        socket: ghSocket,
        path: '/user',
        headers: { Host: 'api.github.com', Authorization: `token ${secretFrom(b.env({}))}` },
      },
      // git: missing, and another thread's secret on this thread's alias.
      {
        socket: reads.gitSocketPath,
        path: `http://${alias}/o/r.git/info/refs?service=git-upload-pack`,
        headers: { Host: alias },
      },
      {
        socket: reads.gitSocketPath,
        path: `http://${alias}/o/r.git/info/refs?service=git-upload-pack`,
        headers: { Host: alias, [SANDBOX_GITHUB_SESSION_HEADER]: secretFrom(b.env({})) },
      },
      // git: an alias for no session at all.
      {
        socket: reads.gitSocketPath,
        path: 'http://s00000000000000ff.github.copse.internal/o/r.git/info/refs?service=git-upload-pack',
        headers: {
          Host: 's00000000000000ff.github.copse.internal',
          [SANDBOX_GITHUB_SESSION_HEADER]: secretFrom(a.env({})),
        },
      },
    ]
    for (const item of cases) {
      const reply = await send(item.socket, { path: item.path, headers: item.headers })
      assert.equal(reply.status, 401, `${item.path} ${JSON.stringify(item.headers)}`)
    }
    assert.equal(seen.length, 0)
    const secrets = [secretFrom(a.env({})), secretFrom(b.env({}))]
    assert.ok(!logs.some((line) => secrets.some((secret) => line.includes(secret))))
  })

  it('refuses browser-shaped requests even with the secret', async () => {
    const access = await reads.spawnFor('thread-a')
    const secret = secretFrom(access.env({}))
    for (const extra of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      const reply = await send(access.allowUnixSockets[0] ?? '', {
        path: '/user',
        headers: { Host: 'api.github.com', Authorization: `token ${secret}`, ...extra },
      })
      assert.equal(reply.status, 403)
    }
    assert.equal(seen.length, 0)
  })

  it('serves a git fetch through the alias with Basic auth for github.com', async () => {
    const access = await reads.spawnFor('thread-a')
    const alias = aliasFrom(access.env({}))
    const reply = await send(reads.gitSocketPath, {
      path: `http://${alias}/o/r.git/info/refs?service=git-upload-pack`,
      headers: { Host: alias, [SANDBOX_GITHUB_SESSION_HEADER]: secretFrom(access.env({})) },
    })
    assert.equal(reply.status, 200, reply.body)
    const [first] = seen
    assert.ok(first)
    assert.equal(first.url, '/o/r.git/info/refs?service=git-upload-pack')
    assert.equal(first.headers.host, 'github.com')
    assert.equal(
      first.headers.authorization,
      `Basic ${Buffer.from(`x-access-token:${REAL_TOKEN}`).toString('base64')}`,
    )
    assert.equal(first.headers[SANDBOX_GITHUB_SESSION_HEADER.toLowerCase()], undefined)
  })

  it('refuses writes in words git and gh show, before anything reaches GitHub', async () => {
    const access = await reads.spawnFor('thread-a')
    const alias = aliasFrom(access.env({}))
    const secret = secretFrom(access.env({}))
    const push = await send(reads.gitSocketPath, {
      path: `http://${alias}/o/r.git/info/refs?service=git-receive-pack`,
      headers: { Host: alias, [SANDBOX_GITHUB_SESSION_HEADER]: secret },
    })
    assert.equal(push.status, 403)
    assert.match(String(push.headers['content-type']), /^text\/plain/)
    assert.match(push.body, /pushing is not allowed from the project sandbox/)
    assert.ok(push.body.includes(SANDBOX_GITHUB_READ_ONLY_NOTE))

    const mutation = await send(access.allowUnixSockets[0] ?? '', {
      method: 'POST',
      path: '/graphql',
      headers: {
        Host: 'api.github.com',
        Authorization: `token ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
      }),
    })
    assert.equal(mutation.status, 403)
    const message: unknown = JSON.parse(mutation.body)
    assert.ok(typeof message === 'object' && message !== null && 'message' in message)
    assert.ok(String(message.message).includes(SANDBOX_GITHUB_READ_ONLY_NOTE))

    const issue = await send(access.allowUnixSockets[0] ?? '', {
      method: 'POST',
      path: '/repos/o/r/issues',
      headers: { Host: 'api.github.com', Authorization: `token ${secret}` },
      body: '{"title":"x"}',
    })
    assert.equal(issue.status, 403)
    assert.match(issue.body, /sandboxed commands can only read GitHub/)
    assert.equal(seen.length, 0)
  })

  it('refuses CONNECT and the bare alias outside a session', async () => {
    const connect = await new Promise<number>((resolveStatus, reject) => {
      const req = httpRequest({
        socketPath: reads.gitSocketPath,
        method: 'CONNECT',
        path: 'api.github.com:443',
      })
      req.on('connect', (res, socket) => {
        socket.destroy()
        resolveStatus(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(connect, 405)
    const bare = await send(reads.gitSocketPath, {
      path: 'http://github.copse.internal/o/r.git/info/refs?service=git-upload-pack',
      headers: { Host: 'github.copse.internal' },
    })
    assert.equal(bare.status, 401)
    assert.equal(seen.length, 0)
  })
})
