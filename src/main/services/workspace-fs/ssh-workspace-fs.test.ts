import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import {
  resetSshConnectionManagerForTests,
  getSshConnectionManager,
  setSshTransportFactory,
} from '../ssh-workspace/connection-manager.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { clearSshWorkspaceFsCacheForTest, SshWorkspaceFs } from './ssh-workspace-fs.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

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
    clearSshWorkspaceFsCacheForTest()
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
    clearSshWorkspaceFsCacheForTest()
    await setSetting('sshWorkspaceHosts', previousHosts)
  })

  it('reads a file over SSH exec', async () => {
    const fs = new SshWorkspaceFs('dev', '/home/me/project')
    const text = await fs.readFile('/home/me/project/hello.txt', 'utf-8')
    assert.equal(text, 'remote hello\n')
    await getSshConnectionManager().disconnect('dev')
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
