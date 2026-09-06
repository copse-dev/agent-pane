import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { acpHarnessForContainer, guestAcpAgentConfig } from './guest-acp-agent.ts'

/**
 * Both ends of the run-spec crossing. What must not travel is as important as
 * what must: the user's own env map (their keys), their absolute command path,
 * and any seatbelt config the guest would try to nest inside the container.
 */
const registered: AcpAgentConfig = {
  id: 'claude-acp',
  title: 'Claude',
  command: '/Users/me/.local/bin/claude-agent-acp',
  args: ['--verbose'],
  env: { ANTHROPIC_API_KEY: 'sk-ant-desktop', HTTPS_PROXY: 'http://corp:3128' },
  model: 'claude-opus-5',
  permissionMode: 'acceptEdits',
  configOptions: { thought_level: 'high' },
  availableModels: [{ value: 'claude-opus-5', label: 'Opus 5' }],
  enabled: true,
}

describe('acpHarnessForContainer', () => {
  it('carries identity and session choices, drops env and the desktop command', () => {
    const harness = acpHarnessForContainer(registered, 'ANTHROPIC_API_KEY')
    assert.equal(harness.keyEnvName, 'ANTHROPIC_API_KEY')
    assert.deepEqual(harness.agent, {
      id: 'claude-acp',
      title: 'Claude',
      // The image bakes the binary under its catalogue name.
      command: 'claude-agent-acp',
      args: [],
      model: 'claude-opus-5',
      permissionMode: 'acceptEdits',
      configOptions: { thought_level: 'high' },
      sandbox: false,
      enabled: true,
    })
    assert.ok(!JSON.stringify(harness).includes('sk-ant-desktop'))
  })

  it('runs a retired adapter config under the binary the image carries for it', () => {
    const harness = acpHarnessForContainer(
      { ...registered, id: 'claude-code-acp', command: 'claude-code-acp' },
      'ANTHROPIC_API_KEY',
    )
    assert.equal(harness.agent.id, 'claude-acp')
    assert.equal(harness.agent.command, 'claude-agent-acp')
  })

  it('keeps a custom command when the catalogue does not know the agent', () => {
    const harness = acpHarnessForContainer(
      { id: 'scripted', title: 'Scripted', command: 'node', args: ['agent.cjs'], enabled: true },
      'SCRIPTED_KEY',
    )
    assert.equal(harness.agent.command, 'node')
    assert.deepEqual(harness.agent.args, ['agent.cjs'])
  })
})

describe('guestAcpAgentConfig', () => {
  it("gives the agent exactly one variable — the run's key under its own name", () => {
    const harness = acpHarnessForContainer(registered, 'ANTHROPIC_API_KEY')
    const guest = guestAcpAgentConfig(harness, 'sk-ant-run-scoped')
    assert.deepEqual(guest.env, { ANTHROPIC_API_KEY: 'sk-ant-run-scoped' })
    assert.equal(guest.sandbox, false)
    assert.equal(guest.enabled, true)
  })

  it('sets no variable at all when the run has no key', () => {
    const harness = acpHarnessForContainer(registered, 'ANTHROPIC_API_KEY')
    assert.equal('env' in guestAcpAgentConfig(harness, ''), false)
  })
})
