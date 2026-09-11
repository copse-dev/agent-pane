import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  setSeededSimulatorDesktopForTests,
  SimulatorDesktopService,
  simulatorDesktopInternals,
  type SimulatorDesktopOwner,
} from './simulator-desktop-service.ts'

const DEVICE = {
  udid: '11111111-2222-4333-8444-555555555555',
  name: 'iPhone 17 Pro',
  runtime: 'iOS 26.5',
}

const OWNER: SimulatorDesktopOwner = {
  id: 1,
  isDestroyed: () => false,
  send: () => {},
}

afterEach(() => {
  setSeededSimulatorDesktopForTests([], null)
})

describe('Simulator desktop device discovery', () => {
  it('keeps only booted available devices and presents runtime names', () => {
    const devices = simulatorDesktopInternals.parsedBootedDevices(
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            {
              udid: '11111111-2222-4333-8444-555555555555',
              name: 'iPhone 17 Pro',
              state: 'Booted',
              isAvailable: true,
            },
            {
              udid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              name: 'iPhone Air',
              state: 'Shutdown',
              isAvailable: true,
            },
          ],
        },
      }),
    )

    assert.deepEqual(devices, [
      {
        udid: '11111111-2222-4333-8444-555555555555',
        name: 'iPhone 17 Pro',
        runtime: 'iOS 26.5',
      },
    ])
  })

  it('allows only one live capture process per Simulator', async () => {
    setSeededSimulatorDesktopForTests([DEVICE], {
      bytes: Uint8Array.from([1]),
      mimeType: 'image/png',
      pixelWidth: 1,
      pixelHeight: 1,
    })
    const service = new SimulatorDesktopService()
    const first = await service.open(DEVICE.udid, OWNER)

    await assert.rejects(
      service.open(DEVICE.udid, { ...OWNER, id: 2 }),
      /already open in another Desktop tab/,
    )

    await service.close(first.id, OWNER.id)
    const reopened = await service.open(DEVICE.udid, { ...OWNER, id: 2 })
    assert.equal(reopened.device.udid, DEVICE.udid)
    await service.close(reopened.id, 2)
  })
})
