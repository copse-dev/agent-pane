import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { connect, createServer, type Server } from 'node:net'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import {
  getSshConnectionManager,
  resetSshConnectionManagerForTests,
} from '../ssh-workspace/connection-manager.ts'
import { setSshControlDirForTests } from '../ssh-workspace/ssh-paths.ts'
import { machineSshReach } from './machine-service.ts'

/**
 * The SSH reach against the real connection manager and OpenSSH transport,
 * with the e2e stub `ssh` first on PATH. The stub runs a real loopback forward,
 * so bytes cross it exactly as they would cross an SSH master's `-L`.
 */
const STUB_SSH_DIR = resolve('tests/e2e/fixtures/fake-ssh')
const HOST: SshWorkspaceHost = { id: 'dev', label: 'Dev Server', host: 'dev.example' }

function listen(server: Server): Promise<number> {
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      done(address && typeof address !== 'string' ? address.port : 0)
    })
  })
}

function roundTrip(port: number): Promise<string> {
  return new Promise((done, fail) => {
    const socket = connect(port, '127.0.0.1')
    let text = ''
    socket.on('data', (chunk) => (text += chunk.toString()))
    socket.on('end', () => {
      done(text)
    })
    socket.on('error', fail)
  })
}

describe('machineSshReach', { skip: process.platform === 'win32' }, () => {
  let state = ''
  let originalPath: string | undefined
  let previousHosts: SshWorkspaceHost[] = []
  let machine: Server

  beforeEach(async () => {
    resetSshConnectionManagerForTests()
    // macOS caps Unix socket paths; keep the control dir short.
    state = mkdtempSync('/tmp/copse-reach-')
    setSshControlDirForTests(state)
    originalPath = process.env['PATH']
    process.env['PATH'] = [STUB_SSH_DIR, originalPath ?? ''].join(delimiter)
    process.env['COPSE_E2E_FAKE_SSH_STATE'] = state
    previousHosts = getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
    await setSetting('sshWorkspaceHosts', [HOST])
    // The paired machine's loopback listener, as seen from the SSH host.
    machine = createServer((socket) => socket.end('machine says hello'))
  })

  afterEach(async () => {
    await getSshConnectionManager().disconnect('dev')
    resetSshConnectionManagerForTests()
    machine.close()
    process.env['PATH'] = originalPath
    delete process.env['COPSE_E2E_FAKE_SSH_STATE']
    setSshControlDirForTests(null)
    await setSetting('sshWorkspaceHosts', previousHosts)
    rmSync(state, { recursive: true, force: true })
  })

  it('carries a request to the machine through a forward, and closes it afterwards', async () => {
    const remotePort = await listen(machine)
    const opened = await machineSshReach.open('dev', remotePort, { interactive: true })
    assert.equal(opened.target.host, '127.0.0.1')
    assert.notEqual(opened.target.port, remotePort, 'the local end of the forward, not the machine')
    assert.equal(await roundTrip(opened.target.port), 'machine says hello')

    await opened.close()
    const forwards = readdirSync(state).filter((name) => name.startsWith('forward-'))
    assert.deepEqual(forwards, [], 'the forward is cancelled when the request ends')
  })

  it('never connects for a status check, and says so', async () => {
    const remotePort = await listen(machine)
    await assert.rejects(
      machineSshReach.open('dev', remotePort, { interactive: false }),
      /not connected/,
    )
    assert.equal(existsSync(join(state, 'master')), false, 'no SSH master was started')
    assert.deepEqual(getSshConnectionManager().listStates(), [])
  })

  it('names the saved host, and nothing for one that is gone', () => {
    assert.equal(machineSshReach.label('dev'), 'Dev Server')
    assert.equal(machineSshReach.label('gone'), null)
  })
})
