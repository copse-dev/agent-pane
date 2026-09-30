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
  scripts: string[]
  executeJavaScript(code: string): Promise<unknown>
  capturePage(): Promise<FakeImage>
}

/** A tab whose capture records the zoom it was taken at. */
function contents(capture: () => Promise<FakeImage>, initialZoom = 1): FakeTab {
  const events: string[] = []
  const scripts: string[] = []
  let zoom = initialZoom
  return {
    events,
    scripts,
    zoom: () => zoom,
    getZoomFactor: () => zoom,
    setZoomFactor: (factor): void => {
      zoom = factor
      events.push(`zoom ${String(factor)}`)
    },
    executeJavaScript: (code): Promise<unknown> => {
      scripts.push(code)
      events.push('layout')
      return Promise.resolve(640)
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
      'layout',
      `capture at ${String(PREVIEW_ZOOM_FACTOR)}`,
      `capture at ${String(PREVIEW_ZOOM_FACTOR)}`,
      'zoom 1',
    ])
    assert.equal(tab.zoom(), 1)
  })

  it('keeps the second capture, not the frame painted before the zoom', async () => {
    // A hidden tab paints only while capturePage holds it visible, so the first
    // capture after the zoom can still hold the 1280px desktop layout.
    const frames = [image(1000), image(1280)]
    const tab = contents(() => Promise.resolve(frames.shift() ?? image(0, true)))

    assert.equal(await capturePreviewDataUrl(tab), 'data:image/png;base64,1280')
    assert.equal(frames.length, 0)
  })

  it('never waits for an animation frame before capturing', async () => {
    // Hidden agent tabs schedule no frames until capturePage makes them paint,
    // so a requestAnimationFrame wait never resolved and hung every canvas
    // tool call that awaits its preview.
    const tab = contents(() => Promise.resolve(image(1280)))
    await capturePreviewDataUrl(tab)
    assert.equal(tab.scripts.length, 1)
    for (const script of tab.scripts) assert.doesNotMatch(script, /requestAnimationFrame/)
  })

  it('takes overlapping captures of one tab in turn and leaves it at its own zoom', async () => {
    // Two quick re-renders of the same artefact can capture its tab at once.
    // Each capture snapshots the zoom it restores, so interleaving them left the
    // tab stuck at the preview zoom and captured one render at the desktop zoom.
    const tab = contents(() => Promise.resolve(image(1280)), 1)

    await Promise.all([capturePreviewDataUrl(tab), capturePreviewDataUrl(tab)])

    const captureZoom = `capture at ${String(PREVIEW_ZOOM_FACTOR)}`
    assert.deepEqual(
      tab.events.filter((event) => event.startsWith('capture')),
      [captureZoom, captureZoom, captureZoom, captureZoom],
    )
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
