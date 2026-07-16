import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { sshExecArgs, sshPtyArgs } from './openssh-transport.ts'
import { controlSocketPath, setSshPathsUserDataDirForTests } from './ssh-paths.ts'

const host: SshWorkspaceHost = {
  id: 'dev-box',
  label: 'Dev',
  host: 'dev.example',
  user: 'ubuntu',
}

describe('sshExecArgs / ControlPath', () => {
  afterEach(() => {
    setSshPathsUserDataDirForTests(null)
  })

  it(
    'passes the control socket via -S, not -o ControlPath (spaces in userData)',
    {
      skip: process.platform === 'win32' ? 'ControlMaster / -S unused on Windows OpenSSH' : false,
    },
    () => {
      // macOS electron userData is under `Application Support` — spaces must not
      // end up inside an `-o ControlPath=…` config line.
      const userData = mkdtempSync(join(tmpdir(), 'Application Support-copse-'))
      try {
        setSshPathsUserDataDirForTests(userData)
        const sock = controlSocketPath(host.id)
        assert.match(sock, /Application Support/)

        const args = sshExecArgs(host, 'true')
        const sIdx = args.indexOf('-S')
        assert.notEqual(sIdx, -1)
        assert.equal(args[sIdx + 1], sock)

        for (const arg of args) {
          assert.ok(
            !arg.startsWith('ControlPath='),
            `must not pass -o ControlPath=… (got ${arg}); OpenSSH splits on spaces`,
          )
        }
      } finally {
        rmSync(userData, { recursive: true, force: true })
      }
    },
  )

  it(
    'keeps -S socket path for pty argv as well',
    {
      skip: process.platform === 'win32' ? 'ControlMaster / -S unused on Windows OpenSSH' : false,
    },
    () => {
      const userData = mkdtempSync(join(tmpdir(), 'Application Support-copse-'))
      try {
        setSshPathsUserDataDirForTests(userData)
        const sock = controlSocketPath(host.id)
        const args = sshPtyArgs(host, 'bash -l')
        assert.equal(args[0], '-tt')
        const sIdx = args.indexOf('-S')
        assert.equal(args[sIdx + 1], sock)
        assert.ok(!args.some((a) => a.startsWith('ControlPath=')))
      } finally {
        rmSync(userData, { recursive: true, force: true })
      }
    },
  )

  it('does not emit -p/-i/user@ when host only has an ssh-config alias', () => {
    // Imported ProxyCommand hosts must be invoked as the bare alias so OpenSSH
    // applies Port/User/IdentityFile/ProxyCommand from ~/.ssh/config.
    const aliasOnly: SshWorkspaceHost = {
      id: 'euw-serp-dev-testing16',
      label: 'euw-serp-dev-testing16',
      host: 'euw-serp-dev-testing16',
    }
    const args = sshExecArgs(aliasOnly, 'true')
    assert.ok(!args.includes('-p'))
    assert.ok(!args.includes('-i'))
    assert.equal(args[args.length - 2], 'euw-serp-dev-testing16')
  })
})
