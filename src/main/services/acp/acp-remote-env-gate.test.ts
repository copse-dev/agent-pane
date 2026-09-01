import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setSetting } from '../storage/settings.ts'
import { storageSet } from '../storage/storage.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { setApprovalHandler } from '../approval.ts'
import {
  gateRemoteAcpEnvForward,
  remoteAcpAuthRequiredHint,
  resetRemoteAcpEnvDecisionsForTests,
} from './acp-remote-env-gate.ts'

const REMOTE_ROOT = '/remote/project'

describe('gateRemoteAcpEnvForward', () => {
  beforeEach(async () => {
    resetRemoteAcpEnvDecisionsForTests()
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('acpOverSshEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: REMOTE_ROOT, sshHost: 'dev' }])
    setWorkspaceRootForTest(REMOTE_ROOT)
  })

  afterEach(async () => {
    setApprovalHandler(null)
    resetRemoteAcpEnvDecisionsForTests()
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('acpOverSshEnabled', false)
  })

  it('passes an env-less config through untouched, even for an SSH target', async () => {
    const config = { command: 'claude-code-acp', cwd: REMOTE_ROOT }
    assert.equal(await gateRemoteAcpEnvForward('claude-acp', config), config)
    assert.ok(!('env' in config))
  })

  it('keeps env intact for a local cwd — nothing crosses a wire, no consent needed', async () => {
    const config = {
      command: 'claude-code-acp',
      cwd: '/some/local/path',
      env: { ANTHROPIC_API_KEY: 'sk-local' },
    }
    await gateRemoteAcpEnvForward('claude-acp', config)
    assert.deepEqual(config.env, { ANTHROPIC_API_KEY: 'sk-local' })
  })

  it(
    'cancels the prompt without remembering cancellation as denial',
    { timeout: 500 },
    async () => {
      let handlerSignal: AbortSignal | undefined
      let markPrompted!: () => void
      const prompted = new Promise<void>((resolve) => {
        markPrompted = resolve
      })
      setApprovalHandler(
        (_request, approvalSignal) =>
          new Promise(() => {
            handlerSignal = approvalSignal
            markPrompted()
          }),
      )
      const controller = new AbortController()
      const cancelledConfig = {
        command: 'claude-code-acp',
        cwd: REMOTE_ROOT,
        env: { ANTHROPIC_API_KEY: 'sk-cancelled' },
      }
      const cancelled = gateRemoteAcpEnvForward('claude-acp', cancelledConfig, controller.signal)
      await prompted

      controller.abort()

      await cancelled
      assert.equal(handlerSignal?.aborted, true)
      assert.equal(cancelledConfig.env, undefined)

      let promptedAgain = false
      setApprovalHandler(() => {
        promptedAgain = true
        return Promise.resolve({ approved: true, remember: false })
      })
      const nextConfig = {
        command: 'claude-code-acp',
        cwd: REMOTE_ROOT,
        env: { ANTHROPIC_API_KEY: 'sk-next-run' },
      }
      await gateRemoteAcpEnvForward('claude-acp', nextConfig, new AbortController().signal)
      assert.equal(promptedAgain, true)
      assert.deepEqual(nextConfig.env, { ANTHROPIC_API_KEY: 'sk-next-run' })
    },
  )

  it('coalesces concurrent prompts and remembers the shared answer', async () => {
    let prompts = 0
    let approve!: () => void
    setApprovalHandler(
      () =>
        new Promise((resolve) => {
          prompts += 1
          approve = (): void => {
            resolve({ approved: true, remember: false })
          }
        }),
    )
    const first = {
      command: 'claude-code-acp',
      cwd: REMOTE_ROOT,
      env: { ANTHROPIC_API_KEY: 'sk-first' },
    }
    const second = {
      command: 'claude-code-acp',
      cwd: REMOTE_ROOT,
      env: { ANTHROPIC_API_KEY: 'sk-second' },
    }
    const firstPending = gateRemoteAcpEnvForward('claude-acp', first, new AbortController().signal)
    const secondPending = gateRemoteAcpEnvForward(
      'claude-acp',
      second,
      new AbortController().signal,
    )
    await Promise.resolve()

    assert.equal(prompts, 1)
    approve()
    await Promise.all([firstPending, secondPending])
    assert.deepEqual(first.env, { ANTHROPIC_API_KEY: 'sk-first' })
    assert.deepEqual(second.env, { ANTHROPIC_API_KEY: 'sk-second' })
  })
})

describe('remoteAcpAuthRequiredHint', () => {
  beforeEach(async () => {
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('acpOverSshEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
    storageSet('activeProjectId', 'p1')
    storageSet('projects', [{ id: 'p1', path: REMOTE_ROOT, sshHost: 'dev' }])
    setWorkspaceRootForTest(REMOTE_ROOT)
  })

  afterEach(async () => {
    setWorkspaceRootForTest(null)
    storageSet('activeProjectId', null)
    storageSet('projects', [])
    await setSetting('sshWorkspaceEnabled', false)
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('acpOverSshEnabled', false)
  })

  it('rewrites a remote "Authentication required" into remote-side remedies', () => {
    const err = new Error('Authentication required')
    const hint = remoteAcpAuthRequiredHint(err, REMOTE_ROOT, 'claude-acp')
    assert.ok(hint)
    assert.match(hint.message, /dev/)
    assert.match(hint.message, /Settings → ACP agents/)
    assert.equal(hint.cause, err)
  })

  it('matches the agent-reported authentication_failed error kind too', () => {
    const err = new Error('ACP error -32603: Internal error {"errorKind":"authentication_failed"}')
    assert.ok(remoteAcpAuthRequiredHint(err, REMOTE_ROOT, 'claude-acp'))
  })

  it('leaves local auth failures alone — the default message is right there', () => {
    const err = new Error('Authentication required')
    assert.equal(remoteAcpAuthRequiredHint(err, '/some/local/path', 'claude-acp'), null)
  })

  it('leaves non-auth failures alone', () => {
    assert.equal(remoteAcpAuthRequiredHint(new Error('boom'), REMOTE_ROOT, 'claude-acp'), null)
  })
})
