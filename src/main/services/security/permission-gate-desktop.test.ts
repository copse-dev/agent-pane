import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ensureToolPermitted } from './permission-gate.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { getSetting } from '../storage/settings.ts'
import { setSetting } from '../storage/settings.test-shim.ts'
import { copseToolPermissionId } from './tool-permissions.ts'
import { runWithAgentRunReadonly } from '../agent-run-readonly.ts'
import { clearDesktopThreadGrants, isDesktopControlTool } from './desktop-app-permission.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { DESKTOP_ALLOWED_APPS_SETTING } from '../desktop-control/desktop-app-policy.ts'

afterEach(async () => {
  setApprovalHandler(null)
  clearDesktopThreadGrants()
  await setSetting('toolPermissionOverrides', {})
  await setSetting(DESKTOP_ALLOWED_APPS_SETTING, [])
})

const snapshotNotes = { toolName: 'desktop_snapshot', args: { app: 'com.apple.Notes' } }
const snapshotFinder = { toolName: 'desktop_snapshot', args: { app: 'com.apple.finder' } }

function inThread<T>(threadId: string, fn: () => T): T {
  return runWithThreadExecutionContext(
    {
      projectId: 'project-1',
      threadId,
      projectRoot: '/tmp/desktop-project',
      root: '/tmp/desktop-project',
      checkoutMode: 'shared',
      branch: null,
    },
    fn,
  )
}

function recordApprovals(remember = false): ApprovalRequest[] {
  const requests: ApprovalRequest[] = []
  setApprovalHandler(async (request) => {
    requests.push(request)
    return { approved: true, remember }
  })
  return requests
}

describe('Computer use permission boundary', () => {
  it('lists apps without asking', async () => {
    setApprovalHandler(() => {
      throw new Error('desktop_apps must not prompt')
    })
    assert.equal(await ensureToolPermitted({ toolName: 'desktop_apps', args: {} }), true)
  })

  it('asks once per app per thread, naming the app and the action', async () => {
    const requests = recordApprovals()
    await inThread('thread-a', async () => {
      assert.equal(await ensureToolPermitted(snapshotNotes), true)
      assert.equal(
        await ensureToolPermitted({
          toolName: 'desktop_menu',
          args: { app: 'com.apple.Notes', path: ['File', 'New Note'] },
        }),
        true,
      )
    })
    assert.equal(requests.length, 1)
    const [request] = requests
    assert.ok(request)
    assert.equal(request.subject, 'com.apple.Notes')
    assert.equal(request.cause, 'desktop-app-control')
    assert.equal(request.approveLabel, 'Allow for this thread')
    assert.match(request.bodyAdvice ?? '', /read its window contents/)
    assert.deepEqual(getSetting<string[]>(DESKTOP_ALLOWED_APPS_SETTING, []), [])

    await inThread('thread-b', () => ensureToolPermitted(snapshotNotes))
    assert.equal(requests.length, 2, 'a grant does not carry to another thread')
  })

  it('keeps no grant for a call outside a thread', async () => {
    const requests = recordApprovals()
    assert.equal(await ensureToolPermitted(snapshotNotes), true)
    assert.equal(await ensureToolPermitted(snapshotNotes), true)
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.approveLabel, 'Allow once')
  })

  it('still asks per app when the tool has an explicit allow override', async () => {
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('desktop_snapshot')]: 'allow',
    })
    const requests = recordApprovals()
    await inThread('thread-a', () => ensureToolPermitted(snapshotNotes))
    assert.equal(requests.length, 1)
  })

  it('warns about Finder every thread and never saves it as always allowed', async () => {
    await setSetting(DESKTOP_ALLOWED_APPS_SETTING, ['com.apple.finder'])
    const requests = recordApprovals(true)
    await inThread('thread-a', async () => {
      assert.equal(await ensureToolPermitted(snapshotFinder), true)
      assert.equal(await ensureToolPermitted(snapshotFinder), true)
    })
    await inThread('thread-b', () => ensureToolPermitted(snapshotFinder))
    assert.equal(requests.length, 2, 'a saved Finder grant is ignored; a thread grant holds')
    const [request] = requests
    assert.ok(request)
    assert.equal(request.allowRemember, false)
    assert.match(request.bodyAdvice ?? '', /scripts and apps/)
    assert.deepEqual(getSetting<string[]>(DESKTOP_ALLOWED_APPS_SETTING, []), ['com.apple.finder'])
  })

  it('gates only the computer-use tools, not every desktop_ name', () => {
    assert.equal(isDesktopControlTool('desktop_click'), true)
    assert.equal(isDesktopControlTool('desktop_apps'), true)
    assert.equal(isDesktopControlTool('desktop_notify'), false)
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
    await assert.rejects(
      ensureToolPermitted({
        toolName: 'desktop_type',
        args: { app: 'com.apple.ScriptEditor2', text: 'do shell script "ls"' },
      }),
      /script or automation/,
    )
  })

  it('is unavailable in read-only mode', async () => {
    await setSetting(DESKTOP_ALLOWED_APPS_SETTING, ['com.apple.Notes'])
    await runWithAgentRunReadonly(true, async () => {
      assert.equal(await ensureToolPermitted(snapshotNotes), false)
    })
  })
})
