import type { Readable } from 'node:stream'

/** Bridge Node streams to the SDK's DOM Web Stream type without cross-lib casts. */
export function nodeReadableStream(source: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      source.on('data', (chunk: unknown) => {
        if (typeof chunk === 'string') controller.enqueue(Buffer.from(chunk))
        else if (chunk instanceof Uint8Array) controller.enqueue(chunk)
        else controller.error(new TypeError('ACP stream emitted a non-byte chunk'))
      })
      source.once('end', () => {
        controller.close()
      })
      source.once('error', (error: unknown) => {
        controller.error(error)
      })
    },
    cancel(): void {
      source.destroy()
    },
  })
}
