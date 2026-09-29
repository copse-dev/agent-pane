import { Writable, type Readable } from 'node:stream'

/** Bridge a Node readable to the SDK's DOM Web Stream type without cross-lib casts. */
export function nodeReadableStream(source: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      // `end`, `error` and a bare `close` (a destroyed stream never emits `end`)
      // all finish the stream; whichever comes first wins so a later event can't
      // touch a controller that already settled.
      let settled = false
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        finish()
      }
      source.on('data', (chunk: unknown) => {
        if (settled) return
        if (typeof chunk === 'string') controller.enqueue(Buffer.from(chunk))
        else if (chunk instanceof Uint8Array) controller.enqueue(chunk)
        else
          settle(() => {
            controller.error(new TypeError('ACP stream emitted a non-byte chunk'))
          })
      })
      source.once('end', () => {
        settle(() => {
          controller.close()
        })
      })
      source.once('error', (error: unknown) => {
        settle(() => {
          controller.error(error)
        })
      })
      source.once('close', () => {
        settle(() => {
          controller.error(new Error('ACP stream closed before it ended'))
        })
      })
    },
    cancel(): void {
      source.destroy()
    },
  })
}

/** Bridge a Node writable to the SDK's DOM Web Stream type without cross-lib casts. */
export function nodeWritableStream(source: Writable): WritableStream<Uint8Array> {
  return Writable.toWeb(source)
}
