import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createServer as httpsServer } from 'node:https'
import { createServer as httpServer } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadHostedArchive } from './openai-archive-download-worker.ts'
import { setupHostedArchive } from './openai-archive-worker.ts'

it('downloads through HTTPS_PROXY with verified TLS, rejects redirects/cert failures and redacts errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-proxy-'))
  const keys = [
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
    'CURL_CA_BUNDLE',
    'SSL_CERT_FILE',
  ] as const
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  const sockets = new Set<Duplex>()
  let requests = 0
  let connections = 0
  let responseStatus = 200
  let responseBody: string | Buffer = 'archive bytes'
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'key.pem'),
      '-out',
      join(root, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=codeload.github.com',
      '-addext',
      'subjectAltName=DNS:codeload.github.com',
    ],
    { stdio: 'ignore' },
  )
  const server = httpsServer(
    { key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) },
    (req, res) => {
      requests++
      assert.equal(req.url, '/example/repo/archive?token=private-archive-token')
      assert.equal(req.headers.authorization, undefined)
      assert.equal(req.headers['proxy-authorization'], undefined)
      res.writeHead(
        responseStatus,
        responseStatus === 302 ? { location: 'https://untrusted.invalid/secret' } : {},
      )
      res.end(responseBody)
    },
  )
  const proxy = httpServer()
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    proxy.on('connect', (req, client, head) => {
      connections++
      assert.equal(req.url, 'codeload.github.com:443')
      assert.equal(
        req.headers['proxy-authorization'],
        `Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}`,
      )
      const upstream = connect(address.port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
      sockets.add(client)
      sockets.add(upstream)
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxyAddress = proxy.address()
    assert.ok(proxyAddress && typeof proxyAddress !== 'string')
    process.env['HTTPS_PROXY'] =
      `http://proxy-user:proxy-secret@127.0.0.1:${String(proxyAddress.port)}`
    process.env['https_proxy'] = process.env['HTTPS_PROXY']
    process.env['NO_PROXY'] = ''
    process.env['no_proxy'] = ''
    process.env['CURL_CA_BUNDLE'] = join(root, 'cert.pem')
    const url = new URL(
      'https://codeload.github.com/example/repo/archive?token=private-archive-token',
    )
    const file = join(root, 'archive.tar.gz')
    await downloadHostedArchive(url, file)
    assert.equal(readFileSync(file, 'utf8'), 'archive bytes')
    assert.equal(requests, 1)
    assert.equal(connections, 1)
    rmSync(file)
    for (const status of [302, 404]) {
      responseStatus = status
      await assert.rejects(downloadHostedArchive(url, file), { message: `HTTP ${String(status)}` })
      assert.equal(existsSync(file), false)
    }
    assert.equal(requests, 3)
    const repo = join(root, 'repo')
    const workspace = join(root, 'guest')
    mkdirSync(repo)
    mkdirSync(join(workspace, 'inputs'), { recursive: true })
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(repo, 'code.txt'), 'restored through proxy')
    git('add', '.')
    git('commit', '-m', 'snapshot')
    const base = git('rev-parse', 'HEAD')
    const tree = git('rev-parse', 'HEAD^{tree}')
    responseBody = execFileSync('git', ['archive', '--format=tar.gz', '--prefix=source/', 'HEAD'], {
      cwd: repo,
    })
    responseStatus = 200
    writeFileSync(
      join(workspace, 'inputs/archive.json'),
      JSON.stringify({
        tree,
        snapshotTree: tree,
        commit: `${git('cat-file', 'commit', base)}\n`,
        url: url.href,
      }),
    )
    writeFileSync(join(workspace, 'inputs/source.bundle'), '')
    await setupHostedArchive(workspace, base)
    assert.equal(readFileSync(join(workspace, 'repo/code.txt'), 'utf8'), 'restored through proxy')
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: join(workspace, 'repo'),
        encoding: 'utf8',
      }).trim(),
      base,
    )
    assert.equal(existsSync(join(workspace, 'inputs/archive.json')), false)
    assert.equal(requests, 4)
    // A different valid CA file cannot verify this server: TLS must remain enabled.
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(root, 'other-key.pem'),
        '-out',
        join(root, 'other-cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=OtherCA',
      ],
      { stdio: 'ignore' },
    )
    process.env['CURL_CA_BUNDLE'] = join(root, 'other-cert.pem')
    await assert.rejects(downloadHostedArchive(url, file), { message: 'curl 60' })
    assert.equal(existsSync(file), false)
    assert.equal(requests, 4)
  } finally {
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
    for (const socket of sockets) socket.destroy()
    await Promise.all([
      new Promise<void>((resolve) =>
        proxy.close(() => {
          resolve()
        }),
      ),
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve()
        }),
      ),
    ])
    rmSync(root, { recursive: true, force: true })
  }
})
