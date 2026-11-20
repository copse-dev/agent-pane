import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import type { SshWorkspaceHost } from '@shared/types/ssh-workspace.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/spawn.ts'
import { isProjectSandboxActive } from '../../project-sandbox/state.ts'
import {
  resetSshConnectionManagerForTests,
  setSshTransportFactory,
} from '../ssh-workspace/connection-manager.ts'
import { getActiveExecutionTarget } from '../ssh-workspace/execution-target.ts'
import { getSetting, setSetting } from '../storage/settings.ts'
import { storageGet, storageSet } from '../storage/storage.ts'
import { threadExecutionContextStorage } from '../thread-execution-context-store.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { dryRunHook } from './dry-run.ts'
import { spawnHookProcess } from './hook-spawn.ts'

describe('Sources hook test execution ownership', { skip: process.platform === 'win32' }, () => {
  const previousProjects = storageGet('projects')
  const previousProject = storageGet('activeProjectId')
  const previousEnabled = getSetting<boolean>('sshWorkspaceEnabled', false)
  const previousHosts = getSetting<SshWorkspaceHost[]>('sshWorkspaceHosts', [])
  const previousSandbox = isProjectSandboxActive()
  let root = ''
  let restoreWorkspace = (): void => {}
  let remoteCalls = 0
  let wrappedCommands = 0

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-hook-routing-')))
    mkdirSync(join(root, 'scripts'))
    writeFileSync(
      join(root, 'scripts/cwd.cjs'),
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({note:process.cwd()})))",
    )
    restoreWorkspace = setWorkspaceRootForTest('/remote/project')
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'hook-remote', label: 'Fixture', host: 'no-network.example.invalid', user: 'test' },
    ])
    storageSet('projects', [
      { id: 'remote', path: '/remote/project', sshHost: 'hook-remote' },
      { id: 'local', path: root },
    ])
    storageSet('activeProjectId', 'remote')
    assert.equal(getActiveExecutionTarget().kind, 'ssh')
    remoteCalls = 0
    wrappedCommands = 0
    resetSshConnectionManagerForTests()
    setSshTransportFactory(() => {
      remoteCalls++
      throw new Error('Unexpected SSH hook transport')
    })
    // Keep the real dry-run, host binding, routing and child process. Replace
    // only OS containment, so this regression runs on both native CI platforms.
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    mock.method(SandboxManager, 'wrapWithSandboxArgv', async (command: string) => {
      wrappedCommands++
      return { argv: ['/bin/sh', '-c', command], env: process.env }
    })
    mock.method(SandboxManager, 'cleanupAfterCommand', () => {})
    setProjectSandboxEnabled(true)
  })

  afterEach(async () => {
    setProjectSandboxEnabled(previousSandbox)
    mock.restoreAll()
    resetSshConnectionManagerForTests()
    restoreWorkspace()
    storageSet('projects', previousProjects)
    storageSet('activeProjectId', previousProject)
    await setSetting('sshWorkspaceEnabled', previousEnabled)
    await setSetting('sshWorkspaceHosts', previousHosts)
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps a default-sandbox local Sources test off another window’s SSH host', async () => {
    const result = await dryRunHook(
      {
        family: 'copse',
        event: 'beforeSubmitPrompt',
        command: 'node scripts/cwd.cjs',
        source: join(root, '.copse/hooks.json'),
        scope: 'project',
      },
      root,
    )
    assert.equal(remoteCalls, 0, 'a local Sources test must never reach SSH transport')
    assert.equal(result.exitCode, 0, result.stderr ?? '')
    assert.equal(result.stdout?.trim(), JSON.stringify({ note: root }))
    assert.equal(result.parseOk, true)
    assert.equal(result.sandboxed, true)
    assert.equal(wrappedCommands, 1)
    assert.equal(remoteCalls, 0)
  })

  it('preserves ordinary hooks’ local turn ownership despite the active remote window', async () => {
    const result = await threadExecutionContextStorage.run(
      {
        projectId: 'local',
        projectRoot: root,
        threadId: 'local-thread',
        root,
        checkoutMode: 'shared',
        branch: null,
      },
      () => spawnHookProcess('node scripts/cwd.cjs', {}, { cwd: root }),
    )
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(result.stdout.trim(), JSON.stringify({ note: root }))
    assert.equal(wrappedCommands, 1)
    assert.equal(remoteCalls, 0)
  })

  it('retains remote turn routing for ordinary hooks', async () => {
    storageSet('activeProjectId', 'local')
    const result = await threadExecutionContextStorage.run(
      {
        projectId: 'remote',
        projectRoot: '/remote/project',
        threadId: 'remote-thread',
        root: '/remote/project',
        checkoutMode: 'shared',
        branch: null,
      },
      () => spawnHookProcess('node scripts/cwd.cjs', {}, { cwd: '/remote/project' }),
    )
    assert.equal(result.spawnError, true)
    assert.equal(remoteCalls, 1)
    assert.equal(wrappedCommands, 0)
  })
})
