/** A recorded video's frame size: the source's, rounded down to even (VP8/VP9 encode 4:2:0). */
export function evenFrameSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(2, width - (width % 2)),
    height: Math.max(2, height - (height % 2)),
  }
}

/** Where to draw a source of one size inside a frame of another: scaled to fit, centred. */
export function fitRect(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0, width, height }
  const scale = Math.min(width / sourceWidth, height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  return {
    x: (width - drawWidth) / 2,
    y: (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  }
}

/**
 * Draw `source` into a fixed-size frame. A recording keeps one resolution from
 * start to finish — a WebM whose size changes mid-stream is not reliably
 * decodable — so a source that is resized (a pane, a remote display) is
 * letterboxed instead.
 */
export function drawFitted(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource & { width: number; height: number },
  width: number,
  height: number,
): void {
  if (source.width === width && source.height === height) {
    context.drawImage(source, 0, 0)
    return
  }
  const rect = fitRect(source.width, source.height, width, height)
  context.fillStyle = '#000'
  context.fillRect(0, 0, width, height)
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height)
}
