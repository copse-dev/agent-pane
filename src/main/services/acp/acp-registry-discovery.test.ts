import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { ACP_REGISTRY_URL } from '@shared/acp-registry.ts'
import { createAcpRegistryBrowser, findRegistryExecutable } from './acp-registry-discovery.ts'

const fixture = {
  id: 'new-agent',
  name: 'A new agent',
  version: '1.2.3',
  description: 'A registry candidate',
  website: 'https://example.com/docs',
  distribution: {
    binary: { 'darwin-aarch64': { cmd: './new-agent', args: ['--acp'], env: { EVIL: 'ignored' } } },
    npx: { package: '@example/agent@1.2.3', args: ['--acp'] },
  },
}
const index = (agents: unknown[] = [fixture]): string =>
  JSON.stringify({ version: '1.0.0', agents })

describe('ACP registry discovery', () => {
  it('uses one fixed public fetch and only resolves declared direct binaries, dropping all grants', async () => {
    const commands: string[] = []
    const registry = createAcpRegistryBrowser({
      target: 'darwin-aarch64',
      now: () => 123,
      fetch: async (url, options) => {
        assert.equal(url, ACP_REGISTRY_URL)
        assert.ok(options)
        assert.equal(options.redirect, 'error')
        assert.equal(options.credentials, 'omit')
        assert.ok(options.signal)
        return new Response(
          index([
            { ...fixture, sandbox: false, autoInstall: true, permissionMode: 'bypassPermissions' },
          ]),
        )
      },
      resolveExecutable: async (command) => {
        commands.push(command)
        return '/bin/new-agent'
      },
    })
    const result = await registry.load()
    assert.deepEqual(commands, ['new-agent'])
    assert.deepEqual(result, {
      fetchedAt: 123,
      skipped: 0,
      entries: [
        {
          id: 'new-agent',
          title: 'A new agent',
          version: '1.2.3',
          description: 'A registry candidate',
          website: 'https://example.com/docs',
          packages: ['npm: @example/agent@1.2.3'],
          platforms: ['darwin-aarch64'],
          command: 'new-agent',
          args: ['--acp'],
          installedPath: '/bin/new-agent',
        },
      ],
    })
  })

  it('never mistakes npx or uvx presence for an installed agent, or launches unsupported binary targets', async () => {
    const registry = createAcpRegistryBrowser({
      target: 'linux-x86_64',
      fetch: async () => new Response(index()),
      resolveExecutable: async () => {
        throw new Error('must not resolve a runner')
      },
    })
    const entry = (await registry.load()).entries[0]
    assert.ok(entry)
    assert.equal(entry.command, undefined)
    assert.equal(entry.installedPath, null)
    assert.deepEqual(entry.args, ['--acp'])
  })

  it('skips malformed/duplicate rows and strips unsafe links and executable fragments', async () => {
    const registry = createAcpRegistryBrowser({
      target: 'darwin-aarch64',
      fetch: async () =>
        new Response(
          index([
            null,
            { ...fixture, id: 'bad/id' },
            { ...fixture, name: 'bad\nname' },
            {
              ...fixture,
              website: 'javascript:alert(1)',
              repository: 'https://user:password@example.com',
              distribution: { binary: { 'darwin-aarch64': { cmd: 'sh -c evil', args: [] } } },
            },
            fixture,
          ]),
        ),
      resolveExecutable: async () => {
        throw new Error('must not resolve fragments')
      },
    })
    const result = await registry.load()
    assert.equal(result.skipped, 4)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]?.website, undefined)
    assert.equal(result.entries[0]?.command, undefined)
  })

  it('rejects invalid envelopes, excessive row counts and unsupported versions', async () => {
    for (const body of ['{', '{"version":"2.0.0","agents":[]}', index(Array(1001).fill(null))]) {
      const registry = createAcpRegistryBrowser({ fetch: async () => new Response(body) })
      await assert.rejects(registry.load(), /unsupported or invalid index/)
    }
  })

  it('bounds both advertised and chunked response sizes and rejects HTTP errors', async () => {
    for (const response of [
      new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
      new Response('x'.repeat(2 * 1024 * 1024 + 1)),
      new Response('error', { status: 503 }),
    ]) {
      await assert.rejects(
        createAcpRegistryBrowser({ fetch: async () => response }).load(),
        /too large|HTTP 503/,
      )
    }
  })

  it('deduplicates concurrent requests, caches briefly, refreshes and recovers after failure', async () => {
    let requests = 0
    let now = 1
    let fail = false
    const registry = createAcpRegistryBrowser({
      now: () => now,
      fetch: async () => {
        requests++
        if (fail) throw new Error('offline')
        return new Response(index([]))
      },
    })
    await Promise.all([registry.load(), registry.load(true)])
    await registry.load()
    assert.equal(requests, 1)
    now += 5 * 60 * 1000
    await registry.load()
    assert.equal(requests, 2)
    fail = true
    await assert.rejects(registry.load(true), /offline/)
    await registry.load()
    assert.equal(requests, 3)
    fail = false
    await registry.load(true)
    assert.equal(requests, 4)
  })
})

describe('filesystem-only registry executable detection', () => {
  it('finds executable files without running them, skips directories, and rejects paths/fragments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-discovery-'))
    try {
      const first = join(root, 'first')
      const second = join(root, 'second')
      await mkdir(first)
      await mkdir(second)
      const name = process.platform === 'win32' ? 'candidate.cmd' : 'candidate'
      await mkdir(join(first, name))
      const sentinel = join(root, 'executed')
      const executable = join(second, name)
      await writeFile(executable, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 })
      const searchPath = ['.', first, second].join(delimiter)
      assert.equal(await findRegistryExecutable(name, searchPath), executable)
      assert.equal(await findRegistryExecutable('../candidate', searchPath), null)
      assert.equal(await findRegistryExecutable('candidate --version', searchPath), null)
      assert.equal(await findRegistryExecutable('missing', searchPath), null)
      await assert.rejects(access(sentinel))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
