import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deviceHubTool } from './device-hub-tool.ts'

describe('Device Hub tool contract', () => {
  it('requires an explicit device for every device operation', () => {
    for (const action of ['apps', 'launch', 'screenshot', 'show', 'input']) {
      assert.equal(deviceHubTool.parameters.safeParse({ action }).success, false)
    }
    assert.equal(deviceHubTool.parameters.safeParse({ action: 'open' }).success, true)
    assert.equal(
      deviceHubTool.parameters.safeParse({
        action: 'input',
        device_id: 'abc',
        input: { type: 'tap', x: 2, y: 0 },
      }).success,
      false,
    )
    assert.equal(
      deviceHubTool.parameters.safeParse({
        action: 'launch',
        device_id: 'abc',
        bundle_id: '--console',
      }).success,
      false,
    )
  })

  it('rejects execution without an enrolled Apple project before touching devices', async () => {
    await assert.rejects(
      async () => deviceHubTool.execute({ action: 'list' }, new AbortController().signal),
      /enroll a local macOS project/,
    )
  })
})
