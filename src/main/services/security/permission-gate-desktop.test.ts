import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ensureToolPermitted } from './permission-gate.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { getSetting } from '../storage/settings.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { copseToolPermissionId } from './tool-permissions.ts'
import { runWithAgentRunReadonly } from '../agent-run-readonly.ts'
import { clearDesktopThreadGrants } from './desktop-app-permission.ts'
import { DESKTOP_ALLOWED_APPS_SETTING } from '../desktop-control/desktop-app-policy.ts'

afterEach(async () => {
  setApprovalHandler(null)
  clearDesktopThreadGrants()
  await setSetting('toolPermissionOverrides', {})
  await setSetting(DESKTOP_ALLOWED_APPS_SETTING, [])
})

const snapshotNotes = { toolName: 'desktop_snapshot', args: { app: 'com.apple.Notes' } }

describe('Computer use permission boundary', () => {
  it('lists apps without asking', async () => {
    setApprovalHandler(() => {
      throw new Error('desktop_apps must not prompt')
    })
    assert.equal(await ensureToolPermitted({ toolName: 'desktop_apps', args: {} }), true)
  })

  it('asks once per app per thread, naming the app and the action', async () => {
    const requests: ApprovalRequest[] = []
    setApprovalHandler(async (request) => {
      requests.push(request)
      return { approved: true, remember: false }
    })
    assert.equal(await ensureToolPermitted(snapshotNotes), true)
    assert.equal(
      await ensureToolPermitted({
        toolName: 'desktop_menu',
        args: { app: 'com.apple.Notes', path: ['File', 'New Note'] },
      }),
      true,
    )
    assert.equal(requests.length, 1)
    const [request] = requests
    assert.ok(request)
    assert.equal(request.subject, 'com.apple.Notes')
    assert.equal(request.cause, 'desktop-app-control')
    assert.match(request.body, /read its window contents/)
    assert.deepEqual(getSetting<string[]>(DESKTOP_ALLOWED_APPS_SETTING, []), [])
  })

  it('persists "always allow" and honours denial', async () => {
    setApprovalHandler(async () => ({ approved: false, remember: false }))
    assert.equal(await ensureToolPermitted(snapshotNotes), false)
    setApprovalHandler(async () => ({ approved: true, remember: true }))
    assert.equal(await ensureToolPermitted(snapshotNotes), true)
    assert.deepEqual(getSetting<string[]>(DESKTOP_ALLOWED_APPS_SETTING, []), ['com.apple.Notes'])
  })

  it('never reaches a blocked app, even with an explicit allow override', async () => {
    setApprovalHandler(() => {
      throw new Error('a blocked app must not prompt')
    })
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('desktop_type')]: 'allow',
    })
    await assert.rejects(
      ensureToolPermitted({
        toolName: 'desktop_type',
        args: { app: 'com.apple.Terminal', text: 'ls' },
      }),
      /terminal/,
    )
  })

  it('is unavailable in read-only mode', async () => {
    await setSetting(DESKTOP_ALLOWED_APPS_SETTING, ['com.apple.Notes'])
    await runWithAgentRunReadonly(true, async () => {
      assert.equal(await ensureToolPermitted(snapshotNotes), false)
    })
  })
})
