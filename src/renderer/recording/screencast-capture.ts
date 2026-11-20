import type { RecordingCapture } from './surface-recorder.ts'

/** The Browser-pane recording calls the preload exposes (absent on demo/site hosts). */
export interface ScreencastApi {
  startRecording(webContentsId: number): Promise<void>
  stopRecording(webContentsId: number): Promise<void>
  onRecordingFrame(handler: (webContentsId: number, jpeg: Uint8Array) => void): () => void
  onRecordingEnded(handler: (webContentsId: number, reason: string) => void): () => void
}

/** A loaded tab paints its first screencast frame almost at once; silence means it is not painting. */
const FIRST_FRAME_TIMEOUT_MS = 3_000

/**
 * Draw a tab's screencast frames into a detached canvas for the recorder.
 *
 * The canvas follows the frame size; the recorder copies it into a frame of
 * fixed size, so a resized pane is letterboxed rather than changing the
 * video's resolution. Frames decode asynchronously; a frame that finishes
 * decoding after a newer one has been drawn is dropped rather than painted
 * backwards.
 */
export async function openScreencastCapture(
  api: ScreencastApi,
  webContentsId: number,
  onEnded: () => void,
): Promise<RecordingCapture> {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not create a canvas to record into.')

  let requested = 0
  let drawn = 0
  let disposed = false
  let resolveFirstFrame: (() => void) | null = null
  const firstFrame = new Promise<void>((resolve) => {
    resolveFirstFrame = resolve
  })

  const stopFrames = api.onRecordingFrame((id, jpeg) => {
    if (id !== webContentsId || disposed) return
    const sequence = ++requested
    void createImageBitmap(new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' })).then(
      (bitmap) => {
        if (disposed || sequence < drawn) {
          bitmap.close()
          return
        }
        drawn = sequence
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width
          canvas.height = bitmap.height
        }
        context.drawImage(bitmap, 0, 0)
        bitmap.close()
        resolveFirstFrame?.()
      },
      () => {
        // A frame that fails to decode is skipped; the next paint replaces it.
      },
    )
  })
  const stopEnded = api.onRecordingEnded((id) => {
    if (id === webContentsId && !disposed) onEnded()
  })

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    stopFrames()
    stopEnded()
    void api.stopRecording(webContentsId).catch(() => {})
  }

  try {
    await api.startRecording(webContentsId)
    let timer = 0
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = window.setTimeout(() => {
        resolve('timeout')
      }, FIRST_FRAME_TIMEOUT_MS)
    })
    const outcome = await Promise.race([firstFrame, timedOut])
    window.clearTimeout(timer)
    if (outcome === 'timeout') {
      throw new Error('The tab is not painting. Show the Browser pane and try again.')
    }
  } catch (error) {
    dispose()
    throw error
  }
  return { canvas, dispose }
}
