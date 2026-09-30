import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PREVIEW_ZOOM_FACTOR, capturePreviewDataUrl } from './session-manager.ts'

interface FakeImage {
  isEmpty(): boolean
  getSize(): { width: number }
  resize(options: { width: number; quality: 'best' }): FakeImage
  toDataURL(): string
}

function image(width: number, empty = false): FakeImage {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width }),
    resize: ({ width: next }) => image(next),
    toDataURL: () => `data:image/png;base64,${String(width)}`,
  }
}

interface FakeTab {
  events: string[]
  zoom(): number
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  executeJavaScript(): Promise<unknown>
  capturePage(): Promise<FakeImage>
}

/** A tab whose capture records the zoom it was taken at. */
function contents(capture: () => Promise<FakeImage>, initialZoom = 1): FakeTab {
  const events: string[] = []
  let zoom = initialZoom
  return {
    events,
    zoom: () => zoom,
    getZoomFactor: () => zoom,
    setZoomFactor: (factor): void => {
      zoom = factor
      events.push(`zoom ${String(factor)}`)
    },
    executeJavaScript: (): Promise<unknown> => {
      events.push('frame')
      return Promise.resolve(undefined)
    },
    capturePage: (): Promise<FakeImage> => {
      events.push(`capture at ${String(zoom)}`)
      return capture()
    },
  }
}

describe('capturePreviewDataUrl', () => {
  it('lays the page out at the preview zoom for the capture, then restores the tab', async () => {
    // A 1280px desktop layout shrunk into a ~380px transcript card left body
    // text under a third of its size (#3240). The preview reflows narrower
    // instead, and the agent's own tab goes back to its desktop viewport.
    const tab = contents(() => Promise.resolve(image(1280)), 1)

    const preview = await capturePreviewDataUrl(tab)

    assert.equal(preview, 'data:image/png;base64,1280')
    assert.deepEqual(tab.events, [
      `zoom ${String(PREVIEW_ZOOM_FACTOR)}`,
      'frame',
      `capture at ${String(PREVIEW_ZOOM_FACTOR)}`,
      'zoom 1',
    ])
    assert.equal(tab.zoom(), 1)
  })

  it('restores a non-default zoom rather than resetting it', async () => {
    const tab = contents(() => Promise.resolve(image(1280)), 1.25)
    await capturePreviewDataUrl(tab)
    assert.equal(tab.zoom(), 1.25)
  })

  it('downsizes a high-density bitmap to the preview width', async () => {
    // A 2× display captures the 1280px tab as 2560 device pixels.
    const tab = contents(() => Promise.resolve(image(2560)))
    assert.equal(await capturePreviewDataUrl(tab, 1280), 'data:image/png;base64,1280')
  })

  it('returns null and restores the zoom when the capture fails or is empty', async () => {
    const failing = contents(() => Promise.reject(new Error('capture failed')))
    assert.equal(await capturePreviewDataUrl(failing), null)
    assert.equal(failing.zoom(), 1)

    const empty = contents(() => Promise.resolve(image(0, true)))
    assert.equal(await capturePreviewDataUrl(empty), null)
    assert.equal(empty.zoom(), 1)
  })

  it('returns null when the tab is destroyed before its zoom can be restored', async () => {
    const tab = contents(() => Promise.reject(new Error('Object has been destroyed')))
    let calls = 0
    tab.setZoomFactor = (): void => {
      calls += 1
      if (calls > 1) throw new Error('Object has been destroyed')
    }
    assert.equal(await capturePreviewDataUrl(tab), null)
  })
})
