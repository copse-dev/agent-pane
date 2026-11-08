import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import {
  runShellOnce,
  listForegroundShellProcesses,
  stopAllForegroundShellProcesses,
} from './foreground-shell-process.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import {
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from '../ssh-workspace/connection-manager.ts'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'

it('stops an active command without waiting for SSH authentication and prevents a late command start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-shutdown-startup-'))
  const previousPath = process.env['PATH']
  const previousProjects = storageGet('projects')
  const previousEnabled = getSetting<boolean>('sshWorkspaceEnabled', false)
  const previousHosts = getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
  let releaseConnect: () => void = () => {}
  const connected = new Promise<void>((resolve) => {
    releaseConnect = resolve
  })
  const connection = { started: false }
  class SlowTransport extends FakeSshTransport {
    override async connect(): Promise<void> {
      connection.started = true
      await connected
      await super.connect()
    }
  }
  const transport = new SlowTransport([
    { when: /^uname -s$/, stdout: 'Linux\n' },
    { when: /^uname -m$/, stdout: 'x86_64\n' },
    { when: /printf %s "\$SHELL"/, stdout: '/bin/bash' },
    { when: /command -v git$/, stdout: '/usr/bin/git\n' },
    { when: /command -v rg$/, stdout: '/usr/bin/rg\n' },
  ])
  const run = (projectId: string, cwd: string): Promise<Awaited<ReturnType<typeof runShellOnce>>> =>
    runWithThreadExecutionContext(
      {
        projectId,
        threadId: projectId,
        projectRoot: cwd,
        root: cwd,
        checkoutMode: 'shared',
        branch: 'main',
      },
      () =>
        runShellOnce(
          'node -e "setInterval(()=>{},1000)"',
          cwd,
          30_000,
          new AbortController().signal,
          true,
          process.env,
        ),
    )
  const active = run('local-shutdown', root)
  let pending: Promise<unknown> = Promise.resolve()
  let rejected: Promise<unknown> = Promise.resolve()
  let shutdown: Promise<unknown> = Promise.resolve()
  let budget: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = Date.now() + 5_000
    while (listForegroundShellProcesses().length === 0) {
      assert.ok(Date.now() < deadline, 'local command did not start')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const ssh = join(bin, 'ssh')
    writeFileSync(ssh, '#!/bin/sh\nexit 0\n')
    chmodSync(ssh, 0o755)
    process.env['PATH'] = `${bin}:${previousPath ?? ''}`
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'pending', label: 'Pending fixture', host: 'fixture.invalid', user: 'fixture' },
    ])
    storageSet('projects', [
      { id: 'local-shutdown', path: root },
      { id: 'remote-shutdown', path: '/srv/project', sshHost: 'pending' },
    ])
    resetSshConnectionManagerForTests()
    setSshTransportFactory(() => transport)
    pending = run('remote-shutdown', '/srv/project')
    rejected = assert.rejects(pending, /abort/i)
    while (!connection.started) {
      assert.ok(Date.now() < deadline, 'SSH connection did not enter startup')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    shutdown = stopAllForegroundShellProcesses()
    const completed = await Promise.race([
      shutdown.then(() => true),
      new Promise<boolean>((resolve) => {
        budget = setTimeout(() => {
          resolve(false)
        }, 2_000)
      }),
    ])
    assert.equal(completed, true, 'pending authentication must not hold command cleanup')
    assert.notEqual((await active).exitCode, 0)
    assert.equal(listForegroundShellProcesses().length, 0)
    releaseConnect()
    await rejected
    assert.equal(
      listForegroundShellProcesses().length,
      0,
      'the late connection must never start a command',
    )
  } finally {
    if (budget) clearTimeout(budget)
    releaseConnect()
    await Promise.allSettled([active, pending, rejected, shutdown])
    resetSshConnectionManagerForTests()
    if (previousPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = previousPath
    storageSet('projects', previousProjects)
    await setSetting('sshWorkspaceEnabled', previousEnabled)
    await setSetting('sshWorkspaceHosts', previousHosts)
    rmSync(root, { recursive: true, force: true })
  }
})
