import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { launchGuiAppTool } from './gui-app-launch-tool.ts'

describe('launch_gui_app tool', () => {
  afterEach(() => {
    // No process-global state to clear; platform check is pure.
  })

  it('parses the expected parameter shape', () => {
    const parsed = launchGuiAppTool.parameters.parse({
      target: '/Applications/Safari.app',
      args: ['--foo'],
      env: { COPSE_PANEL_USER_DATA: '/tmp/x' },
      new_instance: true,
    })
    assert.equal(parsed.target, '/Applications/Safari.app')
    assert.deepEqual(parsed.args, ['--foo'])
    assert.equal(parsed.env?.['COPSE_PANEL_USER_DATA'], '/tmp/x')
    assert.equal(parsed.new_instance, true)
  })

  it('defaults new_instance to true', () => {
    const parsed = launchGuiAppTool.parameters.parse({ target: 'Safari' })
    assert.equal(parsed.new_instance, true)
  })

  it('rejects an empty target at parse time', () => {
    assert.throws(() => launchGuiAppTool.parameters.parse({ target: '' }))
  })
})
