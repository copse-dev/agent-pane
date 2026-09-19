import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import {
  resetSshConnectionManagerForTests,
  getSshConnectionManager,
  setSshTransportFactory,
} from '../ssh-workspace/connection-manager.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { clearSshWorkspaceFsCacheForTest, SshWorkspaceFs } from './ssh-workspace-fs.ts'
import { WorkspaceFileTooLargeError } from './workspace-fs.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import type { SshExecOptions } from '../ssh-workspace/transport.ts'

const TEST_HOST: SshWorkspaceHost = {
  id: 'dev',
  label: 'Dev',
  host: 'dev.example',
  user: 'me',
}

describe('SshWorkspaceFs', () => {
  let cleanupRoot: (() => void) | undefined
  let previousHosts: SshWorkspaceHost[]

  beforeEach(async () => {
    resetSshConnectionManagerForTests()
    await clearSshWorkspaceFsCacheForTest()
    previousHosts = getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
    await setSetting('sshWorkspaceHosts', [TEST_HOST])
    setSshTransportFactory(
      () =>
        new FakeSshTransport([
          { when: /test -e/, code: 0 },
          { when: /cat .*\/hello\.txt/, stdout: 'remote hello\n' },
          {
            when: /base64 -d/,
            code: 0,
          },
        ]),
    )
    cleanupRoot = setWorkspaceRootForTest('/home/me/project')
  })

  afterEach(async () => {
    cleanupRoot?.()
    resetSshConnectionManagerForTests()
    await clearSshWorkspaceFsCacheForTest()
    await setSetting('sshWorkspaceHosts', previousHosts)
  })

  it(
    'removes a nonempty directory recursively with force',
    { skip: process.platform === 'win32' },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'copse-remote-remove-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const directory = join(root, "build's output")
      await mkdir(directory)
      await writeFile(join(directory, 'artifact.txt'), 'built')
      resetSshConnectionManagerForTests()
      const transport = new FakeSshTransport()
      t.mock.method(transport, 'execShell', async (command: string) => {
        const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
        return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? 1 }
      })
      setSshTransportFactory(() => transport)
      const fs = new SshWorkspaceFs('dev', root)
      await fs.rm(directory, { recursive: true, force: true })
      await assert.rejects(access(directory), { code: 'ENOENT' })
      await fs.rm(directory, { recursive: true, force: true })
    },
  )

  it('reads a file over SSH exec', async () => {
    const fs = new SshWorkspaceFs('dev', '/home/me/project')
    const text = await fs.readFile('/home/me/project/hello.txt', 'utf-8')
    assert.equal(text, 'remote hello\n')
    await getSshConnectionManager().disconnect('dev')
  })

  it('streams binary bytes past the command cap and caches the pull', async () => {
    const path = "/home/me/project/image's sample.bin"
    const bytes = Buffer.alloc(256 * 1024 + 17)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256
    const transport = new FakeSshTransport([{ when: /image's sample\.bin/, fileBytes: bytes }])
    setSshTransportFactory(() => transport)
    const fs = new SshWorkspaceFs('dev', '/home/me/project')

    assert.deepEqual(await fs.readFileBytes(path), bytes)
    assert.deepEqual(await fs.readFileBytes(path), bytes)
    assert.equal(transport.calls.filter((call) => call.kind === 'fetch').length, 1)
    assert.ok(!transport.calls.some((call) => call.kind === 'shell' && /base64/.test(call.command)))
  })

  it('rejects an oversized remote binary before transferring it', async () => {
    const path = '/home/me/project/huge.mp4'
    const transport = new FakeSshTransport([{ when: /huge\.mp4/, sizeBytes: 2048 }])
    setSshTransportFactory(() => transport)
    const fs = new SshWorkspaceFs('dev', '/home/me/project')

    await assert.rejects(
      () => fs.readFileBytes(path, { maxBytes: 1024 }),
      WorkspaceFileTooLargeError,
    )
    assert.equal(transport.calls.filter((call) => call.kind === 'fetch').length, 0)
  })

  it('keeps enforcing the limit if a remote file grows after the size probe', async () => {
    const path = '/home/me/project/growing.mp4'
    const transport = new FakeSshTransport([
      { when: /growing\.mp4/, sizeBytes: 1024, fileBytes: Buffer.alloc(2048) },
    ])
    setSshTransportFactory(() => transport)
    const fs = new SshWorkspaceFs('dev', '/home/me/project')

    await assert.rejects(
      () => fs.readFileBytes(path, { maxBytes: 1024 }),
      /transfer exceeded the 1024 byte limit/,
    )
    const fetch = transport.calls.find((call) => call.kind === 'fetch')
    assert.equal(fetch?.options?.maxBytes, 1024)
  })

  it('removes materialized remote files when the cache is cleared', async () => {
    const path = '/home/me/project/capture.mp4'
    const transport = new FakeSshTransport([
      { when: /capture\.mp4/, fileBytes: Buffer.from('video') },
    ])
    setSshTransportFactory(() => transport)
    const fs = new SshWorkspaceFs('dev', '/home/me/project')

    const materialized = await fs.materializeToLocal(path)
    await access(materialized.path)
    await clearSshWorkspaceFsCacheForTest()
    await assert.rejects(access(materialized.path), { code: 'ENOENT' })
  })

  it('cancels an in-flight transfer when the cache is cleared', async (t) => {
    const path = '/home/me/project/capture.mp4'
    const transport = new FakeSshTransport([
      { when: /capture\.mp4/, fileBytes: Buffer.from('video') },
    ])
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    t.mock.method(
      transport,
      'fetchFile',
      async (_remotePath: string, _localPath: string, options: SshExecOptions = {}) => {
        markStarted?.()
        const signal = options.signal
        assert.ok(signal)
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => {
            const error = new Error('transfer stopped')
            error.name = 'AbortError'
            reject(error)
          }
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      },
    )
    setSshTransportFactory(() => transport)
    const fs = new SshWorkspaceFs('dev', '/home/me/project')

    const materialization = fs.materializeToLocal(path)
    await started
    const rejected = assert.rejects(materialization, { name: 'AbortError' })
    await clearSshWorkspaceFsCacheForTest()
    await rejected
  })

  it('does not start a transfer when binary reading is already cancelled', async () => {
    const path = '/home/me/project/capture.mp4'
    const transport = new FakeSshTransport([
      { when: /capture\.mp4/, fileBytes: Buffer.from('video') },
    ])
    setSshTransportFactory(() => transport)
    const fs = new SshWorkspaceFs('dev', '/home/me/project')
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(() => fs.readFileBytes(path, { signal: controller.signal }), {
      name: 'AbortError',
    })
    assert.equal(transport.calls.filter((call) => call.kind === 'fetch').length, 0)
  })

  it('falls back to POSIX find when the host lacks GNU find -printf', async () => {
    resetSshConnectionManagerForTests()
    setSshTransportFactory(
      () =>
        new FakeSshTransport([
          { when: /find .* -printf/, stderr: 'find: -printf: unknown primary', code: 1 },
          { when: /find .* -exec sh -c/, stdout: 'd\0src\0f\0README.md\0' },
        ]),
    )
    const fs = new SshWorkspaceFs('dev', '/home/me/project')
    assert.deepEqual(await fs.readdirWithTypes('/home/me/project'), [
      { name: 'src', isDir: true },
      { name: 'README.md', isDir: false },
    ])
  })

  it('keeps newlines inside remote directory entry names', async () => {
    resetSshConnectionManagerForTests()
    setSshTransportFactory(
      () => new FakeSshTransport([{ when: /find .* -printf/, stdout: 'normal\0line\nbreak\0' }]),
    )
    const fs = new SshWorkspaceFs('dev', '/home/me/project')

    assert.deepEqual(await fs.readdir('/home/me/project'), ['normal', 'line\nbreak'])
  })

  it('falls back to POSIX find for untyped directory listings', async () => {
    resetSshConnectionManagerForTests()
    setSshTransportFactory(
      () =>
        new FakeSshTransport([
          { when: /find .* -printf/, stderr: 'find: -printf: unknown primary', code: 1 },
          { when: /find .* -exec sh -c/, stdout: 'src\0README.md\0' },
        ]),
    )
    const fs = new SshWorkspaceFs('dev', '/home/me/project')

    assert.deepEqual(await fs.readdir('/home/me/project'), ['src', 'README.md'])
  })

  it('keeps tabs and newlines inside typed remote directory entries', async () => {
    resetSshConnectionManagerForTests()
    setSshTransportFactory(
      () =>
        new FakeSshTransport([
          { when: /find .* -printf/, stdout: 'd\0src\0f\0README\tcopy\n.md\0' },
        ]),
    )
    const fs = new SshWorkspaceFs('dev', '/home/me/project')

    assert.deepEqual(await fs.readdirWithTypes('/home/me/project'), [
      { name: 'src', isDir: true },
      { name: 'README\tcopy\n.md', isDir: false },
    ])
  })
})
