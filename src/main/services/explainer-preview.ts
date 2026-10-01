/** Desktop hosts install their renderer; importing the agent path stays host-free. */
type PreviewCapture = (html: string) => Promise<string[]>
let capture: PreviewCapture | undefined

export function setExplainerPreviewCapture(next: PreviewCapture): void {
  capture = next
}

export async function captureExplainerPreview(html: string): Promise<string[]> {
  if (!capture) throw new Error('Explainer previews require the Copse desktop renderer.')
  return capture(html)
}
