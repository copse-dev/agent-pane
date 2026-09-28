import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ensureToolPermitted } from './permission-gate.ts'
import { setApprovalHandler } from '../approval.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { copseToolPermissionId } from './tool-permissions.ts'
import { runWithAgentRunReadonly } from '../agent-run-readonly.ts'

afterEach(async () => {
  setApprovalHandler(null)
  await setSetting('toolPermissionOverrides', {})
})

describe('Device Hub permission boundary', () => {
  it('asks for host access, including discovery and screenshots, and honors denial', async () => {
    let prompts = 0
    setApprovalHandler(async (request) => {
      prompts++
      assert.equal(request.subject, 'device_hub')
      return { approved: false, remember: false }
    })
    for (const action of ['list', 'open', 'launch', 'screenshot', 'show', 'input']) {
      assert.equal(await ensureToolPermitted({ toolName: 'device_hub', args: { action } }), false)
    }
    assert.equal(prompts, 6)
  })

  it('honors explicit allow/block but never bypasses read-only mode', async () => {
    const check = { toolName: 'device_hub', args: { action: 'input' } }
    await setSetting('toolPermissionOverrides', { [copseToolPermissionId('device_hub')]: 'allow' })
    assert.equal(await ensureToolPermitted(check), true)
    await runWithAgentRunReadonly(true, async () => {
      assert.equal(await ensureToolPermitted(check), false)
    })
    await setSetting('toolPermissionOverrides', { [copseToolPermissionId('device_hub')]: 'block' })
    assert.equal(await ensureToolPermitted(check), false)
  })

  it('rechecks blocked policy after an approval', async () => {
    setApprovalHandler(async () => {
      await setSetting('toolPermissionOverrides', {
        [copseToolPermissionId('device_hub')]: 'block',
      })
      return { approved: true, remember: false }
    })
    assert.equal(
      await ensureToolPermitted({ toolName: 'device_hub', args: { action: 'open' } }),
      false,
    )
  })
})
