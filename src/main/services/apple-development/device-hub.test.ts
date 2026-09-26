import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { stat, writeFile } from 'node:fs/promises'
import { DeviceHubService, parseDeviceHubDevices } from './device-hub.ts'

const ID = '11111111-2222-4333-8444-555555555555'
const SIMULATOR = {
  identifier: ID,
  properties: {
    hardware: { udid: ID, platform: 'iOS', reality: 'simulated' },
    software: { osVersionNumber: { stringValue: '27.0' } },
    state: { name: 'Test phone', bootState: 'booted' },
    connection: { state: 'connected' },
  },
  capabilities: [{ featureIdentifier: 'com.apple.coredevice.feature.capturescreenshot' }],
}
const PHYSICAL = {
  identifier: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  hardwareProperties: { udid: '00008140-0000000000000001', platform: 'iOS' },
  deviceProperties: { name: 'Paired phone', osVersionNumber: '26.6.2', bootState: 'booted' },
  connectionProperties: { tunnelState: 'disconnected' },
}
const inventory = JSON.stringify({ result: { devices: [SIMULATOR, PHYSICAL] } })
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])

describe('Device Hub', () => {
  it('reads current properties and legacy paired devices without claiming physical input support', () => {
    const devices = parseDeviceHubDevices(inventory)
    assert.deepEqual(devices[0], {
      id: ID,
      udid: ID,
      name: 'Test phone',
      platform: 'iOS',
      osVersion: '27.0',
      kind: 'simulator',
      connection: 'connected',
      bootState: 'booted',
      screenshot: true,
      input: true,
    })
    assert.equal(devices[1]?.kind, 'physical')
    assert.equal(devices[1].udid, PHYSICAL.hardwareProperties.udid)
    assert.equal(devices[1].connection, 'disconnected')
    assert.equal(devices[1].input, false)
    assert.throws(() => parseDeviceHubDevices('{'), /invalid/)
    assert.throws(() => parseDeviceHubDevices('{"result":{}}'), /invalid/)
  })

  it('uses JSON files, validates identity, selects the correct launch backend, and removes scratch', async () => {
    const calls: string[][] = []
    const outputs: string[] = []
    const signal = new AbortController().signal
    const service = new DeviceHubService(async (file, args, receivedSignal) => {
      assert.equal(file, '/usr/bin/xcrun')
      assert.equal(receivedSignal, signal)
      calls.push(args)
      const output = args[args.indexOf('--json-output') + 1]
      if (args.includes('--json-output') && output) {
        outputs.push(output)
        await writeFile(output, args.includes('list') ? inventory : '{"result":{"pid":123}}')
      }
      return 'launched'
    })
    await assert.rejects(service.launch('unknown', 'com.example.app', signal), /Device not found/)
    assert.equal(calls.length, 1)
    assert.equal(await service.launch(ID, 'com.example.app', signal), 'launched')
    assert.deepEqual(calls[2], ['simctl', 'launch', ID, 'com.example.app'])
    assert.equal(
      await service.launch(PHYSICAL.hardwareProperties.udid, 'com.example.app', signal),
      '{"pid":123}',
    )
    assert.deepEqual(calls[4]?.slice(0, 7), [
      'devicectl',
      'device',
      'process',
      'launch',
      '--device',
      PHYSICAL.identifier,
      'com.example.app',
    ])
    const before = calls.length
    await assert.rejects(service.launch(ID, '--console', signal))
    await assert.rejects(service.device('../../oops', signal))
    assert.equal(calls.length, before)
    for (const output of outputs) await assert.rejects(stat(output), { code: 'ENOENT' })
  })

  it('captures simulator and physical PNGs and cleans files after success and failure', async () => {
    const files: string[] = []
    const calls: string[][] = []
    let invalidPng = false
    const service = new DeviceHubService(async (_file, args) => {
      calls.push(args)
      const output = args.includes('--json-output')
        ? args[args.indexOf('--json-output') + 1]
        : undefined
      if (output) {
        await writeFile(output, inventory)
        return ''
      }
      const destination = args.includes('--destination')
        ? args[args.indexOf('--destination') + 1]
        : args.at(-1)
      assert.ok(destination)
      files.push(destination)
      await writeFile(destination, invalidPng ? Buffer.from('not a PNG') : png)
      return ''
    })
    const signal = new AbortController().signal
    assert.deepEqual(await service.screenshot(ID, signal), png)
    assert.deepEqual(await service.screenshot(PHYSICAL.identifier, signal), png)
    assert.deepEqual(calls[1]?.slice(0, 4), ['simctl', 'io', ID, 'screenshot'])
    assert.deepEqual(calls[3]?.slice(0, 6), [
      'devicectl',
      'device',
      'capture',
      'screenshot',
      '--device',
      PHYSICAL.identifier,
    ])
    invalidPng = true
    await assert.rejects(service.screenshot(ID, signal), /invalid PNG/)
    for (const file of files) await assert.rejects(stat(file), { code: 'ENOENT' })
  })

  it('cleans JSON scratch when a command aborts', async () => {
    let output: string | undefined
    const service = new DeviceHubService(async (_file, args) => {
      output = args[args.indexOf('--json-output') + 1]
      assert.ok(output)
      await writeFile(output, '{}')
      throw new Error('aborted')
    })
    await assert.rejects(service.list(new AbortController().signal), /aborted/)
    assert.ok(output)
    await assert.rejects(stat(output), { code: 'ENOENT' })
  })
})
