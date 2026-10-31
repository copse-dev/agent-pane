import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ensureToolPermitted } from './permission-gate.ts'
import { setApprovalHandler } from '../approval.ts'
import { setSetting } from '../storage/settings.ts'
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
    for (const action of [
      'list',
      'open',
      'launch',
      'screenshot',
      'show',
      'input',
      'delete_simulator',
    ]) {
      assert.equal(await ensureToolPermitted({ toolName: 'device_hub', args: { action } }), false)
    }
    assert.equal(prompts, 7)
  })

  it('honors explicit allow/block but never bypasses read-only mode', async () => {
    const check = { toolName: 'device_hub', args: { action: 'input' } }
    await setSetting('toolPermissionOverrides', { [copseToolPermissionId('device_hub')]: 'allow' })
    assert.equal(await ensureToolPermitted(check), true)
    await runWithAgentRunReadonly(true, async () => {
      assert.equal(await ensureToolPermitted(check), false)
      assert.equal(
        await ensureToolPermitted({
          toolName: 'device_hub',
          args: {
            action: 'screenshot',
            device_id: '11111111-2222-4333-8444-555555555555',
            output_path: 'artifacts/simulator.png',
          },
        }),
        false,
      )
      assert.equal(
        await ensureToolPermitted({
          toolName: 'device_hub',
          args: { action: 'delete_simulator', device_id: '11111111-2222-4333-8444-555555555555' },
        }),
        false,
      )
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

it('asks for exact simulator deletion even when Device Hub already has a broad allow', async () => {
  await setSetting('toolPermissionOverrides', { [copseToolPermissionId('device_hub')]: 'allow' })
  let prompts = 0
  setApprovalHandler(async (request) => {
    prompts++
    assert.equal(request.allowRemember, false)
    assert.ok(request.body.includes('11111111-2222-4333-8444-555555555555'))
    return { approved: false, remember: false }
  })
  assert.equal(
    await ensureToolPermitted({
      toolName: 'device_hub',
      args: { action: 'delete_simulator', device_id: '11111111-2222-4333-8444-555555555555' },
    }),
    false,
  )
  assert.equal(prompts, 1)
  assert.equal(
    await ensureToolPermitted({ toolName: 'device_hub', args: { action: 'list' } }),
    true,
  )
  assert.equal(prompts, 1)
})
