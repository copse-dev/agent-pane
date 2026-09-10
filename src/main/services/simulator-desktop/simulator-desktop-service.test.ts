import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulatorDesktopInternals } from './simulator-desktop-service.ts'

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
})
