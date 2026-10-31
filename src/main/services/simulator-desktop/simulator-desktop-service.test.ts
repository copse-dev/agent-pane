import { SIMULATOR_REMOVED_DETAIL } from '@shared/types/simulator-desktop.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
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
  mock.restoreAll()
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

  it('cancels agent input before discovery or compilation and rejects a stopped simulator', async () => {
    const service = new SimulatorDesktopService()
    const list = mock.method(service, 'listDevices', async (signal?: AbortSignal) => {
      assert.equal(signal, activeSignal)
      return []
    })
    const activeSignal = new AbortController().signal
    const cancelled = AbortSignal.abort(new Error('cancelled input'))
    await assert.rejects(
      service.agentInput(DEVICE.udid, { type: 'tap', x: 0.5, y: 0.5 }, cancelled),
      /cancelled input/,
    )
    assert.equal(list.mock.callCount(), 0)
    await assert.rejects(
      service.agentInput(DEVICE.udid, { type: 'button-tap', name: 'home' }, activeSignal),
      /no longer booted/,
    )
    assert.equal(list.mock.callCount(), 1)
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

it('acknowledges the requested device only after a frame is sent, and aborts cancelled waits', async () => {
  const second = { ...DEVICE, udid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
  setSeededSimulatorDesktopForTests([DEVICE, second], {
    bytes: Uint8Array.from([1]),
    mimeType: 'image/png',
    pixelWidth: 1,
    pixelHeight: 1,
  })
  const service = new SimulatorDesktopService()
  let received = false
  const ready = service.waitForFrame(DEVICE.udid, new AbortController().signal).then(() => {
    received = true
  })
  const other = await service.open(second.udid, OWNER)
  service.start(other.id, OWNER.id)
  await Promise.resolve()
  assert.equal(received, false)
  const selected = await service.open(DEVICE.udid, OWNER)
  assert.equal(received, false, 'opening a connection is not a frame')
  service.start(selected.id, OWNER.id)
  await ready
  assert.equal(received, true)
  const controller = new AbortController()
  const cancelled = service.waitForFrame(DEVICE.udid, controller.signal)
  controller.abort('cancelled by user')
  await assert.rejects(cancelled, /cancelled by user/)
  await service.closeAll()
})

it('bounds a Desktop request with no native frame', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const service = new SimulatorDesktopService()
  const waiting = service.waitForFrame(DEVICE.udid, new AbortController().signal)
  t.mock.timers.tick(90_000)
  await assert.rejects(waiting, /Desktop capture is unverified/)
  t.mock.timers.reset()
})

it('disconnects only the removed device before deletion and refreshes viewers only after success', async () => {
  const other = { ...DEVICE, udid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
  setSeededSimulatorDesktopForTests([DEVICE, other], {
    bytes: Uint8Array.from([1]),
    mimeType: 'image/png',
    pixelWidth: 1,
    pixelHeight: 1,
  })
  const events: unknown[][] = []
  const owner: SimulatorDesktopOwner = {
    ...OWNER,
    send: (...args) => {
      events.push(args)
    },
  }
  const service = new SimulatorDesktopService()
  const target = await service.open(DEVICE.udid, owner)
  const remaining = await service.open(other.udid, owner)
  await service.retireDevice(DEVICE.udid, async () => {
    assert.ok(JSON.stringify(events).includes(target.id))
    assert.ok(!JSON.stringify(events).includes(SIMULATOR_REMOVED_DETAIL))
    await assert.rejects(service.open(DEVICE.udid, owner), /being removed/)
    await assert.rejects(
      service.retireDevice(DEVICE.udid, async () => true),
      /already being removed/,
    )
    return { verifiedAbsent: true }
  })
  assert.ok(JSON.stringify(events).includes(SIMULATOR_REMOVED_DETAIL))
  assert.ok(!JSON.stringify(events).includes(remaining.id))
  events.length = 0
  await assert.rejects(
    service.retireDevice(other.udid.toUpperCase(), async () => {
      throw new Error('native delete failed')
    }),
    /native delete failed/,
  )
  assert.ok(!JSON.stringify(events).includes(SIMULATOR_REMOVED_DETAIL))
  await service.closeAll()
})
