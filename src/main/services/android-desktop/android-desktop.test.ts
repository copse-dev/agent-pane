import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  Server,
  ServerCredentials,
  status,
  type ServerWritableStream,
  type ServerReadableStream,
  type sendUnaryData,
  type MethodDefinition,
} from '@grpc/grpc-js'
import { PNG } from 'pngjs'
import { z } from 'zod'
import { discoverAndroidEndpoints, type AndroidEndpoint } from './android-discovery.ts'
import { AndroidController, androidControllerInternals } from './android-controller.ts'
import { AndroidDesktopService } from './android-desktop-service.ts'
import type { SimulatorDesktopOwner } from '../simulator-desktop/simulator-desktop-service.ts'

const { protocol, encode } = androidControllerInternals
const token = 'test-token-not-a-real-credential'
const device = {
  udid: 'android:123',
  name: 'Pixel test',
  runtime: 'Android Emulator',
  platform: 'android' as const,
}

async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for emulator event')
}

describe('Android emulator discovery', () => {
  it('ignores stale, symlinked and oversized records, retains unsupported auth as an actionable device', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'copse-android-discovery-'))
    try {
      await writeFile(
        join(directory, 'pid_123.ini'),
        `grpc.port=8556\ngrpc.token=${token}\navd.name=Pixel\n`,
      )
      await writeFile(
        join(directory, 'pid_456_info.ini'),
        'grpc.port=8557\ngrpc.jwks=/private/keys\n',
      )
      await writeFile(join(directory, 'pid_789.ini'), `grpc.port=8558\ngrpc.token=${token}\n`)
      await writeFile(join(directory, 'pid_111.ini'), 'x'.repeat(32769))
      await symlink(join(directory, 'pid_123.ini'), join(directory, 'pid_222.ini'))
      const records = await discoverAndroidEndpoints(directory, (pid) => pid !== 789)
      assert.deepEqual(
        records.map((entry) => entry.device.udid),
        ['android:123', 'android:456'],
      )
      assert.equal(records[0]?.token, token)
      assert.equal(JSON.stringify(records.map((entry) => entry.device)).includes(token), false)
      assert.match(records[1]?.device.unavailableReason ?? '', /authentication/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('Android emulator transport and lifecycle', { timeout: 10_000 }, () => {
  const server = new Server()
  let endpoint: AndroidEndpoint
  const streams = new Set<ServerWritableStream<Buffer, Buffer>>()
  const inputs: { method: string; value: unknown }[] = []
  const identity = (value: Buffer): Buffer => value
  const definition = (method: string, streaming = false): MethodDefinition<Buffer, Buffer> => ({
    path: `/android.emulation.control.EmulatorController/${method}`,
    requestStream: false,
    responseStream: streaming,
    requestSerialize: identity,
    requestDeserialize: identity,
    responseSerialize: identity,
    responseDeserialize: identity,
  })
  const frame = (width: number, height: number): Buffer =>
    encode('Image', {
      format: { format: 0, width, height, rotation: { rotation: width > height ? 1 : 0 } },
      image: PNG.sync.write(new PNG({ width, height })),
    })
  before(async () => {
    server.addService(
      {
        streamScreenshot: definition('streamScreenshot', true),
        streamInputEvent: { ...definition('streamInputEvent'), requestStream: true },
      },
      {
        streamScreenshot(call: ServerWritableStream<Buffer, Buffer>): void {
          if (call.metadata.get('authorization')[0] !== `Bearer ${token}`) {
            call.emit(
              'error',
              Object.assign(new Error('Rejected'), { code: status.UNAUTHENTICATED }),
            )
            return
          }
          streams.add(call)
          call.on('cancelled', () => streams.delete(call))
          call.write(frame(200, 400))
        },
        streamInputEvent(
          call: ServerReadableStream<Buffer, Buffer>,
          callback: sendUnaryData<Buffer>,
        ): void {
          assert.deepEqual(call.metadata.get('authorization'), [`Bearer ${token}`])
          call.on('data', (bytes: Buffer) => {
            const message = protocol.lookupType('InputEvent')
            const value = z
              .object({ keyEvent: z.unknown(), touchEvent: z.unknown() })
              .parse(message.toObject(message.decode(bytes), { defaults: true }))
            inputs.push(
              value.keyEvent
                ? { method: 'sendKey', value: value.keyEvent }
                : { method: 'sendTouch', value: value.touchEvent },
            )
          })
          call.on('end', () => {
            callback(null, Buffer.alloc(0))
          })
        },
      },
    )
    const port = await new Promise<number>((resolve, reject) => {
      server.bindAsync('127.0.0.1:0', ServerCredentials.createInsecure(), (error, boundPort) => {
        if (error) reject(error)
        else resolve(boundPort)
      })
    })
    endpoint = { device, port, token }
  })
  after(() => {
    server.forceShutdown()
  })

  it('streams authenticated frames, maps native rotated input and releases a held touch on close', async () => {
    const controller = new AndroidController(endpoint)
    const frames: { width: number; height: number }[] = []
    const errors: Error[] = []
    controller.start(
      (value) => frames.push(value),
      (error) => errors.push(error),
    )
    try {
      await until(() => frames.length === 1)
      for (const stream of streams) stream.write(frame(400, 200))
      await until(() => frames.length === 2)
      await controller.input({ type: 'touch', phase: 'down', x: 1, y: 0.5 })
      await until(() => inputs.length >= 1)
      const touchSchema = z.object({
        touches: z.array(z.object({ x: z.number(), y: z.number(), pressure: z.number() })),
      })
      assert.deepEqual(touchSchema.parse(inputs.at(-1)?.value).touches[0], {
        x: 100,
        y: 399,
        pressure: 1024,
      })
      await controller.input({ type: 'key-tap', usage: 4, modifiers: [225] })
      await until(() => inputs.length >= 4)
      const key = z.object({ keyCode: z.number(), eventType: z.number() })
      assert.deepEqual(
        inputs.slice(-3).map((value) => key.parse(value.value)),
        [
          { keyCode: 0x700e1, eventType: 0 },
          { keyCode: 0x70004, eventType: 2 },
          { keyCode: 0x700e1, eventType: 1 },
        ],
      )
      await controller.input({ type: 'button-tap', name: 'back' })
      await until(() => inputs.length >= 5)
      assert.equal(z.object({ key: z.string() }).parse(inputs.at(-1)?.value).key, 'GoBack')
      await controller.close()
      assert.equal(touchSchema.parse(inputs.at(-1)?.value).touches[0]?.pressure, 0)
      assert.deepEqual(errors, [])
      await until(() => streams.size === 0)
    } finally {
      await controller.close()
    }
  })

  it('surfaces authentication failures without returning credentials', async () => {
    const controller = new AndroidController({ ...endpoint, token: 'wrong-secret' })
    try {
      const error = await new Promise<Error>((resolve) => {
        controller.start(() => assert.fail('Unauthenticated frame'), resolve)
      })
      assert.match(error.message, /authentication/)
      assert.equal(error.message.includes('wrong-secret'), false)
    } finally {
      await controller.close()
    }
  })

  it('enforces connection ownership, prevents duplicate tabs and permits reconnect after cleanup', async () => {
    const service = new AndroidDesktopService(async () => [endpoint])
    const events: unknown[] = []
    const owner: SimulatorDesktopOwner = {
      id: 1,
      isDestroyed: () => false,
      send: (_channel, value) => {
        events.push(value)
      },
    }
    try {
      const connection = await service.open(device.udid, owner)
      assert.throws(() => {
        service.start(connection.id, 2)
      }, /not found/)
      await assert.rejects(() => service.open(device.udid, owner), /already open/)
      service.start(connection.id, owner.id)
      await until(() => events.length >= 2)
      const initialInputs = inputs.length
      await service.sendInput(connection.id, owner.id, {
        type: 'touch',
        phase: 'down',
        x: 0,
        y: 0.5,
      })
      const moves = Array.from({ length: 100 }, (_, index) =>
        service.sendInput(connection.id, owner.id, {
          type: 'touch',
          phase: 'move',
          x: index / 99,
          y: 0.5,
        }),
      )
      await Promise.all([
        ...moves,
        service.sendInput(connection.id, owner.id, { type: 'touch', phase: 'up', x: 1, y: 0.5 }),
      ])
      await until(() => inputs.length >= initialInputs + 3)
      const touches = z.object({
        touches: z.array(z.object({ x: z.number(), pressure: z.number() })),
      })
      assert.deepEqual(
        inputs.slice(initialInputs).map((entry) => touches.parse(entry.value).touches[0]),
        [
          { x: 0, pressure: 1024 },
          { x: 199, pressure: 1024 },
          { x: 199, pressure: 0 },
        ],
      )
      await assert.rejects(() => service.close(connection.id, 2), /not found/)
      await service.closeOwner(owner.id)
      assert.equal(service.hasConnection(connection.id), false)
      const next = await service.open(device.udid, owner)
      assert.notEqual(next.id, connection.id)
    } finally {
      await service.closeAll()
    }
  })
})
