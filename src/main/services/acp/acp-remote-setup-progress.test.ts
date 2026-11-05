import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { setSetting } from '../storage/settings.ts'
import {
  resetSshConnectionManagerForTests,
  resetSshTransportFactory,
  setSshTransportFactory,
} from '../ssh-workspace/connection-manager.ts'
import { FakeSshTransport } from '../ssh-workspace/fake-ssh-transport.ts'
import { setRemoteAcpInstallApprover } from './acp-remote-install-approval.ts'
import {
  reportRemoteAcpSetupProgress,
  withRemoteAcpSetupProgress,
  type RemoteAcpSetupProgress,
} from './acp-remote-setup-progress.ts'
import { spawnRemoteAcpTransport } from './acp-ssh-transport.ts'

describe('remote ACP setup progress seam', () => {
  it('delivers reports only inside the bound async context', async () => {
    const seen: RemoteAcpSetupProgress[] = []
    reportRemoteAcpSetupProgress({ phase: 'start', label: 'before' })
    await withRemoteAcpSetupProgress(
      (progress) => seen.push(progress),
      async () => {
        await Promise.resolve()
        reportRemoteAcpSetupProgress({ phase: 'start', label: 'inside' })
      },
    )
    reportRemoteAcpSetupProgress({ phase: 'start', label: 'after' })
    assert.deepEqual(seen, [{ phase: 'start', label: 'inside' }])
  })

  it('keeps concurrent turns apart', async () => {
    const first: string[] = []
    const second: string[] = []
    await Promise.all([
      withRemoteAcpSetupProgress(
        ({ label }) => first.push(label),
        async () => {
          await Promise.resolve()
          reportRemoteAcpSetupProgress({ phase: 'start', label: 'one' })
        },
      ),
      withRemoteAcpSetupProgress(
        ({ label }) => second.push(label),
        async () => {
          reportRemoteAcpSetupProgress({ phase: 'setup', label: 'two' })
          await Promise.resolve()
        },
      ),
    ])
    assert.deepEqual(first, ['one'])
    assert.deepEqual(second, ['two'])
  })
})

describe('spawnRemoteAcpTransport progress', () => {
  beforeEach(async () => {
    resetSshConnectionManagerForTests()
    await setSetting('sshWorkspaceEnabled', true)
    await setSetting('sshWorkspaceHosts', [
      { id: 'dev', label: 'Dev', host: 'dev.example.com', user: 'alice' },
    ])
  })

  afterEach(async () => {
    setRemoteAcpInstallApprover(null)
    resetSshTransportFactory()
    resetSshConnectionManagerForTests()
    await setSetting('sshWorkspaceHosts', [])
    await setSetting('sshWorkspaceEnabled', false)
  })

  async function stagesFor(
    command: string,
    scripts: ConstructorParameters<typeof FakeSshTransport>[0],
  ): Promise<{ stages: RemoteAcpSetupProgress[]; error: unknown }> {
    setSshTransportFactory(() => new FakeSshTransport(scripts))
    const stages: RemoteAcpSetupProgress[] = []
    let error: unknown = null
    await withRemoteAcpSetupProgress(
      (progress) => stages.push(progress),
      () =>
        spawnRemoteAcpTransport(
          { command, cwd: '/srv/app' },
          { hostId: 'dev', remoteRoot: '/srv/app' },
        ),
    ).catch((err: unknown) => {
      error = err
    })
    return { stages, error }
  }

  it('names the host while connecting and looking for the agent', async () => {
    // The agent is absent and not installable, so the spawn stops before ssh.
    const { stages, error } = await stagesFor('not-a-catalog-agent', [
      { when: /__COPSE_ACP_PROBE__/, stdout: '\n__COPSE_ACP_PROBE__MISSING:/usr/bin\n' },
    ])
    assert.match(String(error), /was not found on the remote host/)
    assert.deepEqual(stages, [
      { phase: 'start', label: 'Connecting to Dev…' },
      { phase: 'start', label: 'Finding not-a-catalog-agent on Dev…' },
    ])
  })

  it('marks an approved adapter install as one-time setup', async () => {
    const asked: string[] = []
    setRemoteAcpInstallApprover(({ body }) => {
      asked.push(body)
      return Promise.resolve(true)
    })
    const { stages } = await stagesFor('qwen', [
      { when: /__COPSE_ACP_PROBE__/, stdout: '\n__COPSE_ACP_PROBE__MISSING:/usr/bin\n' },
      { when: /npm install -g --ignore-scripts/, code: 1 },
    ])
    assert.equal(asked.length, 1)
    assert.match(at(asked, 0), /one-time setup for Dev/)
    const setup = stages.filter((stage) => stage.phase === 'setup')
    assert.equal(setup.length, 1)
    assert.match(
      at(setup, 0).label,
      /^Installing @qwen-code\/qwen-code@\S+ on Dev \(one-time setup\)…$/,
    )
  })

  it('reports no install stage when the user declines it', async () => {
    setRemoteAcpInstallApprover(() => Promise.resolve(false))
    const { stages } = await stagesFor('qwen', [
      { when: /__COPSE_ACP_PROBE__/, stdout: '\n__COPSE_ACP_PROBE__MISSING:/usr/bin\n' },
    ])
    assert.equal(
      stages.some((stage) => stage.phase === 'setup'),
      false,
    )
  })
})
