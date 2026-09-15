import {
  Client,
  credentials,
  Metadata,
  status,
  type ClientWritableStream,
  type ClientReadableStream,
} from '@grpc/grpc-js'
import { Root } from 'protobufjs/light'
import { z } from 'zod'
import type { SimulatorDesktopInput } from '@shared/types/simulator-desktop.ts'
import type { AndroidEndpoint } from './android-discovery.ts'

// Wire-compatible subset of android.emulation.control.EmulatorController.
// Field numbers: Android SDK emulator/lib/emulator_controller.proto (33.1.24).
// https://android.googlesource.com/platform/tools/base/+/mirror-goog-studio-main/emulator/proto/emulator_controller.proto
const protocol = Root.fromJSON({
  nested: {
    InputEvent: {
      fields: {
        keyEvent: { type: 'KeyboardEvent', id: 1 },
        touchEvent: { type: 'TouchEvent', id: 2 },
      },
    },
    Rotation: { fields: { rotation: { type: 'uint32', id: 1 } } },
    ImageFormat: {
      fields: {
        format: { type: 'uint32', id: 1 },
        rotation: { type: 'Rotation', id: 2 },
        width: { type: 'uint32', id: 3 },
        height: { type: 'uint32', id: 4 },
      },
    },
    Image: { fields: { format: { type: 'ImageFormat', id: 1 }, image: { type: 'bytes', id: 4 } } },
    Touch: {
      fields: {
        x: { type: 'int32', id: 1 },
        y: { type: 'int32', id: 2 },
        identifier: { type: 'int32', id: 3 },
        pressure: { type: 'int32', id: 4 },
      },
    },
    TouchEvent: { fields: { touches: { rule: 'repeated', type: 'Touch', id: 1 } } },
    KeyboardEvent: {
      fields: {
        codeType: { type: 'int32', id: 1 },
        eventType: { type: 'int32', id: 2 },
        keyCode: { type: 'int32', id: 3 },
        key: { type: 'string', id: 4 },
      },
    },
  },
})
const imageSchema = z.object({
  format: z.object({
    format: z.literal(0),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    rotation: z.object({ rotation: z.number().int().min(0).max(3) }).nullable(),
  }),
  image: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.length >= 24 && bytes.length <= 20 * 1024 * 1024),
})
export type AndroidFrame = { bytes: Uint8Array; width: number; height: number; rotation: number }
const SERVICE = '/android.emulation.control.EmulatorController/'

function encode(type: string, value: Record<string, unknown>): Buffer {
  const message = protocol.lookupType(type)
  const error = message.verify(value)
  if (error) throw new Error(`Invalid emulator request: ${error}`)
  return Buffer.from(message.encode(message.create(value)).finish())
}

function decodeFrame(bytes: Buffer): AndroidFrame {
  const type = protocol.lookupType('Image')
  const frame = imageSchema.parse(type.toObject(type.decode(bytes), { defaults: true }))
  const png = Buffer.from(frame.image)
  if (
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    png.readUInt32BE(16) !== frame.format.width ||
    png.readUInt32BE(20) !== frame.format.height
  ) {
    throw new Error('Invalid Android display frame')
  }
  return {
    bytes: frame.image,
    width: frame.format.width,
    height: frame.format.height,
    rotation: frame.format.rotation?.rotation ?? 0,
  }
}

function connectionError(error: unknown): Error {
  const code = z.object({ code: z.enum(status) }).safeParse(error)
  if (code.success && code.data.code === status.UNAUTHENTICATED) {
    return new Error('Android emulator authentication failed. Refresh devices and reconnect.')
  }
  if (code.success && code.data.code === status.DEADLINE_EXCEEDED) {
    return new Error('Android emulator did not respond in time.')
  }
  return new Error(
    'Android emulator connection ended. Check that the emulator is running, then reconnect.',
  )
}

function touchPoint(frame: AndroidFrame, x: number, y: number): { x: number; y: number } {
  // Screenshots are rotated; the emulator's touch digitizer stays in its native
  // orientation. Undo display rotation before mapping normalized coordinates.
  switch (frame.rotation) {
    case 1:
      return { x: Math.round((1 - y) * (frame.height - 1)), y: Math.round(x * (frame.width - 1)) }
    case 2:
      return {
        x: Math.round((1 - x) * (frame.width - 1)),
        y: Math.round((1 - y) * (frame.height - 1)),
      }
    case 3:
      return { x: Math.round(y * (frame.height - 1)), y: Math.round((1 - x) * (frame.width - 1)) }
    default:
      return { x: Math.round(x * (frame.width - 1)), y: Math.round(y * (frame.height - 1)) }
  }
}

export class AndroidController {
  private readonly client: Client
  private readonly metadata = new Metadata()
  private stream: ClientReadableStream<AndroidFrame> | null = null
  private dimensions: AndroidFrame | null = null
  private touch: { x: number; y: number } | null = null
  private readonly modifiers = new Set<number>()
  private closing = false
  private inputStream: ClientWritableStream<Record<string, unknown>> | null = null
  private inputFinished: Promise<void> = Promise.resolve()
  private onFailure: (error: Error) => void = () => {}

  constructor(endpoint: AndroidEndpoint) {
    if (!endpoint.token)
      throw new Error(
        endpoint.device.unavailableReason ?? 'Android emulator authentication is required',
      )
    this.client = new Client(`127.0.0.1:${String(endpoint.port)}`, credentials.createInsecure(), {
      'grpc.max_receive_message_length': 20 * 1024 * 1024,
      'grpc.enable_retries': 0,
      'grpc.enable_http_proxy': 0,
    })
    this.metadata.set('authorization', `Bearer ${endpoint.token}`)
  }

  start(onFrame: (frame: AndroidFrame) => void, onError: (error: Error) => void): void {
    if (this.stream || this.closing) return
    this.onFailure = onError
    // Native dimensions keep touch coordinates correct after display rotation.
    const stream = this.client.makeServerStreamRequest(
      SERVICE + 'streamScreenshot',
      (value: Record<string, unknown>) => encode('ImageFormat', value),
      decodeFrame,
      { format: 0 },
      this.metadata,
    )
    this.stream = stream
    stream.on('data', (frame: AndroidFrame) => {
      if (this.closing) return
      this.dimensions = frame
      onFrame(frame)
    })
    stream.on('error', (error: unknown) => {
      if (!this.closing) onError(connectionError(error))
    })
    stream.on('end', () => {
      if (!this.closing) onError(connectionError(null))
    })
  }

  private getInputStream(): ClientWritableStream<Record<string, unknown>> {
    if (this.inputStream) return this.inputStream
    let finish = (): void => {}
    this.inputFinished = new Promise((resolve) => {
      finish = resolve
    })
    const stream = this.client.makeClientStreamRequest(
      SERVICE + 'streamInputEvent',
      (request: Record<string, unknown>) => encode('InputEvent', request),
      () => undefined,
      this.metadata,
      (error) => {
        finish()
        if (!this.closing) this.onFailure(connectionError(error))
      },
    )
    stream.on('error', (error: unknown) => {
      finish()
      if (!this.closing) this.onFailure(connectionError(error))
    })
    this.inputStream = stream
    return stream
  }

  private call(
    type: 'TouchEvent' | 'KeyboardEvent',
    value: Record<string, unknown>,
    releasing = false,
  ): Promise<void> {
    if (this.closing && !releasing)
      return Promise.reject(new Error('Android connection is closing'))
    const stream = this.getInputStream()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          reject(new Error('Android input stream timed out'))
        },
        releasing ? 500 : 2000,
      )
      stream.write(
        type === 'TouchEvent' ? { touchEvent: value } : { keyEvent: value },
        (error: Error | null | undefined) => {
          clearTimeout(timer)
          if (error) reject(connectionError(error))
          // Emulator 33 schedules each event on its UI looper. Give that looper
          // a frame between writes; bursts can otherwise reorder equal-time
          // callbacks even though gRPC delivered them in order.
          else if (releasing) resolve()
          else setTimeout(resolve, 16)
        },
      )
    })
  }

  async input(input: SimulatorDesktopInput): Promise<void> {
    if (!this.dimensions || this.closing)
      throw new Error('Wait for the Android display before controlling it')
    if (input.type === 'touch') {
      const point = touchPoint(this.dimensions, input.x, input.y)
      // Track before awaiting so disconnect always releases potentially delivered input.
      this.touch = point
      await this.call('TouchEvent', {
        touches: [{ ...point, identifier: 0, pressure: input.phase === 'up' ? 0 : 1024 }],
      })
      if (input.phase === 'up') this.touch = null
    } else if (input.type === 'button-tap') {
      const keys = {
        home: 'GoHome',
        back: 'GoBack',
        overview: 'AppSwitch',
        lock: 'Power',
        side: 'Power',
        siri: '',
      }
      const key = keys[input.name]
      if (!key) throw new Error('This button is not supported by Android')
      await this.call('KeyboardEvent', { key, eventType: 2 })
    } else {
      try {
        for (const modifier of input.modifiers ?? []) {
          this.modifiers.add(modifier)
          await this.call('KeyboardEvent', {
            codeType: 0,
            keyCode: 0x70000 | modifier,
            eventType: 0,
          })
        }
        await this.call('KeyboardEvent', {
          codeType: 0,
          keyCode: 0x70000 | input.usage,
          eventType: 2,
        })
      } finally {
        for (const modifier of this.modifiers) {
          await this.call('KeyboardEvent', {
            codeType: 0,
            keyCode: 0x70000 | modifier,
            eventType: 1,
          })
          this.modifiers.delete(modifier)
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.stream?.cancel()
    const releases: Promise<void>[] = []
    if (this.touch)
      releases.push(
        this.call('TouchEvent', { touches: [{ ...this.touch, identifier: 0, pressure: 0 }] }, true),
      )
    for (const modifier of this.modifiers)
      releases.push(
        this.call(
          'KeyboardEvent',
          { codeType: 0, keyCode: 0x70000 | modifier, eventType: 1 },
          true,
        ),
      )
    await Promise.allSettled(releases)
    if (this.inputStream) {
      this.inputStream.end()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500)
        void this.inputFinished.then(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    this.client.close()
  }
}

export const androidControllerInternals = { protocol, encode, decodeFrame }
