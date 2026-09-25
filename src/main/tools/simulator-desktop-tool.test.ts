import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setSetting } from '../services/storage/settings.test-shim.ts'
import { setSeededSimulatorDesktopForTests } from '../services/simulator-desktop/simulator-desktop-service.ts'
import { setSimulatorDesktopPanelPresenter } from '../services/simulator-desktop/simulator-desktop-panel.ts'
import { openSimulatorDesktopTool } from './simulator-desktop-tool.ts'

const FIRST = {
  udid: '11111111-2222-4333-8444-555555555555',
  name: 'iPhone 17 Pro',
  runtime: 'iOS 26.5',
}
const SECOND = {
  udid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'iPhone Air',
  runtime: 'iOS 26.5',
}

afterEach(async () => {
  setSeededSimulatorDesktopForTests([], null)
  setSimulatorDesktopPanelPresenter(null)
  await setSetting('vncEnabled', false)
})

describe('open_simulator_desktop', () => {
  it('shows the sole booted Simulator in the visible panel', async () => {
    await setSetting('vncEnabled', true)
    setSeededSimulatorDesktopForTests([FIRST], null)
    const shown: string[] = []
    setSimulatorDesktopPanelPresenter((udid) => shown.push(udid))

    const result = await openSimulatorDesktopTool.execute(
      openSimulatorDesktopTool.parameters.parse({}),
      new AbortController().signal,
    )

    assert.deepEqual(shown, [FIRST.udid])
    if (typeof result !== 'string') assert.fail('expected a text result')
    assert.match(result, /iPhone 17 Pro/)
  })

  it('requires an explicit UDID when several Simulators are booted', async () => {
    await setSetting('vncEnabled', true)
    setSeededSimulatorDesktopForTests([FIRST, SECOND], null)
    const shown: string[] = []
    setSimulatorDesktopPanelPresenter((udid) => shown.push(udid))

    const result = await openSimulatorDesktopTool.execute(
      openSimulatorDesktopTool.parameters.parse({}),
      new AbortController().signal,
    )

    assert.deepEqual(shown, [])
    if (typeof result !== 'string') assert.fail('expected a text result')
    assert.match(result, new RegExp(FIRST.udid))
    assert.match(result, new RegExp(SECOND.udid))
  })

  it('does not bypass the Desktop viewer setting and says how to turn it on', async () => {
    setSeededSimulatorDesktopForTests([FIRST], null)
    const shown: string[] = []
    setSimulatorDesktopPanelPresenter((udid) => shown.push(udid))
    await assert.rejects(
      async () =>
        await openSimulatorDesktopTool.execute(
          openSimulatorDesktopTool.parameters.parse({ udid: FIRST.udid }),
          new AbortController().signal,
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Desktop viewer is off/)
        assert.match(error.message, /Settings → Experimental → Remote desktop viewer/)
        assert.match(error.message, /call open_simulator_desktop again/)
        assert.doesNotMatch(error.message, /not booted|No booted Simulator/)
        return true
      },
    )
    assert.deepEqual(shown, [])
  })
})
