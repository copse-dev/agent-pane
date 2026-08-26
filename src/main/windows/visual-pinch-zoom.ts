// Chromium visual scale bounds: 1 is actual size. A fixed full-window shell has
// no document outside that boundary, so zooming below 1 exposes blank compositor space.
const MIN_VISUAL_ZOOM_SCALE = 1
const MAX_VISUAL_ZOOM_SCALE = 3

interface VisualZoomContents {
  on(event: 'did-finish-load', listener: () => void): unknown
  setVisualZoomLevelLimits(minimumLevel: number, maximumLevel: number): Promise<void>
}

function applyVisualPinchZoom(contents: VisualZoomContents): void {
  void contents.setVisualZoomLevelLimits(MIN_VISUAL_ZOOM_SCALE, MAX_VISUAL_ZOOM_SCALE)
}

/** Keep Chromium's transient, browser-style pinch zoom enabled across reloads. */
export function attachVisualPinchZoom(contents: VisualZoomContents): void {
  contents.on('did-finish-load', () => {
    applyVisualPinchZoom(contents)
  })
}
