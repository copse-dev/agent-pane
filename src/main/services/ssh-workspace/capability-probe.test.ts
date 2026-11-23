import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { probeSshCapabilities, remoteHomeDirectory } from './capability-probe.ts'
import { FakeSshTransport } from './fake-ssh-transport.ts'

const ok = (stdout: string): { stdout: string; stderr: string; code: number } => ({
  stdout,
  stderr: '',
  code: 0,
})

describe('remoteHomeDirectory', () => {
  it('accepts an absolute home and drops a trailing slash', () => {
    assert.equal(remoteHomeDirectory(ok('/home/dev')), '/home/dev')
    assert.equal(remoteHomeDirectory(ok('/home/dev/\n')), '/home/dev')
    assert.equal(remoteHomeDirectory(ok('/')), '/')
  })

  it('refuses anything it would have to guess at', () => {
    assert.equal(remoteHomeDirectory(ok('')), null, 'an unset $HOME')
    assert.equal(remoteHomeDirectory(ok('home/dev')), null, 'a relative path')
    assert.equal(remoteHomeDirectory(ok('Welcome!\n/home/dev')), null, 'a login banner')
    assert.equal(remoteHomeDirectory({ stdout: '/home/dev', stderr: '', code: 1 }), null)
  })
})

describe('probeSshCapabilities', () => {
  it('reports the home directory beside the other capabilities', async () => {
    const report = await probeSshCapabilities(
      new FakeSshTransport([
        { when: /^uname -s$/, stdout: 'Linux\n' },
        { when: /^uname -m$/, stdout: 'aarch64\n' },
        { when: /printf %s "\$SHELL"/, stdout: '/bin/zsh' },
        { when: /printf %s "\$HOME"/, stdout: '/home/dev' },
        { when: /command -v (git|rg)$/, stdout: '/usr/bin/tool\n' },
      ]),
    )
    assert.equal(report.home, '/home/dev')
    assert.equal(report.shell, '/bin/zsh')
  })

  it('leaves the home out when the host does not report one', async () => {
    const report = await probeSshCapabilities(
      new FakeSshTransport([{ when: /^uname -s$/, stdout: 'Linux\n' }]),
    )
    assert.equal(Object.hasOwn(report, 'home'), false)
  })
})
