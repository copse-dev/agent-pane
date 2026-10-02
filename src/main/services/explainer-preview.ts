/** Desktop hosts install their renderer; importing the agent path stays host-free. */
type PreviewCapture = (html: string, signal?: AbortSignal) => Promise<string[]>
let capture: PreviewCapture | undefined

export function setExplainerPreviewCapture(next: PreviewCapture): () => void {
  const previous = capture
  capture = next
  return () => {
    capture = previous
  }
}

export async function captureExplainerPreview(
  html: string,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!capture) throw new Error('Explainer previews require the Copse desktop renderer.')
  return capture(html, signal)
}
